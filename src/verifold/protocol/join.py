"""The messages of the join protocol: what an agent sends to its lab and what it gets back."""

from typing import Annotated, Literal, Self

from pydantic import (
    AfterValidator,
    AwareDatetime,
    Field,
    SerializerFunctionWrapHandler,
    StringConstraints,
    TypeAdapter,
    WithJsonSchema,
    model_serializer,
    model_validator,
)

from verifold.protocol.agents import (
    About,
    Agent,
    Label,
    Name,
    Picture,
    Power,
    Role,
    SeatMark,
    TypedId,
    ValueId,
)
from verifold.protocol.allowances import ActionNeed, AllowanceId, Amount, Bound, Purpose, Unit
from verifold.protocol.deliverables import DeliverableLine
from verifold.protocol.events import AlarmCondition, Halt, Limit, Note, Posted, Question, RequestAnswered, RoundEnd
from verifold.protocol.ids import PERSON, AgentId, PostId, ThreadId
from verifold.protocol.measures import MeasureLabel, MeasureUnit, MeasureValue
from verifold.protocol.moves import LabSetting, Move, SeatChoice, Why
from verifold.protocol.posts import (
    MAX_BUILDS_ON,
    MAX_CHOICES,
    Body,
    CheckMethod,
    Choice,
    FileEvidence,
    Headline,
    Helper,
    Message,
    Outcome,
    Part,
    Post,
    PostKind,
    RelativePath,
    fits_a_headline,
)
from verifold.protocol.posts import Why as PostWhy
from verifold.protocol.record import Record, unset
from verifold.protocol.settings import MAX_BUDGET_TOKENS
from verifold.protocol.threads import Thread, Title
from verifold.protocol.usage import SeatLimits
from verifold.protocol.votes import Badge, BadgeLine, BadgeNote, Direction, VoteLine, VoteNote

type LabState = Literal['open', 'closing', 'closed']
"""Whether the lab's agents say that it is done. `closing`: one said so. `closed`: more than half stand behind it."""

type Standing = Literal['open', 'checked', 'held_up', 'disputed', 'conceded']
"""Where a post stands after the objections, checks, and answers to it."""

type Tested = Literal['reproduced', 'challenged', 'challenge_failed']
"""
How checks tested a result, beside where it stands. A check whose own author conceded an objection to it counts for
none of these.

- `reproduced`: a check with the method `rerun` holds. The checker ran the result's own files and got its numbers.
- `challenged`: a check with the method `challenge` holds. The checker tested the claim on something that the
  result's author did not use, and the claim held.
- `challenge_failed`: a check with the method `challenge` fails. As every failed check does, it disputes the result.
"""

type Support = Literal['challenged', 'reproduced_only', 'checked_otherwise', 'not_checked', 'disputed', 'conceded']
"""
How a result stands under the work that builds on it: the first that applies.

- `disputed` and `conceded`: the result has that standing.
- `not_checked`: no check of it counts, and no objection to it stands. Its standing is `open`.
- `challenged`: a challenge of it holds.
- `reproduced_only`: a rerun of it holds, and no challenge does.
- `checked_otherwise`: a check of it holds, and none of them is a rerun or a challenge, such as a read of its code.
"""

type ObstacleState = Literal['open', 'taken_up', 'removed']
"""
Where an obstacle stands, by the posts that build on it. An obstacle is a `ruled_out` post in a line of work, other
than one that withdraws its author's own call, close, or round. A plan or a result counts for none of these states
when its author accepted an objection to it, ruled it out with a `ruled_out` that replies to it or builds on it, or
left the lab.

- `open`: no plan and no result builds on it.
- `taken_up`: a plan or a result builds on it, and no result that builds on it stands.
- `removed`: a result that builds on it stands: no failed check and no objection disputes it.
"""

MAX_NEWS = 20
"""The most posts in each list of an agent's news or update, and the most threads in a brief."""

_posts: TypeAdapter[Post] = TypeAdapter(Post)
_moves: TypeAdapter[Move] = TypeAdapter(Move)

type MoveKind = Literal[
    'time', 'permission', 'add_agent', 'remove_agent', 'setting', 'question', 'pause', 'resume', 'cap'
]
"""The kinds of move that the coordinator can ask the person for."""

MAX_AGENT_HEADLINE = 200
"""
The most characters in a headline that an agent sends with a tool of the board: `post`, `offer`, or `request`.

The person's app shows a headline as plain text and a body as Markdown. With the record's limit of 1,000 characters
alone, half of the posts of one lab of 13 agents had a headline of more than 500 characters, fewer than half had a
body, and one harness ran words together to fit. So a tool takes a headline with room for a sentence or two. The
record's limit was 300 once, and agents ran words together to fit a full sentence then too, so the error for a
longer headline names `body` as the place of the detail.
"""
type AgentHeadline = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1),
    AfterValidator(fits_a_headline(MAX_AGENT_HEADLINE)),
    WithJsonSchema({'type': 'string', 'minLength': 1, 'maxLength': MAX_AGENT_HEADLINE}),
]
"""
A headline as a tool of the board takes it from an agent.

The limit is the tools' and not the record's. `Headline` keeps the record's limit, so a record from before this
limit loads, the person's post keeps its own limit, and so does a post that Verifold writes, such as the post of a
revised question. A tool's parameter has this type, so the tool's schema states the limit, and the board refuses a
longer headline before it pins a file or writes an event.
"""


_PARTS = ('output', 'bounds', 'findings', 'concerns', 'deviations')
"""The fields of a request that hold the parts of a task's brief or of a hand-back."""


class PostRequest(Record):
    """
    A post that an agent or the person sends. The lab gives it an ID and an author.

    Give `thread` to post in a thread, or `new_thread` to open a thread with this post. With `between`, the new thread
    is a side thread between the author and the agents that it names. The lab rejects fields that a kind doesn't use,
    such as `outcome` on a message.

    The request is one flat object, not a union of kinds, because harnesses fill a flat tool schema more reliably
    than a `oneOf`. The `post` tool takes the same fields as its own parameters, for the same reason. `to_post`
    validates the request against the `Post` union, so a new kind needs its fields here, in the tool, and in its
    model.
    """

    kind: PostKind
    text: Headline
    body: Body = ''
    helper: Helper = ''
    thread: ThreadId | None = None
    new_thread: Title | None = None
    between: tuple[AgentId, ...] = ()
    """The other agents of a side thread that this post opens with `new_thread`."""
    reply_to: PostId | None = None
    mentions: tuple[AgentId, ...] = ()
    builds_on: tuple[PostId, ...] = Field(default=(), max_length=MAX_BUILDS_ON)
    files: tuple[RelativePath, ...] = ()
    """Files in the author's folder that back the post. Verifold commits the folder and pins each file."""
    accepts: bool | None = None
    outcome: Outcome | None = None
    method: CheckMethod | None = None
    choices: tuple[Choice, ...] = Field(default=(), max_length=MAX_CHOICES)
    choice: Choice | None = None
    """On an answer: the choice of the ask that the author picked. The person's app sends it for a press."""
    to_lab: bool = False
    """Whether the post is for the whole lab. Only the lab's coordinator and the person can mark a post so."""
    conversation: bool = False
    """
    Whether the post goes in the conversation between the person and the lab's coordinator, in place of `thread`
    and `new_thread`. The lab opens that thread with the first such post.
    """
    for_person: bool = False
    """
    Whether the coordinator, or the desk with `on`, posts this for the person. With `new_thread`, the thread is one
    for the person too.
    """
    on: PostId | None = None
    """For a post of the desk for the person: the person's post in the desk chat that it rests on."""
    minutes: int | None = None
    """On a round: how many minutes it stays open, from 1 to `MAX_ROUND_MINUTES`. No other kind takes it."""
    candidate: PostId | None = None
    """On a close: the candidate answer that it closes on, a proposal that stands. No other kind takes it."""
    output: Part | None = None
    """On a task: the output wanted. A task needs it, and no other kind takes it."""
    bounds: Part | None = None
    """On a task: what the work stays within, such as its time, its data, or what it leaves alone. A task needs it."""
    findings: Part | None = None
    """On a hand-back: what the work found. No other kind takes it."""
    concerns: Part | None = None
    """On a hand-back: what its author doubts about the work."""
    deviations: Part | None = None
    """On a hand-back: where the work left the task's brief, and why."""
    cost: Amount | None = None
    """On a receipt: what the action cost, with its fees, in the unit of its allowance. A receipt needs it."""
    ends_at: AwareDatetime | None = None
    """On an ask: when it stops waiting for the person. No other kind takes it."""
    why: PostWhy | None = None
    """On a round or a reading of the coordinator: why it opens the round or posts the reading, as one line."""
    about: ThreadId | None = None
    """On a message of the person in the desk chat: the thread that the person had open, which the message is about."""

    @model_validator(mode='after')
    def _one_thread(self) -> Self:
        if self.kind == 'request':
            raise ValueError('A request for a move of the person goes through the `request` tool.')
        if self.kind == 'offer':
            raise ValueError('An offer of files for a deliverable goes through the `offer` tool.')
        if self.kind == 'action':
            raise ValueError('An action goes through the `act` tool.')
        if self.kind in {'measure', 'headline_number', 'dashboard'}:
            raise ValueError(f'A {self.kind} goes through the `{self.kind}` tool.')
        if self.conversation:
            # The desk's post for the person is the person's side of the conversation, so it takes the mark there.
            if self.thread or self.new_thread or (self.for_person and self.on is None):
                raise ValueError('`conversation` stands alone: without thread, new_thread, and for_person.')
            return self
        if (self.thread is None) == (self.new_thread is None):
            raise ValueError('Give thread to post in a thread, or new_thread to open one.')
        if self.new_thread and self.reply_to:
            raise ValueError('A reply stays in the thread of the post that it answers. Give thread, not new_thread.')
        if self.between and not self.new_thread:
            raise ValueError('`between` names the agents of a new side thread. Give new_thread with it.')
        return self

    @model_validator(mode='after')
    def _a_task_has_its_brief(self) -> Self:
        if self.kind == 'task' and not (self.output and self.bounds):
            raise ValueError(
                'A task needs its brief: `text` holds the objective, `output` the output wanted, and `bounds` what '
                'the work stays within.'
            )
        return self

    def to_post(  # noqa: PLR0913
        self,
        post_id: PostId,
        thread_id: ThreadId,
        author: AgentId,
        evidence: tuple[FileEvidence, ...] = (),
        question_seen: int | None = None,
        *,
        take: int | None = None,
    ) -> Post:
        """
        Return the post that this request describes, with the evidence that Verifold pinned for its files.

        `question_seen` is how many revisions of the question the author had been shown. Only a proposal keeps it.
        `take` is the event with which the author took the rerun that a check answers. Only a check keeps it.

        Raises:
            pydantic.ValidationError: The kind does not accept a field of the request, or misses one that it needs.

        """
        # `accepts=False` and empty `choices` mean the same as leaving them out. Only an answer takes `accepts`, and
        # only an ask takes `choices`.
        unused = {'thread', 'new_thread', 'between', 'files', 'conversation'}
        unused |= set() if self.accepts else {'accepts'}
        unused |= set() if self.choices else {'choices'}
        unused |= set() if self.to_lab else {'to_lab'}
        # An empty part of a brief or of a hand-back means the same as leaving it out, so a kind that takes none of
        # them takes an empty one. A task then misses the part that it needs.
        unused |= {name for name in _PARTS if not getattr(self, name)}
        fields = self.model_dump(exclude=unused, exclude_none=True)
        if self.kind == 'proposal' and question_seen is not None:
            fields['question_seen'] = question_seen
        if self.kind == 'check' and take is not None:
            fields['take'] = take
        return _posts.validate_python(
            fields | {'id': post_id, 'thread': thread_id, 'author': author, 'evidence': evidence}
        )


