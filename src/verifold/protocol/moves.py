"""
The moves that only the person makes, and that the lab's coordinator can ask the person for.

A move changes a hard limit of the lab: its time, the answer to a permission request, its agents, a setting, or its
question. The coordinator names one move in a request. The person answers the request, and a yes makes the move. The
person can also switch on a power for one kind of move. The coordinator's request for a move of that kind then takes
effect at once.
"""

from typing import Annotated, Literal, Self, assert_never

from pydantic import AfterValidator, Field, StringConstraints, model_validator

from verifold.protocol.agents import Label, Power, Role, TypedId, ValueId, one_line
from verifold.protocol.ids import AgentId, PostId
from verifold.protocol.record import Record
from verifold.protocol.settings import MAX_MINUTES, JobSettings

type Question = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4_000)]

type Note = Annotated[str, AfterValidator(one_line), StringConstraints(max_length=200)]
"""Why the question was revised, as one line. It can be empty."""

type LabSetting = Literal['jobs.at_time_limit', 'jobs.at_exit']
"""
The settings of a running lab that a move can change. The `permissions` settings are not among them: they decide
how Verifold handles permission requests, and they stay with the person.
"""


class TimeMove(Record):
    """More time for the lab: `minutes` after the end that the lab has when the move takes effect. It never ends the lab earlier."""

    type: Literal['time'] = 'time'
    minutes: int = Field(ge=1, le=MAX_MINUTES)


class PermissionMove(Record):
    """
    The answer to a permission request of another agent's harness that waits for the person.

    `option` is the harness's own ID of one of its answers on the ask. Only an answer for this once counts: an
    answer that the harness remembers, and Verifold's grant for every agent, stay with the person.
    """

    type: Literal['permission'] = 'permission'
    ask: PostId
    option: ValueId


class AddSeat(Record):
    """
    The seat of the one agent that a move adds: its harness, its model, its effort, and whether it is on call.

    The seat holds nothing else. It states no model family, because the family decides whether a blind rerun
    counts as one by another family. It names no mode of the harness, and it is not the coordinator's seat, has no
    power, and is no reviewer seat. Those stay with the person.
    """

    harness: Label
    model: TypedId | None = None
    effort: TypedId | None = None
    on_call: bool = False
    role: Role = ''
    """
    A role that the coordinator gives the seat, as one line. The record keeps it as the coordinator's word, never
    as the person's.
    """


class AddMove(Record):
    """One more agent for the lab, in the seat that the move describes."""

    type: Literal['add_agent'] = 'add_agent'
    seat: AddSeat


class RemoveMove(Record):
    """The removal of another agent from the lab, which is final for that agent."""

    type: Literal['remove_agent'] = 'remove_agent'
    agent: AgentId


class SettingMove(Record):
    """A new value for one setting of the running lab. The person's settings files stay as they are."""

    type: Literal['setting'] = 'setting'
    key: LabSetting
    value: str

    @model_validator(mode='after')
    def _a_value_of_the_setting(self) -> Self:
        JobSettings.model_validate({self.key.partition('.')[2]: self.value})
        return self


class QuestionMove(Record):
    """A revision of the lab's question. `note` says why, as one line."""

    type: Literal['question'] = 'question'
    question: Question
    note: Note = ''


type Move = Annotated[
    TimeMove | PermissionMove | AddMove | RemoveMove | SettingMove | QuestionMove, Field(discriminator='type')
]


def power_of(move: Move) -> Power:
    """Return the power that covers a move."""
    match move:
        case TimeMove():
            return 'time'
        case PermissionMove():
            return 'permissions'
        case AddMove() | RemoveMove():
            return 'agents'
        case SettingMove():
            return 'settings'
        case QuestionMove():
            return 'question'
        case _:
            assert_never(move)
