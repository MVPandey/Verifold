"""The `verifold` command."""

import argparse
import asyncio
import os
import signal
import sys
import webbrowser
from collections.abc import Callable, Coroutine, Mapping, Sequence
from contextlib import suppress
from functools import partial
from importlib.metadata import version
from pathlib import Path
from types import MappingProxyType
from typing import Literal

from pydantic import ValidationError

from verifold import DISTRIBUTION
from verifold.app import SERVER_FILE, ServeHooks, ServeOptions, serve, stop_lab
from verifold.harnesses.catalog import CATALOG, HarnessEntry, available, catalog_with
from verifold.protocol.agents import MAX_AGENTS, AgentChoice
from verifold.protocol.app import StartRequest
from verifold.protocol.settings import SettingsLevel, SetupDefaults
from verifold.runner.errors import NoAgentFolder, NoFileManager, RunnerError
from verifold.runner.folders import LAB_FOLDER, agents_folder, open_folder, real_folder
from verifold.runner.jobs import Job, Sweep
from verifold.server.errors import ServerError, SetupRejected
from verifold.store.errors import SettingsInvalid, StoreError
from verifold.store.server_file import mark_opens, named_server, running_server
from verifold.store.settings_file import SettingsValues, read_settings_file, settings_of, settings_path

STOP_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
"""Ctrl+C, a plain `kill`, and a closed terminal. Each one stops the lab in the same way."""

OPEN_SIGNAL = signal.SIGUSR1
"""What `verifold open` sends to the server. The server then prints the lab's link and opens it in the browser."""

_REPORTED = (RunnerError, StoreError, ServerError)


def main(argv: Sequence[str] | None = None) -> None:
    """
    Parse the arguments and run the command.

    `verifold` serves the folder: the setup screen, or the lab that the folder holds. `verifold run` starts a lab on a
    question from the command line. `verifold stop` stops the folder's lab from another terminal. `verifold folder`
    shows where the lab's agents work.

    Args:
        argv: The arguments after the program name. `None` reads them from `sys.argv`.

    """
    args = _parser().parse_args(argv)
    if args.command == 'stop':
        _stop()
        return
    if args.command == 'open':
        _open()
        return
    if args.command == 'folder':
        _folder(args.agent, open_it=not args.no_browser)
        return
    try:
        start = _start(args) if args.command == 'run' else None
    except (ValidationError, SettingsInvalid, SetupRejected) as error:
        sys.exit(f'verifold: {error}')
    _say(f'Serving Verifold for {Path.cwd()}. Its record is .verifold/record.jsonl. Press Ctrl+C to stop.')
    try:
        links: list[str] = []
        announce = partial(_announce, links, open_browser=not args.no_browser, plan=_plan(start) if start else None)
        options = ServeOptions(desktop=not args.no_browser)
        serving = serve(Path.cwd(), start, options=options, hooks=ServeHooks(ready=announce, swept=_report))
        asyncio.run(_until_stopped(serving, partial(_open_again, links, open_browser=not args.no_browser)))
    except KeyboardInterrupt:
        pass  # Ctrl+C came before the event loop took over the signal.
    except (BaseExceptionGroup, *_REPORTED) as error:
        sys.exit(f'verifold: {_reported(error)}')
    _say('Stopped. Run `verifold` here again to come back.')


def _reported(error: BaseException) -> BaseException:
    # Errors from starting a lab come out of the server's task group, wrapped in a group.
    if isinstance(error, BaseExceptionGroup):
        known = error.subgroup(_REPORTED)
        if known is None:
            raise error
        return _reported(known.exceptions[0])
    return error


