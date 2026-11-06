"""The `verifold` command."""

import argparse
import asyncio
import signal
import sys
from collections.abc import Coroutine, Sequence
from importlib.metadata import version
from pathlib import Path

from verifold.app import AgentSpec, LabConfig, run_lab
from verifold.harnesses.catalog import CATALOG
from verifold.runner.errors import RunnerError
from verifold.store.errors import StoreError


def main(argv: Sequence[str] | None = None) -> None:
    """
    Parse the arguments and run the command.

    Args:
        argv: The arguments after the program name. `None` reads them from `sys.argv`.

    """
    parser = _parser()
    args = parser.parse_args(argv)
    if args.command != 'run':
        parser.print_help()
        return
    agents = tuple(_agent(value) for value in args.agent) if args.agent else LabConfig().agents
    config = LabConfig(question=args.question, agents=agents, auto_mode=not args.ask_me)
    print(f'Running the lab in {Path.cwd()}. Its record is .verifold/record.jsonl. Press Ctrl+C to stop.')
    try:
        asyncio.run(_until_stopped(run_lab(Path.cwd(), config)))
    except (RunnerError, StoreError) as error:
        sys.exit(f'verifold: {error}')
    except KeyboardInterrupt:
        print('Stopped the lab. Run `verifold run` here to resume it.')


async def _until_stopped(lab: Coroutine[None, None, None]) -> None:
    """
    Run the lab until it ends, Ctrl+C, or SIGTERM.

    SIGTERM cancels the lab the way Ctrl+C does, so each agent's harness stops with its process group. The harnesses
    run in their own groups, so a plain SIGTERM would otherwise leave them running.
    """
    task = asyncio.ensure_future(lab)
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGTERM, task.cancel)
    try:
        await task
    except asyncio.CancelledError:
        raise KeyboardInterrupt from None
    finally:
        loop.remove_signal_handler(signal.SIGTERM)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog='verifold', description='Run your coding agents as a research society.')
    parser.add_argument('--version', action='version', version=f'%(prog)s {version("verifold")}')
    commands = parser.add_subparsers(dest='command')
    run = commands.add_parser('run', help='Run a lab in this folder, or resume the one that is here.')
    run.add_argument('question', nargs='?', help='The question of a new lab. Leave it out to resume this lab.')
    run.add_argument(
        '--agent',
        action='append',
        metavar='HARNESS[:MODEL[:EFFORT]]',
        help=f'Add an agent: {", ".join(CATALOG)}, with an optional model and effort. Default: one of each, with your usual settings.',
    )
    run.add_argument(
        '--ask-me',
        action='store_true',
        help="Keep each harness's own default mode. Permission requests then come to you on the board.",
    )
    return parser


def _agent(value: str) -> AgentSpec:
    harness, _, rest = value.partition(':')
    model, _, effort = rest.partition(':')
    return AgentSpec(harness=harness, model=model or None, effort=effort or None)