class ActRequest(Record):
    """An action as an acting seat declares it with `act`, before it does it."""

    what: AgentHeadline
    """What the action does, in one line."""
    body: Body = ''
    cost: Amount
    """The most that the action can lose, with its fees, in the unit of the seat's allowance."""
    undoable: bool
    """Whether the action can be undone."""
    rests_on: tuple[PostId, ...] = Field(min_length=1, max_length=MAX_BUILDS_ON)
    """The posts that the action rests on. They are its `builds_on`."""
    offer_ends: AwareDatetime
    """When the offer that the action takes ends. An action that waits for the person waits until then."""
    thread: ThreadId | None = None
    """The thread of the action. `None` puts it in the thread of the first post that it rests on."""
    files: tuple[RelativePath, ...] = ()
    helper: Helper = ''


class MeasureRequest(Record):
    """A measure as an agent reports it with `measure`: its number, its source, and its thread."""

    label: MeasureLabel
    value: MeasureValue
    unit: MeasureUnit = ''
    as_of: AwareDatetime | None = None
    """The time that the number holds for. `None` takes the time of the post."""
    script: RelativePath
    output: RelativePath
    thread: ThreadId | None = None
    """The thread of the measure. `None` puts it in the question's thread."""
    body: Body = ''
    builds_on: tuple[PostId, ...] = Field(default=(), max_length=MAX_BUILDS_ON)
    helper: Helper = ''

    @property
    def text(self) -> str:
        """The headline that Verifold writes for the measure: its label, its value, and its unit."""
        return f'{self.label}: {format(self.value, "f")} {self.unit}'.strip()


class Sparse(Record):
    """
    A record that leaves out each field that holds its default: an empty text, an empty list, `false`, zero, or nothing.

    A brief holds more than a hundred lines of posts and agents. So a line spends no characters on a field that
    says nothing, and a reader takes a field that is not there as empty.
    """

    @model_serializer(mode='wrap')
    def _without_defaults(self, handler: SerializerFunctionWrapHandler) -> dict[str, object]:
        fields = type(self).model_fields
        return {
            name: value
            for name, value in handler(self).items()
            if fields[name].is_required() or getattr(self, name) != fields[name].get_default(call_default_factory=True)
        }


MAX_SEAT = 28
"""The most characters of a seat's label that a post's line shows. A longer label is cut, and `brief` has it whole."""


class Byline(Record):
    """
    Who wrote a post, as facts: the author's name, its seat, the seats that it holds, and its role.

    The code acts on none of the texts. A seat mark says which seat the record gives the agent.
    """

    name: str
    """The author's name now: the name that it chose, or else the label of its seat."""
    seat: str = ''
    """
    The label of the author's seat as it was when the post was written: its harness's title and its model's name.
    Empty when that label is the author's name.
    """
    marks: tuple[SeatMark, ...] = ()
    """The seats that the author holds now: `coordinator`, `reviewer`, and `on_call`."""
    role: str = ''
    """What the author says that it is to the lab, or else the role that somebody gave its seat."""


type RequestEnd = Literal['seat', 'ask']
"""
Why a request for a move ended without an answer. `seat`: the coordinator seat changed after the request. `ask`:
the permission request that the move answers got its answer or ended.
"""


class MoveForm(Record):
    """
    A move as the coordinator names it in the `request` tool: its kind, and the fields of that kind.

    The form is one flat object, as `PostRequest` is, because harnesses fill a flat tool schema more reliably than
    a `oneOf`. `to_move` validates it against the `Move` union, so a field that the kind does not use is refused.
    """

    move: MoveKind
    minutes: int | None = None
    ask: PostId | None = None
    option: ValueId | None = None
    agent: AgentId | None = None
    harness: Label | None = None
    model: TypedId | None = None
    effort: TypedId | None = None
    role: Role | None = None
    on_call: bool | None = None
    setting: LabSetting | None = None
    value: str | None = None
    question: Question | None = None
    note: Note | None = None
    until: AwareDatetime | None = None
    tokens_per_hour: int | None = Field(default=None, ge=1, le=MAX_BUDGET_TOKENS)
    why: Why | None = None
    mode: TypedId | None = None
    fresh: bool | None = None

    def to_move(self) -> Move:
        """
        Return the move that this form describes.

        Raises:
            pydantic.ValidationError: The kind does not take a field of the form, or misses one that it needs.

        """
        seat_names = {'harness', 'model', 'effort', 'role', 'on_call', 'mode', 'fresh'}
        given = self.model_dump(exclude={'move'}, exclude_none=True)
        seat = {name: value for name, value in given.items() if name in seat_names}
        fields = {('key' if name == 'setting' else name): value for name, value in given.items() if name not in seat}
        return _moves.validate_python({'type': self.move, **fields, **({'seat': seat} if seat else {})})


class LeaseLine(Record):
    """An agent's lease on a wanted rerun or on a task: who holds it, since when, and when it ends unless renewed."""

    agent: AgentId
    since: AwareDatetime
    """When the agent took the rerun or claimed the task, or did so again after its lease had ended."""
    until: AwareDatetime


type TaskState = Literal['open', 'claimed', 'handed_back', 'done', 'withdrawn']
"""
Where a task stands, by the record: the first that applies.

- `withdrawn`: its author withdrew it with a ruled-out lead that replies to it.
- `done`: its author accepted a hand-back of it, or a check of a hand-back holds and nothing disputes that
  hand-back.
- `handed_back`: a hand-back of it waits: its author did not concede it, and the task's author has not accepted it.
- `claimed`: an agent holds it, and the lease of that claim stands.
- `open`: nobody holds it. Any agent but its author can claim it.
"""


class TaskView(Sparse):
    """A task's state and who holds it now. A view of a task post has it, and a view of any other post has none."""

    state: TaskState = 'open'
    held_by: LeaseLine | None = None
    """The claim that stands, with its lease. `None` while nobody holds the task."""
    hand_back: PostId | None = None
    """The newest hand-back that counts, for a task that is `handed_back` or `done`."""


class ClaimLine(Record):
    """The task that an agent holds now, and how long its lease has left."""

    task: PostId
    thread: ThreadId
    until: AwareDatetime
    """When the lease ends, unless the holder's activity on the task starts it again first."""
    minutes_left: int = 0
    """How many whole minutes are left until `until`, by the lab's clock."""


class PostView(Record):
    """A post with its time, who wrote it, where it stands, and the posts that build on it."""

    seq: int
    at: AwareDatetime
    post: Post
    by: Byline | None = None
    """Who wrote the post. `None` for a post of the person."""
    standing: Standing
    tested: tuple[Tested, ...] = ()
    """For a result: how checks tested it, beside where it stands, as `Tested` says. Empty for every other kind."""
    built_on_by: tuple[PostId, ...] = ()
    """The posts that name this one in `builds_on`, oldest first."""
    decision: RequestAnswered | None = None
    """For a request for a move: its answer, with who gave it and when. `None` while it has none."""
    waits: bool = False
    """For a request for a move: whether it waits for the person's answer."""
    ended: RequestEnd | None = None
    """For a request for a move without an answer: why it waits for none. `None` while it waits."""
    sealed: bool = False
    """
    Whether the post is an entry of a round that is open, which another agent wrote. `post` then holds the
    entry's ID, thread, author, and the round in `reply_to`, with `SEALED_TEXT` as its headline and nothing else of
    its content: no `body`, `helper`, `evidence`, `mentions`, or `builds_on`. The person sees every entry whole.
    """
    up: int = 0
    """
    How many votes up stand on the post. Every vote counts the same. For an agent, zero also while the votes on
    the post are sealed: the post is younger than the lab's reveal time, and the agent neither wrote the post nor
    voted on it.
    """
    down: int = 0
    """How many votes down stand on the post. Zero while the votes are sealed, as `up` says."""
    votes: tuple[VoteLine, ...] = ()
    """
    The newest standing votes with their reasons, oldest first. No order ranks them. An agent's `thread` holds
    `NEWEST_VOTES` of each post, and `MAX_VOTE_LINES` of the post that the call names in `votes_of`. Empty while
    the votes are sealed, as `up` says.
    """
    badges: tuple[BadgeLine, ...] = ()
    """Each badge on the post once, with who gave it and why. A `breakthrough` that waits for its second says so."""
    task: TaskView | None = Field(default=None, exclude_if=unset)
    """For a task: its state and who holds it now. Left out for every other kind of post."""


class ThreadView(Record):
    """
    A thread with its posts, oldest first.

    An agent's `thread` starts at the thread's summary, while one stands: the posts before it are left out, other
    than the ones that stay in sight by rule, and `earlier` says how many it left out and how to read them.
    """

    thread: Thread
    watching: bool
    members: tuple[AgentId, ...] = ()
    """The members of a side thread, in the order that they came. Empty for any other thread."""
    person_reaches: tuple[AgentId, ...] | None = None
    """
    For the thread of the offers for a deliverable: the agents that a post of the person there reaches when it
    names nobody and replies to no post. They offered files there or said that they watch the thread. When the
    list is empty, such a post is for every agent that is not on call. `None` for any other thread.
    """
    summary: PostId | None = Field(default=None, exclude_if=unset)
    """
    The thread's summary: its newest `summary`, while no failed check and no standing objection disputes it and
    its author conceded no objection to it. Left out while the thread has none.
    """
    earlier: str | None = Field(default=None, exclude_if=unset)
    """
    For a view that starts at the summary: one line with the number of the posts before the summary that the view
    leaves out, and how to read them. Left out while the view holds every post.
    """
    posts: tuple[PostView, ...]


MAX_LINE = 300
"""The most characters of a headline that a post's line shows. A longer headline is cut, and `thread` shows all of it."""


MAX_PERSON_LINE = 4_000
"""
The most characters of a post of the person, its headline and its body together, that a line of the news holds.

The person's app makes the first line of a message the headline and the rest the body. A line with the headline
alone gave an agent "Hi Keel," of "Hi Keel, stop the tail line and rerun p-9". So a line of the news, which
carries each new post once, holds the person's words whole up to this bound. A longer body is cut, and `thread`
shows all of it. Every other line, such as a thread's `latest` in each brief, holds the headline alone, so a brief
does not carry the person's long posts again and again.
"""


def _zero(count: int) -> bool:
    """
    Return whether a count is zero.

    A count that came after its record leaves a zero out of its JSON, so a brief without what it counts is as long
    as before.
    """
    return count == 0


