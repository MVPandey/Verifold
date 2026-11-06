"""The errors of the society package."""


class SocietyError(Exception):
    """The base of every error that the society package raises."""


class RejectedEvent(SocietyError):
    """An event that does not fit the board. The message says what to change, so it can go back to the agent."""


class NotFound(SocietyError):
    """A lookup named something that is not on the board."""
