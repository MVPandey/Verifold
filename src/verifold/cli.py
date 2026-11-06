"""The `verifold` command."""

import argparse
from collections.abc import Sequence
from importlib.metadata import version


def main(argv: Sequence[str] | None = None) -> None:
    """
    Parse the arguments and run the command.

    Args:
        argv: The arguments after the program name. `None` reads them from `sys.argv`.

    """
    parser = argparse.ArgumentParser(
        prog='verifold',
        description='Run your coding agents as a research society.',
    )
    parser.add_argument('--version', action='version', version=f'%(prog)s {version("verifold")}')
    parser.parse_args(argv)
    parser.print_help()
