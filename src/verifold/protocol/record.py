"""The base class of every schema in the society record."""

from pydantic import BaseModel, ConfigDict


class Record(BaseModel):
    """
    An immutable schema that rejects unknown fields. Every record and message of the protocol extends it.

    A reader rejects a field that it does not know, so a stored record with a new field needs a new format version.
    """

    model_config = ConfigDict(frozen=True, extra='forbid')
