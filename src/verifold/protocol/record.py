"""The base class of every schema in the society record."""

from pydantic import BaseModel, ConfigDict


class Record(BaseModel):
    """An immutable schema that rejects unknown fields. Every record and message of the protocol extends it."""

    model_config = ConfigDict(frozen=True, extra='forbid')
