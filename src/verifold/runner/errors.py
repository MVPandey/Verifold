"""The errors of the runner package."""


class RunnerError(Exception):
    """The base of every error that the runner package raises."""


class NoFileManager(RunnerError):
    """No command on this computer opens a folder in a file manager, or the command failed."""


class NoAgentFolder(RunnerError):
    """A folder of the lab's agents is missing, or it is a link to another place and not a real folder of the lab."""


class NoCrew(RunnerError):
    """A rerun request found no agent that Verifold started, so it has no harness for a blind checker."""
