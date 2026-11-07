"""The base class of every schema in the society record."""

from pydantic import BaseModel, ConfigDict


class Record(BaseModel):
    """
    The base of every record and message: immutable, and strict about its fields.

    Readers reject fields that they don't know, so a new field in a stored record needs a new format version.
    """

    model_config = ConfigDict(frozen=True, extra='forbid')