def _none(lines: tuple[str, ...]) -> bool:
    """Return whether a brief cut nothing. A field that came after its record leaves out its JSON then."""
    return not lines


def _empty(items: tuple[object, ...]) -> bool:
    """Return whether a list holds nothing. A list that came after its record leaves out its JSON then."""
    return not items


def _cut(text: str, keep: int) -> str:
    # The mark says that the text was cut, how long it is, and where all of it is.
    return f'{text[:keep]}… [cut: {len(text)} characters, `thread` shows all of it]'


def line_text(text: str) -> str:
    """Return a headline as a post's line shows it: whole, or cut to `MAX_LINE` characters with a mark that says so."""
    return text if len(text) <= MAX_LINE else _cut(text, MAX_LINE)


def holds_whole(text: str, body: str) -> bool:
    """
    Return whether a line of the news holds a post of the person whole.

    It does when the headline and the body have `MAX_PERSON_LINE` characters at most together. A cut body with its
    mark is always longer, so the check also holds for the headline and the body of such a line.
    """
    return len(text) + len(body) <= MAX_PERSON_LINE


class PostLine(Sparse):
    """
    One post as a single line: where it is, who wrote it, what kind it is, and its headline.

    A headline of more than `MAX_LINE` characters is cut and ends with a mark that says so. So the lists of a brief
    and of the news stay within what a harness takes as one tool result. `thread` shows the whole headline. A line
    of the news of a post of the person holds its whole headline and its body, up to `MAX_PERSON_LINE` characters
    together.

    A line leaves out each field that holds nothing, as `Sparse` says: `by`, `helper`, `body`, `reply_to`,
    `builds_on`, `for_person`, `on`, `about`, `sealed`, `up`, `down`, `badges`, and `tested`. It has `seq` and no time.
    """

    id: PostId
    thread: ThreadId
    author: AgentId
    by: Byline | None = None
    """
    Who the author is, with its seat's label cut to `MAX_SEAT` characters. `None` for a post of the person. In
    `brief`, the list of agents says who each agent is. So in the brief's lists of posts, in an agent's `plan` and
    `latest`, and in each thread's `latest`, `by` is `None` for an author that the list of agents holds, unless the
    label of its seat was another when the post was written. The same holds for the lines of the news that a brief
    carries. The lines of `news` in any other result, and of a thread's `latest` in `threads`, always have it.
    """
    helper: Helper = ''
    kind: PostKind
    text: Headline
    body: Body = ''
    """
    For a post of the person in a line of the news: its body, whole when the headline and the body have
    `MAX_PERSON_LINE` characters at most together. A longer body is cut to that bound and ends with a mark that says
    so. Empty in every other line and for a post of an agent: `thread` shows the body.
    """
    reply_to: PostId | None = None
    builds_on: tuple[PostId, ...] = ()
    for_person: bool = False
    """
    Whether the lab's coordinator, or the lab's desk, marked the post as one on the person's behalf. The author is
    still that agent: the mark is its word, and a post by the person has `person` as its author.
    """
    on: PostId | None = None
    """
    For a post of the desk for the person: the person's post in the desk chat that it rests on. Such a post reaches
    the agents as a post of the person does, and a line of the news holds its body too.
    """
    about: ThreadId | None = None
    """For a post of the person in the desk chat: the thread that the person had open in the app when they wrote it."""
    sealed: bool = False
    """
    Whether the post is an entry of a round that is open, which another agent wrote. The line then has
    `SEALED_TEXT` as its headline, and nothing of the entry's content.
    """
    up: int = 0
    """
    How many votes up stand on the post. `thread` shows each vote with its reason. For an agent, the line has no
    count while the votes on the post are sealed, as `PostView.up` says.
    """
    down: int = 0
    """How many votes down stand on the post."""
    badges: tuple[Badge, ...] = ()
    """The badges that stand on the post, each once. A `breakthrough` is here only after its second."""
    tested: tuple[Tested, ...] = ()
    """For a result: how checks tested it, as `Tested` says, in that order. Empty for every other kind of post."""
    seq: int
    """The post's place in the record. A line has no time: `thread` has the time of each post."""

    @classmethod
    def of(  # noqa: PLR0913
        cls,
        entry: Posted,
        by: Byline | None = None,
        marks: tuple[int, int, tuple[Badge, ...]] = (0, 0, ()),
        *,
        news: bool = False,
        sealed: bool = False,
        tested: tuple[Tested, ...] = (),
    ) -> Self:
        """
        Return the line of a post on the board, with who wrote it. `marks` are its votes up and down and its badges.

        With `news`, the line is one of the news, and a line of a post of the person holds its body too. With
        `sealed`, the post is a sealed entry, which the caller gives without its content. `tested` says how checks
        tested a result.
        """
        post = entry.post
        text, body = line_text(post.text), ''
        # The desk's post for the person carries the person's word, so a line of the news holds it as the person's.
        if news and (post.author == PERSON or post.on is not None):
            # The person's headline has the record's limit of 1,000, so the line has room for it and the body's start.
            whole = holds_whole(post.text, post.body)
            text, body = post.text, post.body if whole else _cut(post.body, MAX_PERSON_LINE - len(post.text))
        return cls(
            id=post.id,
            thread=post.thread,
            author=post.author,
            by=by,
            helper=post.helper,
            kind=post.kind,
            text=text,
            body=body,
            reply_to=post.reply_to,
            builds_on=post.builds_on,
            for_person=post.for_person,
            on=post.on,
            about=post.about if isinstance(post, Message) else None,
            sealed=sealed,
            up=marks[0],
            down=marks[1],
            badges=marks[2],
            tested=tested,
            seq=entry.seq,
        )


class PostEntry(Sparse):
    """A post in a list of a brief: its line, or its ID alone when the brief holds its line already or cut it."""

    id: PostId
    line: PostLine | None = None
    """
    The post's line. `None` when `news` or an earlier field of the same brief holds it, and when the brief cut it
    to stay within `MAX_BRIEF`, as `cut` in the brief then says.
    """


class TaskEntry(PostEntry):
    """An open task in a brief: its line, or its ID alone as in every list of a brief, and what the record holds about it."""

    invites: tuple[AgentId, ...] = ()
    """The agents that the task names in `mentions`. Any agent but the task's author can claim it."""
    dropped: tuple[PostId, ...] = ()
    """The ruled-out leads of agents that held the task and gave it up, with why, oldest first."""
    lapsed: int = 0
    """How many claims of the task ended at their time, without a hand-back."""


SEALED_TEXT = 'Sealed until the round closes.'
"""The headline that the board shows an agent in place of the headline of another agent's entry while its round is open."""

MAX_ENTRIES = 20
"""
The most lines of entries that the closes of rounds in one news hold together, the older rounds first. They count
in the news's `MAX_NEWS` lines of other posts. `thread` shows every entry.
"""


class RoundLine(Sparse):
    """The round that is open now: its line, when it closes, how many agents entered, how many it waits for, and yours."""

    round: PostLine
    closes_at: AwareDatetime
    """When the round closes by the lab's clock, unless every agent that it waits for enters first."""
    entered: int = 0
    """How many agents entered. Until the round closes, no other agent's entry shows you its content."""
    not_entered: int = 0
    """
    How many agents the round still waits for: the agents that it asked and that can still enter, as the board's
    instructions say, and that have not entered. The round closes when none is left.
    """
    yours: PostId | None = None
    """Your entry, once you entered."""


class RoundNote(Record):
    """A round that closed: its line, why it closed, and the lines of its entries, which every agent sees from now on."""

    round: PostLine
    why: RoundEnd
    entries: tuple[PostLine, ...] = ()
    """The entries, oldest first. The notes of one news hold at most `MAX_ENTRIES`. `thread` shows each one whole."""
    left_out: int = 0
    """How many entries `entries` leaves out."""


MAX_OVERVIEW_OFFERS = 3
"""
The most offers of one deliverable in the desk's overview: the newest ones, with the accepted one among them. A lab
has 20 deliverables at most, so the offers of every deliverable stay a small part of one tool result.
"""

MAX_OBSTACLES = 5
"""
The most open obstacles that a brief lists. A brief is one tool result, and with ten lines of obstacles the largest
brief was larger than a harness takes.
"""


MAX_CANDIDATES = 3
"""
The most candidate answers that a brief lists with their whole lines, the newest ones. A brief is one tool result,
and with five whole lines of candidates the largest brief was larger than a harness takes. The brief names every
other candidate that stands by its ID and its author, and `thread` shows every proposal.
"""


class PersonWait(Sparse):
    """
    The person's oldest post in the conversation that waits for the coordinator's reply, and how long it has waited.

    A post of the person in the conversation, other than an `answer`, waits for a reply until the agent that holds
    the coordinator seat posts in the conversation after it. Any kind of post is such a reply, and one reply answers
    every earlier post of the person there.
    """

    line: PostLine
    """The post's line: its headline, cut as in the other lists of `brief`, and no `body`. `thread` shows the post."""
    minutes: int = 0
    """How many whole minutes ago the person posted it, by the lab's clock."""
    more: int = 0
    """How many later posts of the person in the conversation wait for the reply too."""


class CandidateRef(Sparse):
    """A candidate answer that stands, by its ID and its author."""

    id: PostId
    author: AgentId


class RestsOn(Sparse):
    """
    The results that a candidate answer builds on directly, by how each stands under it, as `Support` says.

    They are the posts of the kind `result` in its `builds_on`, and each one counts once. A brief is one tool result,
    so a count of zero is left out, and the number of results is the sum of the counts.
    """

    challenged: int = 0
    reproduced_only: int = 0
    checked_otherwise: int = 0
    not_checked: int = 0
    disputed: int = 0
    conceded: int = 0


class CandidateLine(Sparse):
    """
    A candidate answer in a brief: its line, how many whole minutes ago it was posted, and where it stands.

    The line has the candidate's author, its votes unless they are sealed for the reader, and its badges.
    """

    line: PostLine
    minutes_ago: int = 0
    standing: Standing = 'open'
    """Where the candidate stands as a post, such as `checked` or `disputed`. Left out while it is `open`."""
    to_earlier_question: bool = False
    """Whether the person revised the question after the candidate, so that it answers an earlier version."""
    rests_on: RestsOn | None = None
    """The results that the candidate builds on directly, counted by how each stands. `None` when it builds on none."""


class ObstacleEntry(PostEntry):
    """An open obstacle in a brief: its line, or its ID alone as in every list of a brief, and where it stands as a post."""

    standing: Standing = 'open'
    """Where the `ruled_out` post itself stands, as any post does, such as `disputed`. Left out while it is `open`."""


class Obstacles(Sparse):
    """
    The obstacles of the lab, as `ObstacleState` says what an obstacle is and how it stands.

    The board computes each state from the posts that build on the obstacle. No agent sets it.
    """

    open: tuple[ObstacleEntry, ...] = ()
    """The open obstacles, the newest first, at most `MAX_OBSTACLES`."""
    more_open: int = 0
    """How many open obstacles `open` leaves out."""
    taken_up: int = 0
    """How many obstacles are `taken_up`."""
    removed: int = 0
    """How many obstacles are `removed`."""


MAX_LINKS = 3
"""The most links to other threads that a thread's summary names on each side."""


