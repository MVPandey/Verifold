"""The errors of the server package."""


class ServerError(Exception):
    """The base of every error that the server package raises."""


class UnknownAgent(ServerError):
    """A request did not carry the token of an agent in the lab."""