def _start(args: argparse.Namespace) -> StartRequest:
    """
    Return what `verifold run` starts: the command line's choices, and the saved choices for new labs for the rest.

    `verifold run` starts at once, without showing the saved choices, and a project's file can come from someone else.
    So a project's file can make the lab stricter, not looser: it can turn auto mode off, shorten the time limit,
    lower the budget and the disk limit, and each of its seats gives only a harness, a count, a model, and an effort. Its modes, roles, families,
    coordinator, powers, and on-call marks are not used, and neither is its number of reviewer seats, and the command says so.
    Under `--ask-me`, no saved agent gets a mode.

    Raises:
        SetupRejected: No harness that Verifold knows is on this computer.

    """
    project = Path.cwd()
    values = {level: read_settings_file(settings_path(level, project), level)[0] for level in SettingsLevel}
    files = settings_of(values)
    everywhere, here = settings_of({SettingsLevel.ALL: values[SettingsLevel.ALL]}).setup, files.setup
    # In the home folder, the project's file is the person's own file for all projects.
    own = settings_path(SettingsLevel.PROJECT, project).resolve() == settings_path(SettingsLevel.ALL, project).resolve()
    if args.agent:
        agents = tuple(_agent(value) for value in args.agent)
    else:
        saved = values[SettingsLevel.PROJECT].get('setup')
        from_project = not own and isinstance(saved, dict) and 'agents' in saved
        agents = _saved_agents(here, catalog_with(files.harnesses), drop_modes=args.ask_me, from_project=from_project)
    shorter = _lower(everywhere.minutes, here.minutes)
    tokens = _lower(everywhere.budget_tokens, here.budget_tokens)
    dollars = _lower(everywhere.budget_dollars, here.budget_dollars)
    return StartRequest(
        question=args.question,
        agents=agents,
        auto_mode=everywhere.auto_mode and here.auto_mode and not args.ask_me,
        minutes=shorter if args.minutes is None else args.minutes,
        allow=tuple(args.allow or ()),
        reviewer_seats=_reviewer_seats(values, own=own),
        reveal_minutes=_own_minutes(
            values, 'votes', 'reveal_minutes', 'the minutes that a new post hides its votes', own=own
        ),
        lease_minutes=_own_minutes(values, 'reruns', 'lease_minutes', 'the minutes that a take holds a rerun', own=own),
        budget_tokens=tokens if args.budget_tokens is None else args.budget_tokens,
        budget_dollars=dollars if args.budget_dollars is None else args.budget_dollars,
        disk_gb=_disk_gb(values, own=own),
        # A deliverable is the person's own sentence for this lab, as the question is. No settings file holds one.
        deliverables=tuple(args.deliverable or ()),
    )


def _lower[T: (int, float)](*values: T | None) -> T | None:
    # The lowest of the values that are set: the stricter time limit or budget. `None` means none is set.
    return min((value for value in values if value is not None), default=None)


def _disk_gb(values: Mapping[SettingsLevel, SettingsValues], *, own: bool) -> int | None:
    """
    Return the disk limit that `verifold run` starts with, or `None` for what the files add up to.

    A project's file can lower the disk limit and cannot raise it: zero means no limit, so it counts as the
    highest. A higher limit from a project's file is not used, and the command says so.
    """
    project = values[SettingsLevel.PROJECT].get('disk')
    if own or not (isinstance(project, dict) and 'limit_gb' in project):
        return None
    mine = settings_of({SettingsLevel.ALL: values[SettingsLevel.ALL]}).disk.limit_gb
    theirs = settings_of(values).disk.limit_gb
    if not mine or (theirs and theirs <= mine):
        return None
    _say(
        "Did not use the disk limit from this project's settings file, because it is higher than yours for all "
        'projects: `verifold run` takes only a lower one from a project.'
    )
    return mine


def _reviewer_seats(values: Mapping[SettingsLevel, SettingsValues], *, own: bool) -> int | Literal['size'] | None:
    """
    Return the number of reviewer seats that `verifold run` starts with, or `None` for what the files add up to.

    `verifold run` does not use the number in a project's file, and says so. A higher number lets more agents
    check, and zero turns the reviewer seats off, so no number from somebody else's file is the stricter one. The
    lab then has the person's own number, or follows its size.
    """
    project = values[SettingsLevel.PROJECT].get('reviewers')
    if own or not (isinstance(project, dict) and 'seats' in project):
        return None
    _say(
        "Did not use the number of reviewer seats from this project's settings file: `verifold run` takes it only "
        'from your settings for all projects.'
    )
    mine = settings_of({SettingsLevel.ALL: values[SettingsLevel.ALL]}).reviewers.seats
    return 'size' if mine is None else mine


def _own_minutes(
    values: Mapping[SettingsLevel, SettingsValues], section: str, name: str, what: str, *, own: bool
) -> int | None:
    """
    Return the minutes of `section.name` that `verifold run` starts with, or `None` for what the files add up to.

    `verifold run` does not use the number in a project's file, and says so, as for the reviewer seats. Zero turns
    the sealed votes or the leases off, and a day lets a vote stay hidden or a first taker hold a rerun for a day,
    so no number from somebody else's file is the stricter one. The lab then has the person's own number, or the
    default.
    """
    project = values[SettingsLevel.PROJECT].get(section)
    if own or not (isinstance(project, dict) and name in project):
        return None
    _say(
        f"Did not use {what} from this project's settings file: `verifold run` takes it only from your settings for all projects."
    )
    mine = settings_of({SettingsLevel.ALL: values[SettingsLevel.ALL]})
    return mine.votes.reveal_minutes if section == 'votes' else mine.reruns.lease_minutes