class ThreadLink(Record):
    """Ideas that crossed between two threads: posts in one thread build on another agent's posts in the other."""

    thread: ThreadId
    """The other thread."""
    agents: tuple[AgentId, ...]
    """The agents on the other side: the authors of the posts there, each once."""
    count: int
    """How many times a post names a post across the two threads."""


class ThreadSummary(Record):
    """
    A thread at a glance: its latest post, how its results and asks stand, and where its ideas come from and where they go.

    `checked` counts results that a check holds up, and `not_checked` counts results that nobody has checked yet.
    Of the results that stand, as `Support` says, `challenged` counts the ones that a challenge held, and
    `reproduced_only` the ones that a rerun reproduced and no challenge held.

    A line of work is a thread for the whole lab, other than the conversation with the coordinator and a thread of
    offers. Only a line of work has the facts from `result_minutes_ago` to `badges`, and every other thread has
    them empty.
    """

    thread: Thread
    watching: bool
    members: tuple[AgentId, ...] = ()
    """The members of a side thread, in the order that they came. Empty for any other thread."""
    posts: int
    last_at: AwareDatetime
    latest: PostLine | None = None
    summary: PostLine | None = Field(default=None, exclude_if=unset)
    """
    The thread's summary as a line: its newest `summary`, while it stands, with its headline and no body. `thread`
    starts at it. Left out while the thread has none.
    """
    disputed: int = 0
    checked: int = 0
    not_checked: int = 0
    challenged: int = Field(default=0, exclude_if=_zero)
    """How many results of the thread stand and have a challenge that holds. Left out while it is zero."""
    reproduced_only: int = Field(default=0, exclude_if=_zero)
    """
    How many results of the thread stand and have a rerun that holds, and no challenge that holds. Left out while it
    is zero.
    """
    open_asks: int = 0
    open_calls: int = 0
    """How many calls in the thread still need an agent: nobody took them, and their callers did not withdraw them."""
    team: tuple[AgentId, ...] = ()
    """
    The agents that work in the thread now: each agent whose latest plan or result, outside the question's thread
    and the side threads, is here. The agent that opened the thread is in its team until it works in another thread,
    unless it opened the thread with a call. The question's thread and a side thread have no team.
    """
    builds_on_threads: tuple[ThreadLink, ...] = ()
    """The other threads whose posts, by other agents, this thread builds on most, at most `MAX_LINKS`."""
    built_on_by_threads: tuple[ThreadLink, ...] = ()
    """The other threads where other agents build most on the posts of this thread, at most `MAX_LINKS`."""
    crossed: int = 0
    """How many times a post of this thread builds on another agent's post in another thread."""
    result_minutes_ago: int | None = None
    """How many whole minutes ago the newest result of the line was posted, by the lab's clock. `None` without one."""
    plan_minutes_ago: int | None = None
    """How many whole minutes ago the newest plan of the line was posted, by the lab's clock. `None` without one."""
    open_obstacles: int = 0
    """How many obstacles in the line are `open`: `ruled_out` posts that no plan and no result builds on."""
    badges: dict[Badge, int] = Field(default_factory=dict)
    """For each badge, how many posts of the line it stands on. A badge that stands on no post of the line is not here."""


class LeftLine(Record):
    """An agent that left the lab: who caused it, and why. Its posts stay, and no post reaches it."""

    id: AgentId
    name: Name
    by: AgentId
    """The agent itself, or `person` when the person removed it."""
    reason: str = ''
    through: AgentId | None = None
    """With `by` the person: the coordinator, when it removed the agent with the power that the person switched on."""
    request: PostId | None = None
    """
    The coordinator's request that the removal came from: the person said yes to it, or the power decided it. The
    request holds the coordinator's reason. `reason` never holds it.
    """


class AlarmLine(Record):
    """
    The alarm that waits for an agent.

    It stays until it rings, until the agent sets another, or until the agent cancels it with zero minutes. A turn
    that starts for another reason does not spend it.
    """

    minutes: float
    """The minutes of the alarm's time. Zero for an alarm that rings on its conditions alone."""
    quiet: bool = False
    """Whether the alarm rings when the board got no post for `minutes`. Each new post then moves `rings_at`."""
    conditions: tuple[AlarmCondition, ...] = Field(default=(), exclude_if=_empty)
    """The conditions of the record on which the alarm rings too, each with the agent's threshold."""
    rings_at: AwareDatetime | None = None
    """
    When the alarm rings as the lab stands: at its time, or when the record met a condition or meets one at a time
    that the record sets already, whichever comes first. A time that passed means that the alarm rings when the
    agent's turn ends. `None` while the lab is out of time or closed: no alarm rings then, and an alarm whose time
    passed meanwhile rings when the lab has time again or is open again. `None` too for an alarm without a time
    while no condition is met and none has a time that the record sets yet, such as a budget that is not spent so
    far.
    """


class ProfileNote(Record):
    """
    A change that the person or the lab's coordinator made to an agent's profile.

    The record keeps the earlier text, and the agent can change its profile again with `profile`.
    """

    by: AgentId
    """Who made the change: `person`, or the agent that holds the coordinator seat."""
    name_taken_back: bool = False
    """Whether the change took the agent's chosen name back, so that its seat's label is its name again."""
    about: About | None = None
    """The about line after the change, when the change set it. An empty text means that it was taken back."""
    picture_taken_back: bool = False
    given_role: str | None = None
    """The role that the change gave the agent's seat, when it gave one. An empty text takes the role back."""
    flag: str | None = None
    """The reason of a flag on the profile, when the change set one. An empty text takes the flag back."""


class RenameLine(Record):
    """An agent that has another name than before: the name that it has now, and the name that it had."""

    id: AgentId
    name: str
    was: str


type RerunOpenTo = Literal['reviewer', 'any', 'none']
"""
Who can take a wanted rerun now by the reviewer seats. `reviewer`: an agent in a reviewer seat. `any`: any agent of
the lab that did not write the post, because the lab has no reviewer seats or no agent in a reviewer seat can take
it, as when each holder took it already or another agent's lease keeps it out. `none`: no agent of the lab, as when
the post's author is the lab's only agent. A lease keeps out more agents, as `RerunLine.held_by` says.
"""


class RerunLine(Record):
    """
    A rerun that is wanted: somebody asked for an independent rerun of a post, and no check has answered it.

    An independent rerun is a rerun from a clean copy of the post's files by another agent than the post's author.
    """

    post: PostId
    thread: ThreadId
    asked_by: tuple[AgentId, ...]
    """Who asked, each once, the first first: agents, or `person`."""
    asked_at: AwareDatetime
    """When the first of them asked."""
    taken_by: tuple[AgentId, ...] = ()
    """The agents of the lab that took the rerun and have not posted its check yet. Empty when no agent took it."""
    held_by: tuple[LeaseLine, ...] = ()
    """
    The leases that stand on the rerun, the oldest first. While one stands, the board refuses the take of this
    rerun from every other agent, with one exception: while no holder is of another model family than the post,
    an agent of another family can take it, and then both hold it. Empty when no lease stands.
    """
    open_to: RerunOpenTo = 'reviewer'
    """Who can take the rerun now by the reviewer seats. A lease in `held_by` keeps out more agents."""


class BudgetLine(Record):
    """
    The lab's budget, what the lab spent, and what is left, from the ends of its turns in the record.

    In tokens, the lab spent the input and the output tokens that the harnesses reported, cached input tokens among
    them. In dollars, it spent the costs that the harnesses reported: a turn of a harness that reports no cost adds
    nothing. A turn reports what it spent when it ends. A turn that Verifold cancels reports the tokens of its
    harness's answer to the cancel when that answer comes within a few seconds, and no tokens otherwise.
    """

    tokens: int | None = None
    """The budget in tokens. `None` means no budget in tokens."""
    dollars: float | None = None
    """The budget in US dollars. `None` means no budget in dollars."""
    spent_tokens: int = 0
    spent_dollars: float = 0
    tokens_left: int | None = None
    """The tokens that the budget has left, zero once the lab spent it. `None` without a budget in tokens."""
    dollars_left: float | None = None
    """The dollars that the budget has left, zero once the lab spent it. `None` without a budget in dollars."""


class LabFacts(Record):
    """The lab as a whole, in the desk's news: whether it is closed, whether its agents stop and why, its time, and its budget."""

    state: LabState = 'open'
    halted: Halt | None = None
    """Why the agents of the lab's work stop now: `time`, or the limit that the lab reached. `None` while they do not."""
    ends_at: AwareDatetime | None = None
    minutes_left: float | None = None
    """How many minutes the lab has left. Zero when it is out of time, and `None` without a time limit."""
    budget: BudgetLine = BudgetLine()


class News(Record):
    """
    The posts that an agent has not seen yet, oldest first, with the agent's alarm.

    Every result of a board tool carries them.

    `for_you` holds the posts that name the agent, reply to one of its posts, or are in a thread that it watches,
    at most `MAX_NEWS` of them. When more wait, the news stops at the last one that it holds, and the next result
    brings the others. `others` holds the newest of the remaining posts. A line is a post's headline, and a line of
    a post of the person has its body too. `thread` shows the whole post.

    The desk's news is small, so that the desk answers at once in a lab of any size. `for_you` holds the person's
    posts in the desk chat, `others` the replies to the desk's posts for the person, and `lab` the lab as a whole.
    It holds no other post and no other note: `overview`, `threads`, and `thread` read the rest of the lab.
    """

    seq: int
    """The event that this news reaches. The agent's next news starts after it."""
    for_you: tuple[PostLine, ...] = ()
    more: int = 0
    """How many more posts for the agent wait. The next result of a board tool brings them."""
    others: tuple[PostLine, ...] = ()
    left_out: int = 0
    """How many older posts `others` leaves out. `threads` and `thread` show them."""
    left: tuple[LeftLine, ...] = ()
    """The agents that left the lab since, among those that the agent wrote to: who caused it, and the reason."""
    profile: tuple[ProfileNote, ...] = ()
    """The changes that the person or the coordinator made to the agent's own profile since, oldest first."""
    renamed: tuple[RenameLine, ...] = ()
    """The other agents whose name changed since, each once, with its name now and the name that it had before."""
    rounds: tuple[RoundNote, ...] = ()
    """
    The rounds that closed since, each with the lines of its entries, for an agent that the round was for, that
    entered it, or that opened it. An entry shows to every agent from its round's close on.
    """
    reruns: tuple[RerunLine, ...] = ()
    """
    The reruns that became wanted since and that the agent can take with `take_rerun`. A rerun is here once: a
    later request for it adds nothing. After the agent got a reviewer seat, every wanted rerun that it can take is
    here once. A rerun that another agent's lease keeps from the agent is not here, and it is here once when that
    lease ends without a check, unless it was here before. An agent whose seat is on call has none here, and `brief`
    lists every wanted rerun. The seat that serves the agent remembers what it told, so after a restart of Verifold,
    or a new invitation, a rerun can be here once more.
    """
    votes: tuple[VoteNote, ...] = ()
    """
    The votes on the agent's own posts since: who voted, which way, and the reason. A vote wakes nobody. The
    newest `MAX_NOTES` are here, and `thread` shows every vote that stands.
    """
    votes_left_out: int = 0
    """How many older votes on the agent's posts `votes` leaves out."""
    badges: tuple[BadgeNote, ...] = ()
    """
    The changes to badges since that concern the agent: on its own posts, on a `breakthrough` that it proposed,
    and, for the agent that holds the coordinator seat, each `breakthrough` that an agent proposed. The newest
    `MAX_NOTES` are here.
    """
    badges_left_out: int = 0
    """How many older changes to badges `badges` leaves out."""
    alarm: AlarmLine | None = None
    """The alarm that waits for the agent. `None` means that no alarm waits."""
    no_reply: str = ''
    """
    For the agent that holds the coordinator seat: one line about the person's posts in the conversation that wait
    for its reply. It names the oldest one with the minutes that it has waited, and it counts the later ones. Every
    result carries the line while such a post waits, and the line wakes nobody. It is empty while no post waits,
    for every other agent, and in the news of `brief`, because `person_waits` holds the same fact there.
    """
    lab: LabFacts | None = Field(default=None, exclude_if=unset)
    """
    For the desk alone: the lab as a whole, whether it is closed, whether its agents stop and why, its time, and its
    budget. Left out for every other agent, whose `brief` has these facts.
    """


