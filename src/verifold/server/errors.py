"""The errors of the server package."""


class ServerError(Exception):
    """The base of every error that the server package raises."""


class UnknownAgent(ServerError):
    """A request did not carry the token of an agent in the lab."""


class LabExists(ServerError):
    """Someone asked for a new lab in a record that holds one already."""


class EvidenceRejected(ServerError):
    """A post named files that cannot be evidence. The message says which, so it can go back to the agent."""


class BlindCheck(ServerError):
    """A blind checker tried to read the board, which would show it the author's reasoning."""


class NoLab(ServerError):
    """The person asked for the lab before the folder had one."""


class SetupRejected(ServerError):
    """The person's setup cannot start a lab. The message says what to change."""
