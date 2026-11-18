"""The base class of every schema in the society record."""

from pydantic import BaseModel, ConfigDict

from verifold.protocol.ids import PERSON


class Record(BaseModel):
    """
    The base of every record and message: immutable, and strict about its fields.

    Readers reject fields that they don't know, so a new field in a stored record needs a new format version.
    """

    model_config = ConfigDict(frozen=True, extra='forbid')


def unset(value: object) -> bool:
    """
    Return whether a field holds nothing: `None` or `False`.

    A field that leaves such a value out of its JSON came later than its record. So a record without it reads as
    before, and every view of it stays as long as before.
    """
    return value is None or value is False


def by_person(value: object) -> bool:
    """Return whether a field names the person, which is its default. Such a field leaves the person out of its JSON."""
    return value == PERSON
