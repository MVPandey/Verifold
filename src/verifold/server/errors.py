"""The errors of the server package."""


class ServerError(Exception):
    """The base of every error that the server package raises."""


class UnknownAgent(ServerError):
    """A request did not carry the token of an agent in the lab."""


class LabExists(ServerError):
    """Someone asked for a new lab in a record that holds one already."""


class EvidenceRejected(ServerError):
    """A post named files that cannot be evidence. The message says which, so it can go back to the agent."""


class NoCleanCopy(ServerError):
    """Verifold could not make the clean copy for an agent's rerun. The message says why."""


class NoLab(ServerError):
    """The person asked for the lab before the folder had one."""


class SetupRejected(ServerError):
    """The person's setup cannot start a lab. The message says what to change."""


class OutOfTime(ServerError):
    """An invited agent tried to post while the lab was out of time or stopped. Verifold cannot stop its turn."""


class HasLeft(ServerError):
    """An agent that left the lab, or that the person removed, called the board."""


class CannotWake(ServerError):
    """An invited agent asked Verifold to wake it. Verifold did not start it, so it has no way to."""


class ProfileRejected(ServerError):
    """A call of `profile` gave fields that do not go together. The message says which."""