def _saved_agents(
    defaults: SetupDefaults, catalog: Mapping[str, HarnessEntry], *, drop_modes: bool, from_project: bool
) -> tuple[AgentChoice, ...]:
    # A seat from a project's file gives only its harness, count, model, and effort. The rest could loosen the lab
    # or speak as the person: a family makes a rerun count as independent, a role reaches the agents as the
    # person's word, a coordinator reads as the person's choice, its powers would hand the person's moves to an
    # agent, and a lab of on-call seats starts nothing.
    dropped = PROJECT_DROPS if from_project else {'mode': None} if drop_modes else {}
    unused: set[str] = set()
    kept: list[AgentChoice] = []
    for choice in defaults.agents or ():
        entry = catalog.get(choice.harness)
        if entry is None or not available(entry):
            _say(f'Skipped {choice.harness} from your saved choices for new labs: it is not on this computer.')
            continue
        used = choice.model_copy(update=dropped)
        unused |= {name for name in dropped if getattr(used, name) != getattr(choice, name)}
        kept.append(used)
    if unused and from_project:
        _say(
            f'Did not use {", ".join(name.replace("_", " ") for name in dropped if name in unused)} from this '
            "project's saved choices "
            'for new labs: `verifold run` takes only the harness, count, model, and effort of a seat from a '
            "project's file."
        )
    if kept:
        return tuple(kept)
    found = tuple(AgentChoice(harness=name) for name, entry in catalog.items() if available(entry))[:MAX_AGENTS]
    if not found:
        raise SetupRejected(
            f'No harness that Verifold knows is on this computer: {", ".join(catalog)}. Install one, or add one to '
            '~/.verifold/settings.json.'
        )
    return found


PROJECT_DROPS: Mapping[str, str | bool | tuple[()] | None] = MappingProxyType(
    {'mode': None, 'role': '', 'family': None, 'coordinator': False, 'on_call': False, 'powers': ()}
)
"""What `verifold run` sets back in a seat that comes from a project's settings file."""

NOTHING_STARTS = 'Every seat is on call, so no agent starts until a post names one'
"""What `verifold run` adds when the lab that it starts has only on-call seats."""


def _plan(start: StartRequest) -> str:
    # What `verifold run` starts, in words, so that the person sees the saved choices that it used.
    agents = ', '.join(_agent_words(choice) for choice in start.agents)
    time = f'a time limit of {start.minutes} min' if start.minutes else 'no time limit'
    waits = f'. {NOTHING_STARTS}' if all(choice.on_call for choice in start.agents) else ''
    wanted = len(start.deliverables)
    deliverables = f'; {wanted} {"deliverable" if wanted == 1 else "deliverables"}' if wanted else ''
    spend = (
        *((f'{start.budget_tokens:,} tokens',) if start.budget_tokens else ()),
        *((f'{start.budget_dollars:g} dollars',) if start.budget_dollars else ()),
    )
    budget = f'; a budget of {" and ".join(spend)}' if spend else ''
    return f'{agents}; {"auto mode" if start.auto_mode else "no auto mode"}; {time}{budget}{deliverables}{waits}'


def _agent_words(choice: AgentChoice) -> str:
    details = [
        detail
        for detail in (
            choice.model,
            choice.effort and f'{choice.effort} effort',
            choice.mode and f'{choice.mode} mode',
            choice.family and f'{choice.family} family',
            choice.role and f'role: {choice.role}',
            choice.coordinator and 'coordinator',
            f'powers: {", ".join(choice.powers)}' if choice.powers else None,
            choice.on_call and 'on call',
        )
        if detail
    ]
    agents = f'{choice.count} {choice.harness}'
    return f'{agents} ({", ".join(details)})' if details else agents


