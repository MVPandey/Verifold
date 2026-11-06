"""The `verifold` command."""

import argparse
import asyncio
import sys
from collections.abc import Sequence
from importlib.metadata import version
from pathlib import Path

from verifold.app import DEFAULT_NETWORK, AgentSpec, LabConfig, run_lab
from verifold.harnesses.registry import HARNESSES
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
    config = LabConfig(question=args.question, agents=agents, network=tuple(args.network or DEFAULT_NETWORK))
    print(f'Running the lab in {Path.cwd()}. Its record is .verifold/record.jsonl. Press Ctrl+C to stop.')
    try:
        asyncio.run(run_lab(Path.cwd(), config, {name: make() for name, make in HARNESSES.items()}))
    except (RunnerError, StoreError) as error:
        sys.exit(f'verifold: {error}')
    except KeyboardInterrupt:
        print('Stopped the lab. Run `verifold run` here to resume it.')


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog='verifold', description='Run your coding agents as a research society.')
    parser.add_argument('--version', action='version', version=f'%(prog)s {version("verifold")}')
    commands = parser.add_subparsers(dest='command')
    run = commands.add_parser('run', help='Run a lab in this folder, or resume the one that is here.')
    run.add_argument('question', nargs='?', help='The question of a new lab. Leave it out to resume this lab.')
    run.add_argument(
        '--agent',
        action='append',
        metavar='HARNESS[:MODEL]',
        help=f'Add an agent: {", ".join(HARNESSES)}, with an optional model. Default: one of each.',
    )
    run.add_argument(
        '--network',
        action='append',
        metavar='DOMAIN',
        help='A domain that shell commands may reach. Default: package and model downloads.',
    )
    return parser


def _agent(value: str) -> AgentSpec:
    harness, _, model = value.partition(':')
    return AgentSpec(harness=harness, model=model or None)