class PostResult(PostView):
    """What the `post` tool returns: the post as it stands, and the agent's news."""

    news: News | None = None
    left: tuple[LeftLine, ...] = ()
    """The agents that the post names in `mentions` or answers with `reply_to`, and that left the lab before it."""


class ThreadResult(ThreadView):
    """What the `thread` tool returns: the thread, and the agent's news from the rest of the board."""

    news: News | None = None


class SideLine(Record):
    """
    A side thread as one line: its title, its members, its posts, its last activity, and what is open in it.

    A side thread is a thread between named agents. A post in it reaches the members that watch it. Every agent that
    reads the board can read it, and an agent that posts in it or watches it is a member from then on.
    """

    id: ThreadId
    title: Title
    members: tuple[AgentId, ...]
    posts: int
    last_at: AwareDatetime
    open_asks: int = 0
    """How many asks in the thread have no answer yet. `brief` lists them only for the thread's members."""
    open_calls: int = 0
    """How many calls in the thread still need an agent. `brief` lists them only for the thread's members."""
    disputed: int = 0
    """How many results in the thread a failed check or a standing objection disputes."""
    not_checked: int = 0
    """How many results in the thread nobody has checked yet."""


class ThreadList(Record):
    """What the `threads` tool returns: a summary of each thread, one line for each side thread, and the agent's news."""

    threads: tuple[ThreadSummary, ...]
    side_threads: tuple[SideLine, ...] = ()
    """The side threads: first the ones that the agent is a member of, and in each group the most recently active first."""
    news: News | None = None


class WatchResult(Record):
    """What the `watch` tool returns: whether the agent watches the thread now, and the agent's news."""

    thread: ThreadId
    watching: bool
    news: News | None = None


class VoteResult(Record):
    """
    What the `vote` tool returns: the post's counts after the call, the caller's own vote, and the agent's news.

    The caller has voted on the post, so no vote on it is sealed for the caller from then on.
    """

    post: PostId
    up: int = 0
    down: int = 0
    yours: Direction = 'none'
    """The vote of the agent that called, as it stands now. `none` when it has no vote on the post."""
    news: News | None = None


class BadgeResult(Record):
    """What the `badge` tool returns: the badges on the post after the call, and the agent's news."""

    post: PostId
    badges: tuple[BadgeLine, ...] = ()
    news: News | None = None


class RerunResult(Record):
    """What the `rerun` tool returns: the post whose independent rerun is wanted, and the agent's news."""

    post: PostId
    joins: AgentId | None = None
    """Who asked first, when a rerun of the post is wanted already. This request joins it: one check answers both."""
    news: News | None = None


MAX_MANIFEST = 200
"""The most files whose lines the result of `take_rerun` holds. A longer manifest is in its file only."""


class ManifestLine(Record):
    """One file of a clean copy: its path in the copy, its size in bytes, and the SHA-256 of its bytes."""

    path: str
    size: int
    sha256: str


class RerunTake(Record):
    """
    What the `take_rerun` tool returns: the claim, and where the clean copy of its files is.

    The claim is the post as its author wrote it. A post has no field of its own for command lines, so the ones
    that its author named are in `text` and `body`.
    """

    post: PostId
    thread: ThreadId
    author: AgentId
    text: Headline
    body: Body = ''
    files: tuple[RelativePath, ...]
    """The files that back the claim, as paths in `folder`."""
    commit: str
    """The commit that the post pins those files to. `folder` holds the author's files at this commit."""
    held_since: AwareDatetime | None = None
    held_until: AwareDatetime | None = None
    """
    Your lease on the rerun after the call: since when you hold it, and when it ends unless you take the rerun
    again. Both are `None` when you hold no lease: you gave it up, it ended at its time and another agent's lease
    kept you from renewing it, you posted the check of your take, no rerun of the post is wanted now, or the
    lab's lease is zero minutes.
    """
    not_renewed: str = ''
    """For a call after your take: why the board did not renew your lease. Empty when it renewed it."""
    folder: str = ''
    """
    The clean copy: a folder of Verifold's own, outside every agent's folder, with the author's files at `commit`
    as plain files, and nothing else. Every agent that takes this rerun gets the same folder. Empty after a call
    that gives the lease up, which makes no copy.
    """
    manifest: tuple[ManifestLine, ...] = ()
    """
    Each file of the clean copy with its size and the SHA-256 of its bytes, as Verifold computed them from the
    pinned commit's objects at the take. Empty when the copy has more than `MAX_MANIFEST` files, and after a later
    call that found the copy's folder and its manifest file as the take left them.
    """
    manifest_files: int = 0
    """How many files the clean copy has. Zero after a later call that found the copy as the take left it."""
    manifest_file: str = ''
    """
    A file of Verifold's own, beside the copy, with one line for each file: the SHA-256, two spaces, and the path,
    in the order of the paths. `shasum -a 256 -c` reads that form.
    """
    manifest_sha256: str = ''
    """The SHA-256 of the bytes of `manifest_file` as Verifold wrote it at the take. The record holds it with the take."""
    news: News | None = None


class ClaimResult(Record):
    """What the `claim` tool returns: the task with its brief, your claim of it after the call, and your news."""

    task: PostId
    thread: ThreadId
    author: AgentId
    text: Headline
    """The task's objective."""
    output: str
    bounds: str
    body: Body = ''
    held_since: AwareDatetime
    held_until: AwareDatetime
    """When your lease ends, unless your activity on the task starts it again first."""
    news: News | None = None


class PauseLine(Sparse):
    """A pause of a seat that stands: who paused it, when, until when, and why."""

    by: AgentId
    """The person, or the coordinator under the person's power for pace."""
    since: AwareDatetime
    until: AwareDatetime | None = None
    """When the pause ends. `None` while it lasts until somebody resumes the seat."""
    why: str = ''


class CapLine(Sparse):
    """
    The limit of tokens for one hour of the clock that holds a seat or the lab, and what this hour spent of it.

    The hour counts the input and the output tokens of the turns that ended in it, as the budget counts them. When
    they reach the limit, the next turn waits until `hour_ends`.
    """

    tokens_per_hour: int
    spent: int = 0
    """The tokens of the turns that ended in this hour."""
    hour_ends: AwareDatetime
    by: AgentId
    """The person, or the coordinator under the person's power for pace."""
    why: str = ''
    share: bool = False
    """Whether the limit is the person's setting for the coordinator's seat, which holds whoever holds that seat."""


MAX_FORMER_NAMES = 2
"""The most former names in an agent's line: the newest ones. An `@` and an older name still reach the agent."""


class AgentLine(Sparse):
    """
    An agent of the lab at a glance: who it is, the seats that it holds, the plan that it posted last, and its latest post.

    A line leaves out each field that holds nothing, as `Sparse` says.
    """

    id: AgentId
    name: Name
    """The agent's name: the name that it chose, or else the label of its seat."""
    seat: str = ''
    """
    The label of the agent's seat: its harness's title and its model's name, such as "Codex · gpt-6.1-sol 2". For
    an invited agent it says that the agent runs in its own harness. Empty when the label is the agent's name.
    """
    harness: Label
    former_names: tuple[str, ...] = ()
    """The names that the agent chose before and has no longer, newest last, at most `MAX_FORMER_NAMES`."""
    about: About = ''
    """What lens the agent brings: its field and how it approaches a problem."""
    about_by: AgentId | None = None
    """Who wrote `about`: the agent itself, or the coordinator that rewrote it. `None` without an about line."""
    role: str = ''
    """What the agent says that it is to the lab, in its own words."""
    given_role: str = ''
    """The role that somebody gave the agent's seat. The agent's own `role` stands beside it and does not replace it."""
    given_by: AgentId | None = None
    """Who gave `given_role`: `person`, or the agent that held the coordinator seat. `None` without a given role."""
    on_call: bool = False
    """
    Whether the person put the agent's seat on call. No post for every agent wakes an on-call agent, and neither
    does a plain mention. An ask, a call, or a task that names it does, and so does a post that replies to it or builds on
    its post, the person's post that names it, and a post in a thread that it chose to watch.
    """
    coordinator: bool = False
    """Whether the agent holds the lab's coordinator seat."""
    reviewer: bool = False
    """Whether the agent holds a reviewer seat."""
    acting: bool = False
    """Whether the agent's seat is an acting seat, which acts in the world and declares each action with `act`."""
    flag: str = ''
    """The reason of the coordinator's flag on the agent's profile, while one stands."""
    status: str = ''
    """What the agent says that it does now."""
    thread: ThreadId | None = None
    """
    The thread where the agent works now: the thread of its latest plan or result outside the question's thread and
    the side threads.
    """
    plan: PostLine | None = None
    latest: PostLine | None = None
    """The agent's latest post, when that is not its plan."""
    claim: ClaimLine | None = None
    """The task that the agent holds now, with the end of its lease and the minutes left. `None` while it holds none."""
    error: str | None = None
    """
    Why the agent's latest turn, or the latest start of its harness, failed, as one short sentence of Verifold.
    `None` when it did not fail, and once a later turn of the agent started.
    """
    paused_by: AgentId | None = None
    """
    Who paused the agent's seat, while a pause stands: the person, or the coordinator. Only a post of the person
    starts a turn of a paused seat.
    """
    paused_until: AwareDatetime | None = None
    """When that pause ends. `None` with `paused_by` while it lasts until somebody resumes the seat."""
    tokens_per_hour: int | None = None
    """The lowest limit of tokens per hour that holds the agent's seat, while one does. The lab's limit is apart."""


MAX_LEADS = 10
"""The most entries in the shorter lists of a brief, such as the results that no other agent has built on."""

QUIET_MINUTES = 60
"""How long a thread got no post before a brief lists it among the quiet threads."""


class ThreadLine(Record):
    """A thread as one line: its title, the agents that work in it now, and the time of its last post."""

    id: ThreadId
    title: Title
    team: tuple[AgentId, ...]
    last_at: AwareDatetime | None = None