async def _until_stopped(serving: Coroutine[None, None, None], reopen: Callable[[], None] | None = None) -> None:
    """
    Serve until one of `STOP_SIGNALS` comes, and return once the agents, their processes, and the server have stopped.

    The harnesses run in their own process groups, so a signal to Verifold's group doesn't reach them. Each signal
    cancels the server instead, and the server stops the harnesses and the processes that they started. A signal that
    this process ignores stays ignored, such as SIGHUP under `nohup`.
    """
    task = asyncio.create_task(serving)
    loop = asyncio.get_running_loop()
    handled = [stop for stop in STOP_SIGNALS if signal.getsignal(stop) is not signal.SIG_IGN]
    for stop in handled:
        loop.add_signal_handler(stop, _stop_once, task)
    if reopen:
        loop.add_signal_handler(OPEN_SIGNAL, reopen)
    try:
        # A cancel is the normal way to stop. It reaches this await after the server has cleaned up.
        with suppress(asyncio.CancelledError):
            await task
    finally:
        for stop in handled:
            loop.remove_signal_handler(stop)
        if reopen:
            loop.remove_signal_handler(OPEN_SIGNAL)


def _stop_once(task: asyncio.Task[None]) -> None:
    # A second Ctrl+C would cut the cleanup short and leave the agents' processes running.
    if not task.cancelling():
        task.cancel()
        _say('Stopping the agents and the processes that they started.')


def _stop() -> None:
    try:
        stopped = stop_lab(Path.cwd())
    except StoreError as error:
        sys.exit(f'verifold: {error}')
    if stopped.server:
        _say(f"Stopped the Verifold server ({stopped.server}) that served this folder's lab.")
    _report(stopped.sweep)
    if not stopped.server and not stopped.sweep.stopped:
        _say("Nothing of this folder's lab was running.")


def _report(sweep: Sweep) -> None:
    earlier = ' from an earlier run' if sweep.earlier_run else ''
    for job in sweep.stopped:
        _say(f'Stopped {_owner(job)} process{earlier}: {job.command} ({job.pid})')
    for job in sweep.paused:
        _say(f'Paused {_owner(job)} process until the lab gets more time: {job.command} ({job.pid})')
    for job in sweep.survived:
        _say(f"Couldn't stop {_owner(job)} process: {job.command} ({job.pid}). Run `kill -9 {job.pid}`.")
    for job in sweep.unmarked:
        _say(f"Left running in {_owner(job)} folder, as it may not be the lab's: {job.command} ({job.pid})")


def _owner(job: Job) -> str:
    return f"{job.agent}'s" if job.agent else "an agent's"


def _say(text: str) -> None:
    # Once the terminal closes, writing to it fails. The lab must still stop.
    with suppress(OSError):
        print(text, flush=True)


def _announce(links: list[str], link: str, *, open_browser: bool, plan: str | None = None) -> None:
    # The plan shows once the server is up, so that it never comes before an error about the folder.
    if plan:
        _say(f'Started a lab with {plan}.')
    _say(f'Open the lab: {link}')
    if open_browser:
        webbrowser.open(link)
    # The link holds the person's token, so it stays in this process. `verifold open` asks this process to open it.
    links.append(link)
    mark_opens(Path.cwd() / LAB_FOLDER / SERVER_FILE)


def _open_again(links: list[str], *, open_browser: bool) -> None:
    # A server that started with --no-browser only prints the link: on a computer without a desktop, a text browser
    # would take the terminal and block the server.
    for link in links[-1:]:
        _say(f'Open the lab: {link}')
        if open_browser:
            webbrowser.open(link)


def _open() -> None:
    """Ask the server of this folder's lab to open the lab in the browser and to print its link."""
    path = Path.cwd() / LAB_FOLDER / SERVER_FILE
    server, named = running_server(path), named_server(path)
    if server is None or named is None:
        sys.exit('verifold: No Verifold server runs for this folder. Run `verifold` here to start it.')
    if not named.opens:
        sys.exit(
            'verifold: This server started with an older Verifold, or it is not ready yet, so it cannot open the lab '
            'again. The link is in the terminal that runs it, on the line "Open the lab".'
        )
    try:
        os.kill(server.pid, OPEN_SIGNAL)
    except OSError as error:
        sys.exit(f"verifold: Can't reach the server ({server.pid}): {error}")
    _say(
        'Asked the server to show the lab again. Its terminal prints the link, and it opens the lab in your browser '
        'unless it started with --no-browser.'
    )


