"""
The moves that only the person makes, and that the lab's coordinator can ask the person for.

A move changes a hard limit of the lab: its time, the answer to a permission request, its agents, a setting, its
question, or the pace of its seats. The coordinator names one move in a request. The person answers the request,
and a yes makes the move. The person can also switch on a power for one kind of move. The coordinator's request for
a move of that kind then takes effect at once. The person makes a move of pace from the app too.
"""

from typing import Annotated, Literal, Self, assert_never

from pydantic import AfterValidator, AwareDatetime, Field, StringConstraints, model_validator

from verifold.protocol.agents import Power, Role, TypedId, ValueId, one_line
from verifold.protocol.ids import AgentId, PostId
from verifold.protocol.record import Record
from verifold.protocol.settings import MAX_BUDGET_TOKENS, MAX_MINUTES, JobSettings

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

    The seat holds nothing else. It states no model family, because the family decides whether an independent
    rerun counts as one by another model. It names no mode of the harness, and it is not the coordinator's seat, has no
    power, and is no reviewer seat. Those stay with the person.
    """

    harness: Annotated[TypedId, StringConstraints(max_length=40)]
    """The key of a harness of this computer, as one printable line. A request names a harness that this computer has."""
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


type Why = Annotated[str, AfterValidator(one_line), StringConstraints(max_length=200)]
"""Why a move of pace is made, as one line. The coordinator's move has one, and the person's can be empty."""


class PauseMove(Record):
    """
    A pause of one seat: until `until`, or with `None` until somebody resumes it.

    A paused seat finishes the turn that runs. No post, alarm, or rerun starts a turn of it, other than a post of
    the person for it. The desk's seat takes no pause.
    """

    type: Literal['pause'] = 'pause'
    agent: AgentId
    until: AwareDatetime | None = None
    why: Why = ''


class ResumeMove(Record):
    """The end of the pause of one seat. The coordinator's power ends only a pause that the coordinator made."""

    type: Literal['resume'] = 'resume'
    agent: AgentId
    why: Why = ''


class CapMove(Record):
    """
    A limit of tokens for one hour of the clock: for one seat with `agent`, and for the whole lab without it.

    When the turns that ended in this hour reach the limit, the seat's next turn, or each seat's under the lab's
    limit, waits for the next hour. `None` takes the limit back: the person's takes back both, and the coordinator's
    takes back its own. The desk's seat takes no limit, and its turns count toward the lab's.
    """

    type: Literal['cap'] = 'cap'
    agent: AgentId | None = None
    tokens_per_hour: int | None = Field(default=None, ge=1, le=MAX_BUDGET_TOKENS)
    why: Why = ''


type PaceMove = Annotated[PauseMove | ResumeMove | CapMove, Field(discriminator='type')]
"""A move of pace: a pause, its end, or a limit of tokens per hour."""

type Move = Annotated[
    TimeMove | PermissionMove | AddMove | RemoveMove | SettingMove | QuestionMove | PauseMove | ResumeMove | CapMove,
    Field(discriminator='type'),
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
        case PauseMove() | ResumeMove() | CapMove():
            return 'pace'
        case _:
            assert_never(move)