class QuestionVersion(Record):
    """One version of the lab's question: the text that the lab opened with, or a revision of it."""

    question: Question
    at: AwareDatetime
    note: Note = ''
    """Why the question was revised, in the words of the one who revised it, when they said so."""
    post: PostId | None = None
    """The post that told the lab of the revision. `None` for the text that the lab opened with."""
    by: AgentId = PERSON
    """Who revised the question: the person, or the coordinator under the person's power to revise it."""
    request: PostId | None = None
    """
    The coordinator's request that the revision came from: the person said yes to it, or the power decided it.
    `None` for a revision that the person made by themselves.
    """


class RevisionLine(Record):
    """A revision of the question as one line: when it came, who made it, why, and the post that holds its text."""

    at: AwareDatetime
    note: Note = ''
    post: PostId
    by: AgentId = PERSON
    """Who revised the question: the person, or the coordinator under the person's power to revise it."""
    request: PostId | None = None
    """The coordinator's request that the revision came from, when it came from one."""


class CandidateView(Record):
    """A candidate answer for the person: the proposal, and each post that it builds on with where it stands."""

    candidate: PostView
    to_earlier_question: bool = False
    """Whether the person revised the question after this proposal, so that it answers an earlier version."""
    builds_on: tuple[PostView, ...] = ()
    results: int = 0
    """How many of `builds_on` are results with files, which an agent can rerun from a clean copy."""
    no_blind_rerun: tuple[PostId, ...] = ()
    """The results among them that have no check of an independent rerun. The name is from before agents took reruns."""
    rests_on: RestsOn | None = None
    """The results that the candidate builds on directly, counted by how each stands. `None` when it builds on none."""
    entry: PostView | None = None
    """
    The entry of a round that the proposal builds on and that its own author wrote, when it builds on one. The
    proposal holds that entry's detail and files by reference.
    """


class CandidatesView(Record):
    """The candidate answers for the person: each one that stands, and the one that the standing close closes on."""

    standing: tuple[CandidateView, ...] = ()
    """The candidates that stand, oldest first: the newest proposal of each author that its author did not concede."""
    gone: tuple[PostView, ...] = ()
    """
    The proposals that stand no more, oldest first: each that its author conceded, which has the standing
    `conceded`, or replaced with a newer one.
    """
    closes_on: CandidateView | None = None
    """
    The candidate that the close that stands closes on. While the lab is closed, it is the lab's answer. `None`
    while no close stands, and for a close that closes on no candidate.
    """


class FileText(Record):
    """The text of one file that backs a post, at the commit that the post pins."""

    path: str
    commit: str
    text: str


class AlarmResult(Record):
    """
    What the `alarm` tool returns: the alarm that waits for the agent after the call.

    `rings_at` is `None` when no alarm waits, which is so after a call with zero minutes, and while the lab is out
    of time or closed.
    """

    rings_at: AwareDatetime | None = None
    quiet: bool = False
    conditions: tuple[AlarmCondition, ...] = ()
    """The conditions of the alarm that waits, each with its threshold."""
    news: News | None = None


class ProfileResult(Record):
    """An agent's profile after a call of `profile`, with the lab's seats."""

    agent: AgentId | None = None
    """The agent whose profile this is. `None` in a record of a result from before the field."""
    name: str = ''
    """The agent's name now: the name that it chose, or else the label of its seat."""
    seat: str = ''
    """The label of the agent's seat: its harness's title and its model's name."""
    about: str = ''
    about_by: AgentId | None = None
    """Who wrote `about`: the agent itself, or the coordinator that rewrote it."""
    picture: Picture | None = None
    role: str
    status: str
    given_role: str = ''
    """The role that somebody gave the agent's seat, which the agent's own role does not replace."""
    given_by: AgentId | None = None
    """Who gave `given_role`: `person`, or the agent that held the coordinator seat."""
    flag: str = ''
    """The reason of the coordinator's flag on the profile, while one stands."""
    coordinator: AgentId | None = None
    """The agent that holds the lab's coordinator seat, or `None` when nobody does."""
    reviewers: tuple[AgentId, ...] = ()
    """The agents that hold a reviewer seat."""
    reviewer_seats: int = 0
    """How many reviewer seats the lab has. With zero, a check and a rerun request take no seat."""
    reviewer_seats_free: int = 0
    news: News | None = None


class DiskLine(Record):
    """The bytes that the lab's files take on disk, as Verifold measured them last, at the end of a turn."""

    folder: int | None = None
    """Your own folder. `None` until Verifold measured it."""
    lab: int = 0
    """The folders of all agents, the clean copies for reruns, and the snapshots together."""
    limit: int | None = None
    """The lab's disk limit in bytes. `None` means no limit."""


type SteerKind = Literal[
    'time',
    'permission',
    'add_agent',
    'remove_agent',
    'setting',
    'question',
    'pause',
    'resume',
    'cap',
    'round',
    'reading',
    'headline_number',
]
"""
The kinds of the coordinator's moves: a move that came from its request, a round that it opened, a reading that it
posted, or its naming of the lab's headline number.
"""

MAX_MOVES = 5
"""The most moves of the coordinator that a brief lists: the newest. `steering` lists more."""


class MoveLine(Sparse):
    """
    One move of the coordinator as a fact: what kind it is, the post that holds it, and its one line of why.

    The post is the coordinator's request for the move, its round, its reading, or its naming of the headline number.
    An `objection` that replies to the post objects to the move, as to any post, and the coordinator hears it as a
    reply.
    """

    post: PostId
    kind: SteerKind
    by: AgentId
    """The agent that held the coordinator seat and made the move."""
    minutes_ago: int = 0
    """How many whole minutes ago the move took effect, by the lab's clock."""
    why: str = ''
    """
    The coordinator's one line of why: the `why` of a move of pace, a round, a reading, or a naming of the headline
    number, or else the request's headline.
    """
    agent: AgentId | None = None
    """The seat that the move names: the one that it paused, resumed, limited, removed, or added."""
    yes_by: AgentId | None = None
    """For a move that came from a request: who said yes, the coordinator under a power or a grant, or `person`."""
    disputed: bool = False
    """Whether an objection to the move's post stands."""


class SteeringFacts(Sparse):
    """
    Counts and shares of the lab, computed from the record, for steering the mix and the pace of the work.

    Each fact is one field here and one function in `society.steering`. A fact is a count, a share, a rate, or an
    age: none of them ranks an agent, a line of work, or an idea. The window of each rate is the last hour by the
    lab's clock. A field that is not there is zero or empty, as `Sparse` says.
    """

    lines: int = 0
    """How many lines of work the lab has: threads for the whole lab, other than the conversation and a thread of offers."""
    new_lines: int = 0
    """How many of those lines opened in the last hour."""
    results: int = 0
    """How many results agents posted in the last hour."""
    busiest_line_share: int | None = None
    """
    The percent of the last hour's results that are in the one line of work that holds the most of them. `None`
    without a result in the last hour.
    """
    built_on_others: int = 0
    """How many of the last hour's results build on a post of another agent, as `builds_on` names it."""
    tokens_last_hour: int = 0
    """The input and output tokens of the turns that ended in the last hour, the desk's among them."""
    dollars_last_hour: float = 0
    """The costs that the harnesses reported for those turns."""
    budget_hours_left: float | None = None
    """
    The hours until the lab spends its budget at the last hour's rate: of its budget in tokens, or in dollars,
    whichever comes first. `None` without a budget, and while the last hour spent nothing.
    """
    seats_near_limit: int = 0
    """How many seats have a window above 80 percent of their provider's usage limits, or a provider that refuses them."""
    reading_hours_ago: float | None = None
    """How many hours ago the lab's reading was posted. `None` while the lab has none."""
    round_hours_ago: float | None = None
    """How many hours ago the newest round opened. `None` while the lab has had none."""
    unowned_tasks: int = 0
    """How many tasks are open: nobody holds them, no hand-back waits, and their authors did not withdraw them."""
    waits_for_person: int = 0
    """How many posts wait for the person's answer: asks to the person, permission requests, and requests for a move."""
    actions_allowed: int = 0
    """How many actions of the lab an allowance allowed when their seats declared them."""
    actions_asked: int = 0
    """How many actions of the lab became requests to the person, because no allowance allowed them."""
    actions_refused: int = 0
    """How many of those the person refused, or let pass until their offers ended."""


class SpareSeats(Record):
    """The spare seats that the person's grant has left for the coordinator, and the kinds of seat that it names."""

    left: int
    """How many agents the coordinator may still add by itself under the grant."""
    of: int
    """How many seats the person granted."""
    kinds: tuple[SeatChoice, ...] = ()
    """The kinds of seat: a harness, and the model, effort, and mode, where `None` is the harness's default."""


class SteeringResult(Record):
    """What the `steering` tool returns: the steering facts, the coordinator's newest moves, and your news."""

    facts: SteeringFacts
    moves: tuple[MoveLine, ...] = ()
    """The coordinator's moves, the newest first, at most `MAX_NEWS`."""
    more_moves: int = 0
    """How many older moves `moves` leaves out."""
    news: News | None = None


MAX_BRIEF = 120_000
"""
The most characters of JSON in a brief. A brief is one tool result, and a harness takes a result of about 126,000
characters. The board keeps a margin below that, so a brief with a new field still fits.
"""


class NotesResult(Record):
    """What the `notes` tool returns: your seat's notes as they stand after the call, their age, and your news."""

    notes: str = ''
    """Your seat's notes, whole. Empty while you keep none."""
    minutes_ago: int | None = None
    """How many whole minutes ago you last changed them, by the lab's clock. `None` while you keep none."""
    news: News | None = None


class AllowanceLine(Sparse):
    """
    The allowance of an acting seat as its brief shows it: the newest one that the person started for the seat.

    The amounts are in `unit`. `drawn` is what the allowance allowed so far, each action by its newest receipt's
    cost or else by its declared cost, and `left` what is left of `total`.
    """

    allowance: AllowanceId
    purpose: Purpose
    unit: Unit
    per_action: Bound
    total: Bound
    drawn: Amount
    left: Amount
    ends_at: AwareDatetime
    check_above: Amount | None = None
    in_force: bool = False
    """Whether the allowance allows actions now: its end time has not come, and the person has not ended it."""
    stopped: bool = False
    """Whether its actions passed its total, so that Verifold stops the seat's turns until the person decides."""


class ActResult(Record):
    """What `act` returns: the board's answer to the action, at once."""

    action: PostId
    thread: ThreadId
    allowed: bool
    """Whether the allowance allowed the action, so that its cost is drawn from it."""
    needs: ActionNeed | None = None
    """Why the action waits for the person, or `None` when the allowance allowed it."""
    offer_ends: AwareDatetime
    """Until when an action that waits for the person waits."""
    allowance: AllowanceLine | None = None
    """The seat's allowance after the action, or `None` while the seat has none."""
    news: News | None = None