def _folder(agent: str | None, *, open_it: bool) -> None:
    """
    Print the folder where the lab's agents work, or the folder of one agent, and open it in the file manager.

    It reads only the project's folder, so it needs no server. With `--no-browser` it only prints the path.
    """
    every = agents_folder(Path.cwd())
    agents = sorted(entry.name for entry in every.iterdir() if entry.is_dir()) if every.is_dir() else []
    if not agents:
        sys.exit('verifold: No agent has a folder here yet. Run `verifold` here and start a lab first.')
    # The name must be one of the folders, so that no argument leads out of the lab's folder.
    if agent is not None and agent not in agents:
        sys.exit(f'verifold: No agent of this lab has the folder {agent}. The folders: {", ".join(agents)}.')
    try:
        folder = real_folder(Path.cwd(), agent)
    except NoAgentFolder as error:
        sys.exit(f'verifold: {error}')
    _say(str(folder))
    if not open_it:
        return
    try:
        open_folder(folder)
    except NoFileManager as error:
        print(f'verifold: {error} The path is above.', file=sys.stderr)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog='verifold', description='Run your coding agents as a research society.')
    parser.add_argument('--version', action='version', version=f'%(prog)s {version(DISTRIBUTION)}')
    parser.add_argument('--no-browser', action='store_true', help='Print the link to the app, and open no browser.')
    commands = parser.add_subparsers(dest='command')
    run = commands.add_parser('run', help='Start a lab on a question without the setup screen.')
    # SUPPRESS keeps the subcommand from resetting a --no-browser that came before `run`.
    run.add_argument('--no-browser', action='store_true', default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    run.add_argument('question', help='The question of the new lab.')
    run.add_argument(
        '--agent',
        action='append',
        metavar='HARNESS[:MODEL[:EFFORT[:MODE]]][,FACT...]',
        help=f'Add an agent: {", ".join(CATALOG)}, or a harness from your settings, with an optional model, effort, and mode. You can name a harness more than once. After a comma come the facts of the seat, each optional: role=TEXT, family=TEXT, coordinator, on-call. Example: claude-code:opus,role=driver,coordinator. Default: your saved choices for new labs, or one agent of each harness that this computer has.',
    )
    run.add_argument(
        '--minutes',
        type=int,
        help='How long the agents may work. You can give the lab more time from the app. Default: your saved time limit, or none.',
    )
    run.add_argument(
        '--budget-tokens',
        type=int,
        metavar='TOKENS',
        help='The most tokens, input and output together, that the agents may spend. At that budget the agents stop, as at the time limit, until you raise it in the app. Default: your saved budget, or none.',
    )
    run.add_argument(
        '--budget-dollars',
        type=float,
        metavar='DOLLARS',
        help='The most US dollars that the agents may spend, as the harnesses report their cost. A harness that reports no cost adds nothing. Default: your saved budget, or none.',
    )
    run.add_argument(
        '--ask-me',
        action='store_true',
        help="Keep each harness's own default mode. The requests that a harness sends then come to you on the board.",
    )
    run.add_argument(
        '--allow',
        action='append',
        metavar='COMMAND',
        help='Let every agent run commands that start with COMMAND, such as ./gpu, without a question to you. Give it once for each command. You can also give a grant on the board when an agent asks.',
    )
    run.add_argument(
        '--deliverable',
        action='append',
        metavar='SENTENCE',
        help='State something that you want to hold at the end of the lab, as one sentence, such as "A script that runs the best strategy again". Give it once for each deliverable. You can add, change, and remove deliverables in the app.',
    )
    commands.add_parser('open', help="Open this folder's running lab in the browser again, from another terminal.")
    folder = commands.add_parser(
        'folder', help="Print the folder where this folder's agents work, and open it in the file manager."
    )
    folder.add_argument('agent', nargs='?', help="An agent's ID, such as agent-3, for that agent's folder only.")
    commands.add_parser(
        'stop', help="Stop this folder's lab from another terminal: its server, its agents, and their processes."
    )
    return parser


def _agent(value: str) -> AgentChoice:
    # The facts of the seat come after the first comma, so a role holds no comma here.
    seat, *facts = value.split(',')
    harness, _, rest = seat.partition(':')
    model, _, rest = rest.partition(':')
    effort, _, mode = rest.partition(':')
    given: dict[str, str | bool] = {}
    for fact in facts:
        key, _, text = fact.strip().partition('=')
        if key in ('role', 'family') and text.strip():
            given[key] = text.strip()
        elif key in ('coordinator', 'on-call') and not text:
            given[key.replace('-', '_')] = True
        else:
            raise SetupRejected(
                f'--agent {value}: "{fact.strip()}" is not a fact of a seat. Give role=TEXT, family=TEXT, coordinator, '
                'or on-call.'
            )
    return AgentChoice.model_validate(
        {'harness': harness, 'model': model or None, 'effort': effort or None, 'mode': mode or None} | given
    )
