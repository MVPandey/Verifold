"""The environments that Verifold gives the processes it starts."""

import os


def clean_environment() -> dict[str, str]:
    """
    Return this process's environment without any `GIT_` variable.

    A Git hook sets variables such as `GIT_DIR` and `GIT_INDEX_FILE`. A child process that inherits them runs its own
    Git commands against the wrong repository.
    """
    return {name: value for name, value in os.environ.items() if not name.startswith('GIT_')}