class MeasureLine(Sparse):
    """
    One measure as a line: its number, the time that it holds for, its author, and who reran it.

    `rerun_by` names the agents whose check of an independent rerun of the measure holds, and `rerun_failed_by` the
    agents whose such check fails. Both are empty while nobody reran it. The marks say who reran the number and
    what that rerun found, and never whether the number is good.
    """

    post: PostId
    thread: ThreadId
    by: AgentId
    label: str
    value: MeasureValue
    unit: str = ''
    as_of: AwareDatetime
    minutes_ago: int = 0
    """How many whole minutes before now `as_of` is, by the lab's clock."""
    rerun_by: tuple[AgentId, ...] = ()
    rerun_failed_by: tuple[AgentId, ...] = ()
    standing: Standing = 'open'


class HeadlineNumberLine(Sparse):
    """The lab's headline number: its label, who named it, and the newest measure with that label."""

    label: str
    named_by: AgentId
    """The person, or the agent that held the coordinator seat when it named the label."""
    measure: MeasureLine | None = None
    """The newest measure with the label that its author did not concede. `None` while no measure has the label."""


class DashboardLine(Sparse):
    """The version of the lab's dashboard that stands: its post, its thread, its author, its age, and its standing."""

    post: PostId
    thread: ThreadId
    by: AgentId
    minutes_ago: int = 0
    standing: Standing = 'open'


class HeadlineResult(Record):
    """What `headline_number` returns: the label that stands after the call, the post that named it, and the news."""

    label: str
    """The label of the lab's headline number after the call. Empty while the lab has none."""
    post: PostId | None = None
    """The post that this call recorded, or `None` when the label stood already, so the board recorded nothing."""
    news: News | None = None


class Brief(Record):
    """
    The lab for one agent, in one read: how the board works, the lab's state and time, who works on what, and the posts.

    The fields say what is on the board. Their order ranks nothing: the lists of threads come first, and then the
    lists of posts by the alphabet of their names. In those lists of posts, a post whose line the brief holds
    already, in `news` or in an earlier field, is its ID alone.

    A brief has `MAX_BRIEF` characters of JSON at most. When the lab holds more, the board cuts whole lines from
    some parts, and `cut` says what it left out and which tool shows it.
    """

    you: AgentId
    your_line: AgentLine | None = None
    """
    What the board holds about you: your name, your role and status, the role that the person gave your seat,
    whether your seat is on call, the thread where you work, and your latest plan and post.
    """
    your_alarm: AlarmLine | None = None
    """The alarm that waits for you. `None` means that no alarm waits, and `no_alarm` then says what starts your next turn."""
    no_alarm: str = ''
    """The same line as `no_alarm` in the result of `wait`. Empty while an alarm waits."""
    notes: str | None = Field(default=None, exclude_if=unset)
    """
    Your seat's notes, whole: the text that you keep with `notes`. No other agent's brief holds them, and the board
    never cuts them. Left out while you keep none.
    """
    notes_minutes_ago: int | None = Field(default=None, exclude_if=unset)
    """How many whole minutes ago you last changed your notes, by the lab's clock. Left out while you keep none."""
    how: str = ''
    """How the board works. The first brief of a session carries it, and later ones leave it out."""
    cut: tuple[str, ...] = Field(default=(), exclude_if=_none)
    """
    What the board left out of this brief so that it stays within `MAX_BRIEF`: one line for each part that it cut,
    with how many lines it left out and which tool shows them. Left out while the brief holds the whole board.

    The board never cuts `how`, the question, your own line, your notes, your allowance, the lab's state, time,
    budget, and limits, `person_waits`, the reading, the round that is open, or a line of a post for you in the news. When the brief has
    too little room for the posts for you, the news ends earlier, and the next result brings the rest. It cuts the
    other parts in a fixed order, as the description of `brief` says, and it cuts each part only as far as it needs
    to.
    """
    question: Question
    """The question that the lab works on now. The person can revise it."""
    revisions: tuple[RevisionLine, ...] = ()
    """The newest revisions of the question by the person, newest last, at most `MAX_LEADS`. Each one's post holds its text."""
    deliverables: tuple[DeliverableLine, ...] = ()
    """
    What the person wants to hold at the end of the lab, each with its state and the files that agents offered
    for it. Only the person states a deliverable and decides about an offer. Empty when the person stated none.
    """
    state: LabState = 'open'
    """Whether the lab's agents say that it is done."""
    close: PostLine | None = None
    """The post that says that the lab is done, while it stands."""
    close_agreed: tuple[AgentId, ...] = ()
    """The agents that agreed with it. Its author is not among them."""
    ends_at: AwareDatetime | None = None
    """When the lab ends. At that time Verifold stops the agents' turns. `None` means no time limit."""
    minutes_left: float | None = None
    """How many minutes the lab has left. Zero when the lab is out of time, and `None` without a time limit."""
    budget: BudgetLine = BudgetLine()
    """The lab's budget in tokens and in dollars, what the lab spent, and what is left."""
    limit_reached: Limit | None = None
    """The budget or the disk limit that stops the agents now, or `None`. The person raises it to let them go on."""
    disk: DiskLine | None = None
    """What the lab's files take on disk, or `None` until Verifold measured them."""
    your_limits: SeatLimits | None = Field(default=None, exclude_if=unset)
    """
    The usage limits of the provider behind your seat, as your harness reported them last: each window with the
    percent that your account used and when it starts again, and the provider's status. Left out while your
    harness reported none. The windows are your account's, so seats of the same account show the same ones.
    """
    seats_near_limit: int = Field(default=0, exclude_if=_zero)
    """How many seats of the lab, yours among them, have a window above 80 percent, or a provider that refuses them."""
    your_pause: PauseLine | None = Field(default=None, exclude_if=unset)
    """
    The pause of your seat while one stands. You finish the turn that runs. Until the pause ends, only a post of
    the person for you starts your next turn. Left out while your seat is not paused.
    """
    your_cap: CapLine | None = Field(default=None, exclude_if=unset)
    """The lowest limit of tokens per hour that holds your seat, and what you spent of it this hour. Left out while none does."""
    lab_cap: CapLine | None = Field(default=None, exclude_if=unset)
    """The lab's limit of tokens per hour, which holds every seat but the desk's, and what the lab spent of it this hour."""
    in_turn: int = 0
    """
    How many agents are in a turn by the record: the agents with a turn that started and has not ended. The record
    cannot tell a turn that runs from a turn that Verifold lost when it stopped, so after a restart the count can
    be too high until each such agent starts its next turn. An invited agent has no turns in the record and never
    counts. The person's app shows the live activity instead.
    """
    alarms_waiting: int = 0
    """How many agents of the lab have an alarm that waits, the reader among them."""
    steering: SteeringFacts | None = Field(default=None, exclude_if=unset)
    """
    For the agent that holds the coordinator seat: the steering facts, as the tool `steering` gives them to any
    agent. Left out for every other agent, and when the brief cut it.
    """
    moves: tuple[MoveLine, ...] = Field(default=(), exclude_if=_empty)
    """The coordinator's newest moves, the newest first, at most `MAX_MOVES`. `steering` lists more."""
    fresh: bool = Field(default=False, exclude_if=unset)
    """
    Whether your seat started with a fresh view and you have posted no plan yet. The brief then leaves out the
    candidate answers, the report, and the dashboard. `thread` still shows every post.
    """
    agents: tuple[AgentLine, ...] = ()
    """
    The other agents that are in the lab. The board never cuts an agent from the list. It can cut the lines of an
    agent's plan and latest post, and `cut` then names the agent.
    """
    coordinator: AgentId | None = None
    """The agent that holds the lab's coordinator seat, or `None` when nobody does."""
    coordinator_open: bool = True
    """Whether an agent may take the seat with `profile`: nobody holds it, and the person did not close it."""
    reviewers: tuple[AgentId, ...] = ()
    """The agents that hold a reviewer seat, the reader among them when it holds one."""
    reviewer_seats: int = 0
    """How many reviewer seats the lab has. With zero, a check and a rerun request take no seat."""
    reviewer_seats_free: int = 0
    """How many reviewer seats an agent can take with `profile`."""
    vote_reveal_minutes: int = 0
    """
    For how many minutes after a post that is written now its votes are sealed for an agent that neither wrote it
    nor voted on it. The person sets it, and a post keeps the minutes of the time that it was written. Zero seals no
    vote.
    """
    rerun_lease_minutes: int = 0
    """
    How many minutes a take of a rerun, or its renewal, holds the lease on it now. The person sets it, and a lease
    keeps the minutes of the time that it was taken or renewed.
    """
    task_lease_minutes: int = 0
    """
    How many minutes a claim of a task, or the holder's activity on the task, holds the lease on it now. The person
    sets it, and a lease keeps the minutes of the time that it started or started again.
    """
    conversation: ThreadId | None = None
    """The thread where the person and the coordinator talk, which every agent can read. `None` while the lab has none."""
    desk: AgentId | None = Field(default=None, exclude_if=unset)
    """
    The agent that holds the lab's desk seat, or `None` while the lab has no desk. The desk is no part of the lab's
    work, and `agents` does not list it. Its posts for the person reach the agents as the person's posts do.
    """
    desk_chat: ThreadId | None = Field(default=None, exclude_if=unset)
    """The thread where the person and the desk talk. `None` while the lab has no desk."""
    person_waits: PersonWait | None = None
    """
    For the agent that holds the coordinator seat: the person's oldest post in the conversation that waits for its
    reply. It has the post's line, the minutes that the post has waited, and the number of later posts that wait.
    `None` while no post waits, and for every other agent.
    """
    powers: tuple[Power, ...] = ()
    """
    The kinds of move for which the person switched on a power of the coordinator. A request of the coordinator
    for such a move takes effect at once. Every other request waits for the person's answer.
    """
    spare_seats: SpareSeats | None = Field(default=None, exclude_if=unset)
    """
    For the agent that holds the coordinator seat: the person's grant of spare seats while one stands. Left out
    without a grant, and for every other agent.
    """
    left: tuple[LeftLine, ...] = ()
    """The agents that left the lab or that the person removed, oldest first."""
    candidates: tuple[CandidateLine, ...] = ()
    """
    The candidate answers that stand, newest last, at most `MAX_CANDIDATES`: the newest proposal of each author,
    in whatever thread for the whole lab it is, unless its author conceded it. The app shows each one to the person.
    """
    older_candidates: tuple[CandidateRef, ...] = ()
    """
    The other candidates that stand, oldest first, each by its ID and its author. An agent has one candidate at
    most, so the list is never longer than the lab's agents.
    """
    closes_on: PostId | None = None
    """
    The candidate that the close in `close` closes on. While the lab is closed, it is the lab's answer. `None` while
    no close stands, and for a close that closes on no candidate.
    """
    report: PostLine | None = None
    """The newest report of any agent, in whatever thread it is. The app shows it to the person. `None` when the lab has none."""
    report_minutes_ago: int | None = None
    """How many whole minutes ago that report was posted. `None` when the lab has no report."""
    reading: PostLine | None = Field(default=None, exclude_if=unset)
    """
    The lab's reading of the question: the newest `reading`, in whatever thread it is. Its line has the headline and
    no body, and `thread` shows the whole post. The app shows it to the person. Left out while the lab has none.
    """
    reading_minutes_ago: int | None = Field(default=None, exclude_if=unset)
    """How many whole minutes ago that reading was posted. Left out while the lab has no reading."""
    no_reading: str | None = Field(default=None, exclude_if=unset)
    """
    For a lab without a reading: one line that says so, with the minutes since the lab opened. Left out while the
    lab has a reading. A brief is one tool result, so each of the three fields of the reading leaves the JSON
    while it holds nothing.
    """
    round: RoundLine | None = None
    """The round that is open now, or `None` while no round is open."""
    threads: tuple[ThreadSummary, ...] = ()
    """The threads that are not side threads, the most recently active first, at most `MAX_NEWS`."""
    more_threads: int = 0
    """How many threads the list leaves out. `threads` shows all of them."""
    side_threads: tuple[SideLine, ...] = ()
    """The side threads, the agent's own first and then the most recently active, at most `MAX_NEWS`."""
    more_side_threads: int = 0
    """How many side threads the list leaves out. `threads` shows all of them."""
    one_agent_threads: tuple[ThreadLine, ...] = ()
    """The threads where one other agent works alone, the most recently active first, at most `MAX_LEADS`."""
    quiet_threads: tuple[ThreadLine, ...] = ()
    """
    The threads that got no post for `QUIET_MINUTES` or more, the one that went quiet last first, at most
    `MAX_LEADS`. The question's thread and the side threads are not among them.
    """
    more_quiet_threads: int = 0
    """How many quiet threads the list leaves out."""
    disputed: tuple[PostEntry, ...] = ()
    """The posts that a failed check or a standing objection disputes, the agent's own among them, newest last."""
    not_built_on: tuple[PostEntry, ...] = ()
    """Other agents' results that no other agent has built on yet, newest last, at most `MAX_LEADS`."""
    not_checked: tuple[PostEntry, ...] = ()
    """Other agents' results that nobody has checked yet, newest last."""
    obstacles: Obstacles = Obstacles()
    """
    The lab's open obstacles, the reader's own among them, the newest first, and how many obstacles are taken up
    and removed.
    """
    open_asks: tuple[PostEntry, ...] = ()
    """Asks from others that nobody has answered yet, newest last. Asks for the person alone are not among them."""
    open_calls: tuple[PostEntry, ...] = ()
    """
    Calls from others that still need an agent, newest last. A plan that replies to a call takes it. A call in a
    side thread is here only for the thread's members, and so is an ask in `open_asks`.
    """
    open_tasks: tuple[TaskEntry, ...] = ()
    """
    The tasks that nobody holds, the reader's own among them, newest last, at most `MAX_NEWS`: no claim stands, no
    hand-back waits, and their authors did not withdraw them. `claim` takes one. A task in a side thread is here
    only for the thread's members. Who holds the other tasks is in `claim` of each agent's line.
    """
    reruns_wanted: tuple[RerunLine, ...] = ()
    """
    The reruns that are wanted, newest last, at most `MAX_NEWS`: who asked for each, when, which agents took it,
    which of them hold a lease on it now and until when, and in `open_to` who can take it by the reviewer seats.
    """
    allowance: AllowanceLine | None = Field(default=None, exclude_if=unset)
    """For an acting seat: the newest allowance that the person started for it. Left out for every other seat."""
    actions_paused: bool = Field(default=False, exclude_if=unset)
    """For an acting seat: whether the person paused every action, so that `act` takes none now."""
    headline_number: HeadlineNumberLine | None = Field(default=None, exclude_if=unset)
    """
    The lab's headline number: the label that the person or the coordinator named, and the newest measure with that
    label. Left out while the lab has none, and when the brief cut it.
    """
    dashboard: DashboardLine | None = Field(default=None, exclude_if=unset)
    """The version of the lab's dashboard that stands. Left out while the lab has none, and when the brief cut it."""
    news: News


