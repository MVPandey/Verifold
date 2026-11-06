"""The environments that Verifold gives the processes it starts."""

import os

_SHARED = frozenset(
    {
        'PATH',
        'HOME',
        'USER',
        'LOGNAME',
        'SHELL',
        'LANG',
        'TERM',
        'COLORTERM',
        'TMPDIR',
        'TZ',
        'SSL_CERT_FILE',
        'SSL_CERT_DIR',
        'REQUESTS_CA_BUNDLE',
        'NODE_EXTRA_CA_CERTS',
        'HTTP_PROXY',
        'HTTPS_PROXY',
        'NO_PROXY',
        'ALL_PROXY',
        'http_proxy',
        'https_proxy',
        'no_proxy',
        'all_proxy',
    }
)
_SHARED_PREFIXES = ('LC_', 'XDG_')


def clean_environment() -> dict[str, str]:
    """
    Return this process's environment without any `GIT_` variable.

    A Git hook sets variables such as `GIT_DIR` and `GIT_INDEX_FILE`. A child process that inherits them runs its own
    Git commands against the wrong repository.
    """
    return {name: value for name, value in os.environ.items() if not name.startswith('GIT_')}


def harness_environment(prefixes: tuple[str, ...]) -> dict[str, str]:
    """
    Return the environment for a harness: the system's basics, and the variables that start with `prefixes`.

    Everything else stays out, such as the other vendors' API keys, cloud credentials, and Git hook variables, because
    the agent's shell commands inherit what the harness gets.
    """
    allowed = _SHARED_PREFIXES + prefixes
    return {name: value for name, value in os.environ.items() if name in _SHARED or name.startswith(allowed)}
