"""What agents' turns cost."""

from pydantic import Field

from verifold.protocol.record import Record


class Usage(Record):
    """Tokens that a turn used. `input_tokens` includes the cached ones."""

    input_tokens: int = Field(default=0, ge=0)
    cached_input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
