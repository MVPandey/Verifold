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
from verifold.app import serve
from verifold.harnesses.catalog import CATALOG
from verifold.protocol.app import AgentChoice, StartRequest
from verifold.runner.errors import RunnerError
from verifold.server.errors import ServerError
from verifold.store.errors import StoreError

DEFAULT_AGENTS = (AgentChoice(harness='claude-code'), AgentChoice(harness='codex'))
"""One agent of each harness, with the person's own models."""

_REPORTED = (RunnerError, StoreError, ServerError)


def main(argv: Sequence[str] | None = None) -> None:
    """
    Parse the arguments and run the command.

    `verifold` serves the folder: the setup screen, or the lab that the folder holds. `verifold run` starts a lab on a
    question from the command line.

    Args:
        argv: The arguments after the program name. `None` reads them from `sys.argv`.

    """
    args = _parser().parse_args(argv)
    try:
        start = _start(args) if args.command == 'run' else None
    except ValidationError as error:
        sys.exit(f'verifold: {error}')
    print(f'Serving Verifold for {Path.cwd()}. Its record is .verifold/record.jsonl. Press Ctrl+C to stop.')
    try:
        announce = partial(_announce, open_browser=not args.no_browser)
        asyncio.run(_until_stopped(serve(Path.cwd(), start, on_ready=announce)))
    except KeyboardInterrupt:
        pass  # Ctrl+C came before the event loop took over the signal.
    except (BaseExceptionGroup, *_REPORTED) as error:
        sys.exit(f'verifold: {_reported(error)}')
    print('Stopped. Run `verifold` here again to come back.')


def _reported(error: BaseException) -> BaseException:
    # Errors from starting a lab come out of the server's task group, wrapped in a group.
    if isinstance(error, BaseExceptionGroup):
        known = error.subgroup(_REPORTED)
        if known is None:
            raise error
        return _reported(known.exceptions[0])
    return error


def _start(args: argparse.Namespace) -> StartRequest:
    agents = tuple(_agent(value) for value in args.agent) if args.agent else DEFAULT_AGENTS
    return StartRequest(question=args.question, agents=agents, auto_mode=not args.ask_me, minutes=args.minutes)


async def _until_stopped(serving: Coroutine[None, None, None]) -> None:
    """
    Serve until Ctrl+C or SIGTERM, and return once the server and the agents' harnesses have stopped.

    SIGTERM cancels the server the way Ctrl+C does, so each agent's harness stops with its process group. The harnesses
    run in their own groups, so a plain SIGTERM would otherwise leave them running.
    """
    task = asyncio.ensure_future(serving)
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGTERM, task.cancel)
    try:
        # A cancel is the normal way to stop. It reaches this await after the server has cleaned up.
        with suppress(asyncio.CancelledError):
            await task
    finally:
        loop.remove_signal_handler(signal.SIGTERM)


def _announce(link: str, *, open_browser: bool) -> None:
    print(f'Open the lab: {link}', flush=True)
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
        metavar='HARNESS[:MODEL[:EFFORT]]',
        help=f'Add an agent: {", ".join(CATALOG)}, with an optional model and effort. Default: one of each, with your usual settings.',
    )
    run.add_argument(
        '--minutes',
        type=int,
        help='How long the agents may work. You can give the lab more time from the app. Default: no time limit.',
    )
    run.add_argument(
        '--ask-me',
        action='store_true',
        help="Keep each harness's own default mode. Permission requests then come to you on the board.",
    )
    return parser


def _agent(value: str) -> AgentChoice:
    harness, _, rest = value.partition(':')
    model, _, effort = rest.partition(':')
    return AgentChoice(harness=harness, model=model or None, effort=effort or None)
