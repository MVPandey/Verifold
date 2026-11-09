"""The `verifold` command."""

import argparse
import asyncio
import signal
import sys
import webbrowser
from collections.abc import Coroutine, Sequence
from contextlib import suppress
from functools import partial
from importlib.metadata import version
from pathlib import Path

from pydantic import ValidationError

from verifold import DISTRIBUTION
from verifold.app import ServeHooks, serve, stop_lab
from verifold.harnesses.catalog import CATALOG
from verifold.protocol.app import AgentChoice, StartRequest
from verifold.runner.errors import RunnerError
from verifold.runner.jobs import Job, Sweep
from verifold.server.errors import ServerError
from verifold.store.errors import SettingsInvalid, StoreError
from verifold.store.settings_file import load_settings

DEFAULT_AGENTS = (AgentChoice(harness='claude-code'), AgentChoice(harness='codex'))
"""One agent of each harness, with the person's own models."""

STOP_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
"""Ctrl+C, a plain `kill`, and a closed terminal. Each one stops the lab in the same way."""

_REPORTED = (RunnerError, StoreError, ServerError)


def main(argv: Sequence[str] | None = None) -> None:
    """
    Parse the arguments and run the command.

    `verifold` serves the folder: the setup screen, or the lab that the folder holds. `verifold run` starts a lab on a
    question from the command line. `verifold stop` stops the folder's lab from another terminal.

    Args:
        argv: The arguments after the program name. `None` reads them from `sys.argv`.

    """
    args = _parser().parse_args(argv)
    if args.command == 'stop':
        _stop()
        return
    try:
        start = _start(args) if args.command == 'run' else None
    except (ValidationError, SettingsInvalid) as error:
        sys.exit(f'verifold: {error}')
    _say(f'Serving Verifold for {Path.cwd()}. Its record is .verifold/record.jsonl. Press Ctrl+C to stop.')
    try:
        announce = partial(_announce, open_browser=not args.no_browser)
        asyncio.run(_until_stopped(serve(Path.cwd(), start, hooks=ServeHooks(ready=announce, swept=_report))))
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
    # The person's saved choices for new labs fill in what the command line leaves out.
    defaults = load_settings(Path.cwd()).setup
    agents = tuple(_agent(value) for value in args.agent) if args.agent else defaults.agents or DEFAULT_AGENTS
    return StartRequest(
        question=args.question,
        agents=agents,
        auto_mode=defaults.auto_mode and not args.ask_me,
        minutes=defaults.minutes if args.minutes is None else args.minutes,
    )


async def _until_stopped(serving: Coroutine[None, None, None]) -> None:
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
    try:
        # A cancel is the normal way to stop. It reaches this await after the server has cleaned up.
        with suppress(asyncio.CancelledError):
            await task
    finally:
        for stop in handled:
            loop.remove_signal_handler(stop)


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


def _announce(link: str, *, open_browser: bool) -> None:
    _say(f'Open the lab: {link}')
    if open_browser:
        webbrowser.open(link)


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
        metavar='HARNESS[:MODEL[:EFFORT[:MODE]]]',
        help=f'Add an agent: {", ".join(CATALOG)}, or a harness from your settings, with an optional model, effort, and mode. Default: your saved choices for new labs, or one of each with your usual settings.',
    )
    run.add_argument(
        '--minutes',
        type=int,
        help='How long the agents may work. You can give the lab more time from the app. Default: your saved time limit, or none.',
    )
    run.add_argument(
        '--ask-me',
        action='store_true',
        help="Keep each harness's own default mode. Permission requests then come to you on the board.",
    )
    commands.add_parser(
        'stop', help="Stop this folder's lab from another terminal: its server, its agents, and their processes."
    )
    return parser


def _agent(value: str) -> AgentChoice:
    harness, _, rest = value.partition(':')
    model, _, rest = rest.partition(':')
    effort, _, mode = rest.partition(':')
    return AgentChoice(harness=harness, model=model or None, effort=effort or None, mode=mode or None)
