"""
Measures, the lab's headline number, and the dashboard: what the person reads first when they open the lab.

A measure is a number that an agent reports: a label, an exact decimal, a unit, the time that it holds for, and the
script that produced it with that script's output, as files of the agent's folder. The board knows no service and
no currency: a measure is a label, a number, and a unit. The person, or the lab's coordinator, names one label as
the lab's headline number, and the newest measure with that label is its value. The dashboard is one page of HTML
that an agent makes from its folder. The numbers on it are the agents' own: the board ranks none and judges none.
"""

from decimal import Decimal
from typing import Annotated

from pydantic import AfterValidator, Field, PlainSerializer, StringConstraints

from verifold.protocol.agents import one_line

MAX_LABEL = 80
"""The most characters of a measure's label."""

MAX_MEASURE_UNIT = 20
"""The most characters of a measure's unit."""

MAX_VALUE_DIGITS = 28
VALUE_PLACES = 12
"""The most digits of a measure's value, and the most of them after its decimal point."""

MAX_PAGE_BYTES = 1_000_000
"""The most bytes of a dashboard's page."""


def _label(text: str) -> str:
    line = one_line(text)
    if len(line) > MAX_LABEL:
        raise ValueError(f'The label has {len(line)} characters, and the limit is {MAX_LABEL}.')
    return line


def _some_label(text: str) -> str:
    if not text:
        raise ValueError('The label holds no text.')
    return text


type HeadlineLabel = Annotated[str, AfterValidator(_label)]
"""The label of the lab's headline number, as one printable line. An empty text means that the lab has none."""

type MeasureLabel = Annotated[str, AfterValidator(_label), AfterValidator(_some_label)]
"""What a measure measures, such as "Account value", as one printable line."""

type MeasureUnit = Annotated[str, AfterValidator(one_line), StringConstraints(max_length=MAX_MEASURE_UNIT)]
"""The unit of a measure's value, such as `USD`, `%`, or `ms`, as one printable line. It can be empty."""

type MeasureValue = Annotated[
    Decimal,
    Field(max_digits=MAX_VALUE_DIGITS, decimal_places=VALUE_PLACES, allow_inf_nan=False),
    PlainSerializer(lambda value: format(value, 'f'), return_type=str, when_used='json'),
]
"""A measure's value, as an exact decimal. A record keeps it as a string of plain digits, with no exponent."""


def same_label(first: str, second: str) -> bool:
    """Return whether two labels name the same measure: the same words, whatever their capitals and spaces."""
    return one_line(first).casefold() == one_line(second).casefold()
