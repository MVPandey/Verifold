"""The errors of the runner package."""


class RunnerError(Exception):
    """The base of every error that the runner package raises."""


class NoCrew(RunnerError):
    """A rerun request found no agent that Verifold started, so it has no harness for a blind checker."""
