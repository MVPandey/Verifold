"""
Allowances and actions: what the person lets one acting seat do in the world without a question, and what it declares.

An allowance comes from the person only. It names one seat, what the seat may do in the person's words, a bound for
one action, a bound in total, an end time, and a unit. The board knows no currency: an amount is a number in the
allowance's unit, and the board adds amounts as exact decimals. The acting seat holds its own key and makes its own
calls. The board records each action that the seat declares, counts it against the allowance, and stops the seat's
turns at the limit. The limit is recorded, not enforced: the board is not in the path of the call.
"""

from decimal import Decimal
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, AwareDatetime, Field, StringConstraints, model_validator

from verifold.protocol.agents import one_line
from verifold.protocol.ids import AgentId
from verifold.protocol.record import Record

MAX_AMOUNT_DIGITS = 18
"""The most digits of an amount."""
AMOUNT_PLACES = 6
"""The most digits of an amount after its decimal point."""

type Amount = Annotated[
    Decimal, Field(ge=0, max_digits=MAX_AMOUNT_DIGITS, decimal_places=AMOUNT_PLACES, allow_inf_nan=False)
]
"""An amount in an allowance's unit, as an exact decimal of zero or more. A record keeps it as a string."""

type Bound = Annotated[
    Decimal, Field(gt=0, max_digits=MAX_AMOUNT_DIGITS, decimal_places=AMOUNT_PLACES, allow_inf_nan=False)
]
"""A bound of an allowance: an amount above zero."""

type AllowanceId = Annotated[str, StringConstraints(pattern=r'^a-[1-9][0-9]*$')]

MAX_UNIT = 20
MAX_PURPOSE = 200


def _line(most: int, what: str) -> AfterValidator:
    def check(text: str) -> str:
        line = one_line(text)
        if not line:
            raise ValueError(f'{what} holds no text.')
        if len(line) > most:
            raise ValueError(f'{what} has {len(line)} characters, and the limit is {most}.')
        return line

    return AfterValidator(check)


type Unit = Annotated[str, _line(MAX_UNIT, 'The unit')]
"""The unit of an allowance's amounts, such as `USD` or `$`, as one printable line. The board knows no currency."""

type Purpose = Annotated[str, _line(MAX_PURPOSE, 'What the allowance is for')]
"""What an allowance is for, in the person's words, as one printable line."""


class AllowanceTerms(Record):
    """What an allowance lets its holder do: for what, up to which amount an action and in total, and until when."""

    holder: AgentId
    """The acting seat that holds the allowance. The coordinator and the desk hold none."""
    purpose: Purpose
    unit: Unit
    per_action: Bound
    """The most that one action may cost, with its fees."""
    total: Bound
    """The most that the actions of the allowance may cost together."""
    ends_at: AwareDatetime
    """When the allowance ends by itself. An action after it waits for the person."""
    check_above: Amount | None = None
    """
    The cost above which an action needs a check first: a `check` that holds, from another agent than the action's
    author, of a post that the action rests on. `None` asks for no check.
    """

    @model_validator(mode='after')
    def _bounds(self) -> Self:
        if self.per_action > self.total:
            raise ValueError('An allowance allows no more for one action than in total.')
        return self


type ActionNeed = Literal['none', 'per_action', 'total']
"""
Why an action waits for the person: the seat has no allowance in force (`none`), its cost is above the bound for one
action (`per_action`), or it would take the actions of the allowance past its total (`total`).
"""

type ActionState = Literal['allowed', 'waits', 'yes', 'no', 'missed']
"""
Where an action stands. `allowed`: the allowance allowed it when it was declared. `waits`: it waits for the person
until its offer ends. `yes` and `no`: the person answered. `missed`: its offer ended without the person's answer, so
nothing was done.
"""