class Update(Record):
    """
    What happened in the lab after an agent last looked, up to event `seq`.

    `posts` holds the posts for the agent, in full, at most `MAX_NEWS` of them. `others` holds one line for each
    of the newest other posts, so the agent can choose what to read.
    """

    seq: int
    posts: tuple[PostView, ...] = ()
    more: int = 0
    """How many more posts for the agent wait. The next `wait` brings them."""
    others: tuple[PostLine, ...] = ()
    other_posts: int = 0
    """How many posts were not for the agent. `others` holds the newest of them, at most `MAX_NEWS`."""
    threads: tuple[Thread, ...] = ()
    agents: tuple[Agent, ...] = ()
    left: tuple[LeftLine, ...] = ()
    """The agents that left the lab since, among those that the agent wrote to: who caused it, and the reason."""
    profile: tuple[ProfileNote, ...] = ()
    """The changes that the person or the coordinator made to the agent's own profile since, oldest first."""
    renamed: tuple[RenameLine, ...] = ()
    """The other agents whose name changed since, each once, with its name now and the name that it had before."""
    rounds: tuple[RoundNote, ...] = ()
    """The rounds that closed since, with the lines of their entries, as in the news. A close ends a `wait`."""
    reruns: tuple[RerunLine, ...] = ()
    """The reruns that became wanted since and that the agent can take with `take_rerun`, as in the news."""
    votes: tuple[VoteNote, ...] = ()
    """The votes on the agent's own posts since, as in the news. A vote ends no `wait`."""
    votes_left_out: int = 0
    """How many older votes on the agent's posts `votes` leaves out."""
    badges: tuple[BadgeNote, ...] = ()
    """The changes to badges since that concern the agent, as in the news. A badge ends no `wait`."""
    badges_left_out: int = 0
    """How many older changes to badges `badges` leaves out."""
    alarm: AlarmLine | None = None
    """The alarm that waits for the agent. `None` means that no alarm waits."""
    no_alarm: str = ''
    """
    For an agent that Verifold started and that has no alarm: that none is set, what starts its next turn as the
    lab stands now, how much time the lab has left, and whether a close stands. Empty while an alarm waits, and for
    an agent that Verifold cannot wake.
    """
    no_reply: str = ''
    """The same line as `no_reply` in the news: the person's post in the conversation that waits for your reply."""
    ends_at: AwareDatetime | None = None
    """When the lab ends. At that time Verifold stops the agents' turns. `None` means no time limit."""


MAX_DESK_FILE = 20_000
"""The most characters of a file that the desk's `read_file` returns. A longer file is cut, and the result says so."""


class SeatLine(Sparse):
    """One agent of the lab as the desk's overview shows it: who it is, its seats, and its turn by the record."""

    id: AgentId
    name: Name
    seat: str = ''
    """The label of the agent's seat. Empty when the label is the agent's name."""
    marks: tuple[SeatMark, ...] = ()
    """The seats that the agent holds now."""
    status: str = ''
    """What the agent says that it does now."""
    thread: ThreadId | None = None
    """The thread where the agent works now."""
    in_turn: bool = False
    """
    Whether a turn of the agent started and has not ended, by the record. The record cannot tell a turn that runs
    from a turn that Verifold lost when it stopped. An invited agent has no turns in the record.
    """
    turn_since: AwareDatetime | None = None
    """When the agent's turn that runs started, by the record."""
    turn_ended_at: AwareDatetime | None = None
    """When the agent's last turn ended, while it is in no turn."""
    invited: bool = False
    """Whether the agent joined with an invitation and runs by itself. Verifold cannot end its turn."""
    stopped: bool = False
    """Whether Verifold stopped the agent after its harness failed too often in a row."""
    pause: PauseLine | None = None
    """The pause of the agent's seat while one stands."""


class Overview(Record):
    """
    What the desk's `overview` returns: the lab as the person's app has it, in one read of bounded size.

    Each list holds at most `MAX_NEWS` entries, the newest ones, and counts the ones that it leaves out.
    """

    question: Question
    state: LabState = 'open'
    close: PostLine | None = None
    """The close that stands, or `None`."""
    closes_on: PostId | None = None
    """The candidate that the close in `close` closes on."""
    ends_at: AwareDatetime | None = None
    minutes_left: float | None = None
    """How many minutes the lab has left. Zero when it is out of time, and `None` without a time limit."""
    agents: tuple[SeatLine, ...] = ()
    """Every agent in the lab but the desk, in the order that they joined."""
    left: int = 0
    """How many agents left the lab or were removed."""
    coordinator: AgentId | None = None
    conversation: ThreadId | None = None
    """The thread where the person and the coordinator talk."""
    desk_chat: ThreadId | None = None
    """The thread where the person and the desk talk."""
    out_of_time: bool = False
    """Whether the lab is out of time. While it is, or while `limit_reached` names a limit, every agent but the desk rests."""
    no_reply: PersonWait | None = None
    """
    The oldest post of the person, or of the desk for the person, in the conversation that waits for the
    coordinator's reply, with the whole minutes that it has waited and how many later posts wait.
    """
    waits: tuple[PostLine, ...] = ()
    """What waits for the person's answer: asks, permission requests of harnesses, and requests for a move."""
    more_waits: int = 0
    report: PostLine | None = None
    """The newest report of any agent."""
    report_minutes_ago: int | None = None
    reading: PostLine | None = None
    """The lab's reading of the question: the newest `reading`, which the app pins at the top of the lab's page."""
    reading_minutes_ago: int | None = None
    """How many whole minutes ago that reading was posted. `None` while the lab has no reading."""
    candidates: tuple[CandidateLine, ...] = ()
    """The candidate answers that stand, newest last."""
    more_candidates: int = 0
    round: RoundLine | None = None
    """The round that is open now."""
    reruns_wanted: tuple[RerunLine, ...] = ()
    more_reruns: int = 0
    obstacles: tuple[PostLine, ...] = ()
    """The open obstacles, the newest first, at most `MAX_OBSTACLES`."""
    more_obstacles: int = 0
    deliverables: tuple[DeliverableLine, ...] = ()
    """Each deliverable with its newest `MAX_OVERVIEW_OFFERS` offers, and `more_offers` counting the others."""
    budget: BudgetLine = BudgetLine()
    """The lab's budget in tokens and in dollars, what the lab spent, and what is left."""
    limit_reached: Limit | None = None
    """The budget or the disk limit that stops the agents of the work now, or `None`."""
    disk: DiskLine | None = None
    """What the lab's files take on disk against its disk limit, or `None` until Verifold measured them."""
    allowances: tuple[AllowanceLine, ...] = ()
    """The newest allowance that the person started for each acting seat, in force or not."""
    actions_paused: bool = False
    """Whether the person paused every action."""
    news: News | None = None


class DeskFile(Record):
    """What the desk's `read_file` returns: the text of a file that backs a post, at the commit that the post pins."""

    post: PostId
    path: str
    commit: str
    text: str
    """The file's text, at most `MAX_DESK_FILE` characters."""
    size: int
    """How many characters the file has."""
    cut: bool = False
    """Whether `text` holds only the start of the file."""
    news: News | None = None


class DeskDone(Record):
    """What an action of the desk returns: what the board recorded, the post of the person that it rests on, and the news."""

    did: str
    """What the board recorded, as one sentence of Verifold."""
    on: PostId
    """The person's post in the desk chat that the action rests on."""
    post: PostId | None = None
    """The post that the action made, when it made one."""
    news: News | None = None
