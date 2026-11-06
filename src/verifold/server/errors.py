"""The errors of the server package."""


class ServerError(Exception):
    """The base of every error that the server package raises."""


class UnknownAgent(ServerError):
    """A request did not carry the token of an agent in the lab."""


class LabExists(ServerError):
    """A new lab was asked for in a record that holds a lab already."""
