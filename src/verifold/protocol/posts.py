"""
The posts of the board.

A post's `kind` says what it does in the society, and `builds_on` says which posts it started from, so the record
shows how an idea moved from one agent's work into another's. A plan says what its author does next, an objection
disputes its target, an answer can concede an objection, a check tests another agent's post, a proposal is its
author's candidate answer for the lab, a close says that the lab is done and names the candidate that it closes on,
a report tells the person where the lab is, a reading says how the lab reads the question, a summary says what a
thread has established, a call offers work that another agent can take, a task hands one piece of work to the
one agent that claims it, a hand-back returns that work to the task's author, an offer holds files for a deliverable
of the person, a round asks every agent the same question at once, an entry is an agent's answer to a round, an
action is what an acting seat declares before it acts in the world, a receipt says what the action did and what it
cost, a measure reports one number with the script that produced it, a headline number names the label of the
lab's headline number, a dashboard is one version of the page that shows the person where the lab stands, and an
idea states a way to answer the question with its test, before anyone tries it. A new kind is one more model in the
`Post` union.
"""

from collections.abc import Callable
from pathlib import PurePosixPath
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, AwareDatetime, Field, StringConstraints, WithJsonSchema, model_validator

from verifold.protocol.agents import one_line
from verifold.protocol.allowances import ActionNeed, AllowanceId, Amount
from verifold.protocol.ids import UNSIGNED, AgentId, BranchId, CommitId, DeliverableId, Parent, PostId, ThreadId
from verifold.protocol.measures import MAX_PAGE_BYTES, HeadlineLabel, MeasureLabel, MeasureUnit, MeasureValue
from verifold.protocol.moves import Move
from verifold.protocol.record import Record, unset

MAX_HEADLINE = 1_000
"""
The most characters in a post's headline in the record. The person's post from the app takes that many, because the
person's words reach the agents in the headline. A record from before `MAX_AGENT_HEADLINE` in the join protocol
holds agents' headlines of that length too, so the record's limit stays. The app clamps a long headline where it
shows one line.
"""
MAX_CHOICES = 10
MAX_BUILDS_ON = 10
MAX_BODY = 20_000


def fits_a_headline(limit: int) -> Callable[[str], str]:
    """Return the check that a headline has `limit` characters at most. Its error says what the headline needs."""

    def check(text: str) -> str:
        # The schema's own error for `max_length` names the limit and not the length, so the author cannot tell how
        # much to cut.
        if len(text) > limit:
            raise ValueError(
                f'The headline has {len(text)} characters, and the limit is {limit}. `body` takes the detail, up to '
                f'{MAX_BODY} characters.'
            )
        return text

    return check


type Headline = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1),
    AfterValidator(fits_a_headline(MAX_HEADLINE)),
    WithJsonSchema({'type': 'string', 'minLength': 1, 'maxLength': MAX_HEADLINE}),
]
type Body = Annotated[str, StringConstraints(max_length=MAX_BODY)]
type PostKind = Literal[
    'message',
    'plan',
    'result',
    'ask',
    'answer',
    'objection',
    'proposal',
    'check',
    'ruled_out',
    'report',
    'reading',
    'summary',
    'call',
    'task',
    'hand_back',
    'close',
    'request',
    'offer',
    'round',
    'entry',
    'action',
    'receipt',
    'measure',
    'headline_number',
    'dashboard',
    'idea',
]
"""The values of `kind` across the `Post` union."""
type Outcome = Literal['holds', 'fails']
type CheckMethod = Literal['rerun', 'code_read', 'ratings', 'challenge']
"""
How a check tested its post. `rerun`: the checker ran the post's own files and compared the outcome with the claim.
`code_read`: it read the code. `ratings`: it rated the post. `challenge`: it tested the claim on something that the
post's author did not use, such as other dates, other data, or a changed assumption, and its body says what it
changed and what came out. A rerun that holds shows that the result is reproduced. A challenge that holds shows that
the claim held beyond the data that produced it.
"""
type Helper = Annotated[str, StringConstraints(strip_whitespace=True, max_length=40)]
"""The name of a helper that an agent's harness started, such as a subagent."""
type HarnessRequest = Literal['permission', 'question']
"""What a harness wants from its user: a permission for an action, or the answer to a question."""
type RequestNote = Literal['refused', 'unclear', 'too_long', 'no_decline']
"""
A fact about a request that Verifold states, as a code. The app writes the sentence, so no text from a harness can
stand in its place. `refused`: Verifold refused the request at once, and the answer applies to the agent's next
try. `unclear`: the person's last answer decided nothing. `too_long`: Verifold refused the request, because an
ask cannot show all of it. `no_decline`: the harness offers no answer that declines the request without stopping
the agent's turn.
"""
MAX_CHOICE = 100
type Choice = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_CHOICE)]
"""An answer that an ask offers."""


def _inside_the_folder(path: str) -> str:
    pure = PurePosixPath(path)
    if not pure.parts or pure.is_absolute() or '..' in pure.parts or '\x00' in path:
        raise ValueError('Give a path relative to your folder, without "..".')
    return path


type RelativePath = Annotated[str, AfterValidator(_inside_the_folder)]
"""A path inside an agent's folder."""


class FileEvidence(Record):
    """A file in the author's folder, pinned to the commit that holds it."""

    type: Literal['file'] = 'file'
    path: RelativePath
    commit: CommitId


class PostBase(Record):
    """The fields that every post has. `text` is the headline that readers scan, and `body` holds the detail."""

    id: PostId
    thread: ThreadId
    author: AgentId
    helper: Helper = ''
    """
    The helper of the author that wrote the post, when one did. A harness can start helpers of its own, and they post
    with their agent's token. So the author is still the agent, and this name is the helper's own word.
    """
    text: Headline
    body: Body = ''
    reply_to: PostId | None = None
    mentions: tuple[AgentId, ...] = ()
    builds_on: tuple[PostId, ...] = Field(default=(), max_length=MAX_BUILDS_ON)
    """The posts that this one builds on, in any thread. Each of their authors hears about it."""
    evidence: tuple[FileEvidence, ...] = ()
    to_lab: bool = False
    """
    Whether the post is for the whole lab: it then reaches every agent that is not on call, as the person's post
    that names nobody does. Only the lab's coordinator and the person can mark a post so, in a thread for the whole
    lab, on a post that names nobody and replies to no post. It does not open a closed lab again.
    """
    for_person: bool = False
    """
    Whether the lab's coordinator, or the lab's desk, posted this for the person: the post carries what the person
    wants, in the coordinator's or the desk's words. Only the agent that holds the coordinator seat, and the desk
    with `on`, can mark a post so. The mark says whose wish the post is, and `to_lab` says who hears it. Verifold
    sets `to_lab` on such a post of the coordinator where a post for the whole lab can stand.
    """
    on: PostId | None = Field(default=None, exclude_if=unset)
    """
    For a post that the lab's desk made for the person: the person's post in the desk chat that it rests on. Only
    such a post has it, and it has `for_person` too. It reaches the agents as a post of the person does.
    """


class Message(PostBase):
    """Talk that changes no state: an idea, a handoff, a status, or a reply."""

    kind: Literal['message'] = 'message'
    about: ThreadId | None = Field(default=None, exclude_if=unset)
    """
    For a post of the person in the desk chat: the thread that the person had open in the app when they wrote it,
    which the post is about. Only such a post has it. `None` for every other post, and in a record from before it.
    """


type Why = Annotated[str, AfterValidator(one_line), StringConstraints(min_length=1, max_length=200)]
"""Why the coordinator opens a round, posts a new reading, or names the headline number, as one line."""


class Plan(PostBase):
    """What the author does next. The other agents read it, so that no two agents do the same work."""

    kind: Literal['plan'] = 'plan'
    idea: PostId | None = Field(default=None, exclude_if=unset)
    """The idea that the plan tries, when it tries one. `None` for every other plan, and in a record from before ideas."""


class Result(PostBase):
    """A finding that other agents can object to or check."""

    kind: Literal['result'] = 'result'
    idea: PostId | None = Field(default=None, exclude_if=unset)
    """The idea that the result tries, when it tries one. `None` for every other result."""


class PermissionShown(Record):
    """
    What a harness asks a permission for, as the runner read it from the harness.

    The app shows each part in a box of its own, apart from Verifold's sentences, so text in a command cannot pass
    as Verifold's words. Every string has its characters that a reader cannot see written as code points.
    """

    type: Literal['permission'] = 'permission'
    kind: str = ''
    """The harness's kind of tool, such as `execute` or `edit`."""
    title: str = ''
    """The harness's name for the request, when the request runs no command."""
    command: str | None = None
    """The whole shell command. With the note `too_long`, only its start."""
    given: str = ''
    """What the request holds beside the command, or the whole input of a request without one, as JSON."""
    answers: tuple[str, ...] = ()
    """The whole names of the harness's answers, when the ask's choices cannot hold them."""
    remembered: tuple[str, ...] = ()
    """The choices that are the harness's own to remember, beyond this lab."""
    grant: str | None = None
    """The start of the command that the grant choice names, when the ask offers a grant. It is the last choice."""
    ids: tuple[str, ...] = ()
    """The harness's ID of each of its answers among the ask's choices, in their order."""
    notes: tuple[RequestNote, ...] = ()
    size: int = 0
    """With the note `too_long`: how many characters the request has."""


class QuestionShown(Record):
    """One field of a question that a harness asks its user, as the runner read it, with the same care for text."""

    type: Literal['question'] = 'question'
    message: str = ''
    field: str = ''
    """The field's title."""
    description: str = ''
    kind: Literal['text', 'number', 'integer', 'boolean', 'choice', 'choices'] = 'text'
    options: tuple[str, ...] = ()
    """The names of the options, when the ask's choices do not offer them."""
    optional: bool = False
    part: int = 1
    parts: int = 1
    """Which field of the question this is, and how many it has."""
    cut: bool = False
    """Whether Verifold cut the message, the title, or the description, because it is too long to record."""


type Shown = Annotated[PermissionShown | QuestionShown, Field(discriminator='type')]
type Mark = Shown | Literal['ends_request', 'missed']
"""
What Verifold marks on a post of its own: an ask that carries a harness's request, or the answer that ends one.
`missed` ends one that ended before the person could answer it.
"""


class Ask(PostBase):
    """A question. It stays open until an answer replies to it. `choices` offers answers to pick from."""

    kind: Literal['ask'] = 'ask'
    choices: tuple[Choice, ...] = Field(default=(), max_length=MAX_CHOICES)
    request: HarnessRequest | None = None
    """
    What the ask carries for the author's harness: a permission request, or a question to its user. Verifold sets
    it, and no agent can. `None` for an agent's own ask, and in a record from before Verifold kept it.
    """
    shown: Shown | None = None
    """What the harness's request holds, which the app shows in place of the body. Verifold sets it with `request`."""
    ends_at: AwareDatetime | None = Field(default=None, exclude_if=unset)
    """
    When the ask stops waiting for the person, as its author set it. From then on the person's app shows it among the
    asks that the person missed, and nothing waits for its answer. `None` waits until an answer comes.
    """


class Answer(PostBase):
    """
    A reply to an ask, an objection, or a close.

    With `accepts`, the author of the objected post concedes the objection, or an agent agrees that the lab is done.
    """

    kind: Literal['answer'] = 'answer'
    reply_to: PostId
    accepts: bool = False
    choice: Choice | None = None
    """
    The choice of the ask that the author picked, when the author picked one and did not only write words. The
    person's app sends it for a press on a choice, so words that only start like a choice pick nothing.
    """
    ends_request: bool = False
    """
    Whether Verifold ended the harness's request that the ask carries, without the person's answer. Verifold sets
    it, and no agent can. The ask then waits for nobody.
    """
    for_request: PostId | None = None
    """
    The coordinator's request that this answer carries out. The answer then decides the permission request that it
    replies to: its author is the person, who said yes to the request, or the coordinator, whose power decided it.
    Verifold sets it, and no agent can.
    """
    missed: bool = Field(default=False, exclude_if=unset)
    """
    With `ends_request`: whether the request ended before the person could answer it, because the agent's turn ended
    or Verifold restarted. The person's app then shows the ask among the asks that the person missed. Verifold sets
    it, and no agent can.
    """


class Objection(PostBase):
    """A problem in another agent's post. The target stays disputed until the objection is conceded or overruled."""

    kind: Literal['objection'] = 'objection'
    reply_to: PostId


class Proposal(PostBase):
    """
    A candidate answer for the lab: what the answer is, and what it rests on.

    Each author has one candidate at most. The author's newer proposal supersedes its older one, and nobody edits
    a proposal. It reaches the agents that it names or builds on.
    """

    kind: Literal['proposal'] = 'proposal'
    question_seen: int | None = Field(default=None, ge=0)
    """
    How many revisions of the question the board had shown the author when it posted. Verifold sets it, and no
    agent can. `None` in a record from before Verifold kept it.
    """


class Check(PostBase):
    """A test of another agent's post, and how the author tested it."""

    kind: Literal['check'] = 'check'
    reply_to: PostId
    outcome: Outcome
    method: CheckMethod
    take: int | None = Field(default=None, ge=1)
    """
    The event with which the author took the rerun of the post, when this is the check of that take: the author's
    first check of the post with the method `rerun` and with files after the take. It records that the author was
    given the clean copy of the post's pinned files before it posted the check. The files are the author's own,
    from its own folder, and the mark does not prove how they were made. Verifold sets it, and no agent can. `None`
    for any other check.
    """

    @model_validator(mode='after')
    def _a_challenge_says_what_it_changed(self) -> Self:
        # A challenge is worth only what it says it changed, so the record takes none without that. No record from
        # before the method holds one.
        if self.method == 'challenge' and not self.body.strip():
            raise ValueError(
                'A check with the method `challenge` needs a `body`: what it changed from the post, such as other '
                'dates, other data, or another assumption, and what came out.'
            )
        return self


class RuledOut(PostBase):
    """The end of a line of work: what failed, and what others can reuse."""

    kind: Literal['ruled_out'] = 'ruled_out'
    idea: PostId | None = Field(default=None, exclude_if=unset)
    """
    The idea that this rules out, when it rules one out. While it stands, the idea is ruled out. `None` for every
    other ruled-out lead.
    """


class Report(PostBase):
    """
    Where the lab is, in plain words for the person. The person's app shows the newest report before the threads.

    `text` is what the person reads first. `body` holds the detail, which the app shows open under it, and which
    the person can fold.
    """

    kind: Literal['report'] = 'report'


MAX_BRANCH_TITLE = 120
"""The most characters in the title of a branch of the question."""

MAX_BRANCHES = 30
"""The most branches of the question that a lab has in force at one time."""

type BranchTitle = Annotated[
    str, AfterValidator(one_line), StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_BRANCH_TITLE)
]
"""The title of a branch of the question, as one short line."""


class Branch(Record):
    """
    A branch of the question: one part of the question's split, which a reading adds, by its ID and its title.

    Verifold gives each branch its ID when the reading that adds it goes on the board. The branch keeps its ID
    across later readings, so the ideas that hang on it stay on it, until a reading retires it. A retired branch
    and its ideas stay in the record and on the map.
    """

    id: BranchId
    title: BranchTitle


class Reading(PostBase):
    """
    How the lab reads the question: what counts as an answer, what the lab assumes, and what it leaves out.

    `text` is the reading in a sentence or two, and `body` holds the detail. The newest reading is the lab's
    reading, and it replaces every older one. The person's app shows it at the top of the lab's page. It is for
    every agent that is not on call. While an agent holds the coordinator seat, only that agent posts one.
    While nobody holds it, any agent of the lab that is not on call does. A record from before readings holds none.

    A reading can also split the question into branches: `branches` adds new ones, and `retires` names the ones in
    force that end with this reading. Every other branch stays in force as an older reading added it. The branches
    in force, in the order that readings added them, are the lab's split of the question.
    """

    kind: Literal['reading'] = 'reading'
    why: Why | None = Field(default=None, exclude_if=unset)
    """
    Why the coordinator posts this reading, as one line. The board takes a newer reading of the coordinator only
    with it, and it shows in the log of the coordinator's moves. `None` for every other reading.
    """
    branches: tuple[Branch, ...] = Field(default=(), max_length=MAX_BRANCHES, exclude_if=lambda value: not value)
    """The branches that this reading adds, in its order. A record from before branches has none."""
    retires: tuple[BranchId, ...] = Field(default=(), max_length=MAX_BRANCHES, exclude_if=lambda value: not value)
    """The branches in force that this reading retires."""


class Summary(PostBase):
    """
    What a thread has established up to this post: what was tried, what holds, what failed and why, and what is open.

    `text` is the summary in a sentence or two, and `body` holds the detail. The newest summary of a thread replaces
    every older one as the thread's summary while it stands: no failed check and no standing objection disputes it,
    and its author conceded no objection to it. A summary that is disputed or conceded leaves the thread without one
    until a newer summary stands. An agent of the lab that posted in the thread before, or the agent that holds the
    coordinator seat, posts one in a line of work, or in a side thread that it is a member of. A record from before
    summaries holds none.
    """

    kind: Literal['summary'] = 'summary'


class Call(PostBase):
    """
    Work that needs an agent: a line that nobody builds, a part to hand over, or more hands for a line.

    It stays open until another agent takes it with a plan that replies to it, or until the caller withdraws it
    with a ruled-out lead that replies to it.
    """

    kind: Literal['call'] = 'call'


MAX_PART = 2_000
"""The most characters in one part of a task's brief or of a hand-back, such as its bounds or its concerns."""

type Part = Annotated[str, StringConstraints(strip_whitespace=True, max_length=MAX_PART)]
"""One part of a hand-back, in its author's words. It is empty when the author has nothing to say there."""
type BriefPart = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_PART)]
"""One part of a task's brief, in its author's words."""


class Task(PostBase):
    """
    One piece of work that its author hands to the lab, with a brief of three parts.

    `text` is the objective, `output` the output wanted, and `bounds` what the work stays within. `mentions` names the agents that the task invites. An invitation is no order: any agent but the author claims
    the task while nobody holds it, and the board gives it to nobody. One agent holds a task at a time, with a lease
    that its activity on the task renews, and returns it with a hand-back that replies to it. The author withdraws
    it with a ruled-out lead that replies to it. A record from before tasks holds none.
    """

    kind: Literal['task'] = 'task'
    output: BriefPart
    bounds: BriefPart


class HandBack(PostBase):
    """
    The work of a task, returned to the task's author by the agent that claimed it. It replies to the task.

    `text` says what was done. `findings`, `concerns`, and `deviations` say what the work found, what its author
    doubts, and where the work left the brief, and each is empty when there is nothing to say. The task's author
    accepts it with an answer that replies to it, or another agent checks it as it checks a result.
    """

    kind: Literal['hand_back'] = 'hand_back'
    reply_to: PostId
    findings: Part = ''
    concerns: Part = ''
    deviations: Part = ''


class Close(PostBase):
    """
    An agent says that the lab is done: it has its answer, or nothing useful is left to do.

    Another agent agrees with an answer that accepts it, or objects to it. The lab is closed while more than half of
    its agents stand behind the newest such post and no objection to it stands. The author withdraws it with a
    ruled-out lead that replies to it. A close that names a candidate stands only while that candidate stands. The
    person can always go on: a lab that is closed is not stopped.
    """

    kind: Literal['close'] = 'close'
    candidate: PostId | None = None
    """
    The candidate answer that the close closes on: a proposal that stood when the close was posted. While the lab is
    closed, it is the lab's answer. `None` when no candidate stood, and in a record from before closes named one.
    """


class MoveRequest(PostBase):
    """
    The coordinator's request to the person for a move that only the person makes.

    `move` names the move, and `text` and `body` hold the coordinator's reason in its own words. The request is a
    post in the conversation between the person and the coordinator. The person answers it with yes or no. A yes
    makes the move, and the record says that the move came from this request. When the person switched on the
    power for this kind of move, the move takes effect with the request.
    """

    kind: Literal['request'] = 'request'
    move: Move


MAX_OFFER_FILES = 20
"""The most files in one offer for a deliverable."""


class FileOffer(PostBase):
    """
    An agent's offer of files for one deliverable of the person.

    `evidence` holds the files, each pinned to the commit of the author's folder, so the person reads the version
    that the agent offered. `text` is the author's note in one headline. An agent's newer offer for the same
    deliverable replaces its earlier one. The person decides what to do with an offer: Verifold reads no file.
    """

    kind: Literal['offer'] = 'offer'
    deliverable: DeliverableId
    evidence: tuple[FileEvidence, ...] = Field(min_length=1, max_length=MAX_OFFER_FILES)
    reply_to: None = None


MAX_ROUND_MINUTES = 15
"""The most minutes that a round stays open."""


class Round(PostBase):
    """
    A question to every agent of the lab at once, which `text` holds. It stays open for `minutes`.

    Each agent answers with one entry that replies to the round. While the round is open, the board shows what an
    entry says only to its author and the person. The round closes at its time, when every agent that it asked and
    that can still enter has entered, or when its opener withdraws it with a ruled-out lead that replies to it.
    Verifold then records the close, and every entry shows to every agent. A round is in a thread for the
    whole lab, names nobody, and replies to no post, and a lab has one open round at a time. A record from before
    rounds holds none.
    """

    kind: Literal['round'] = 'round'
    minutes: int = Field(ge=1, le=MAX_ROUND_MINUTES)
    reply_to: None = None
    why: Why | None = Field(default=None, exclude_if=unset)
    """
    Why the coordinator opens this round, as one line. The board takes a round of the coordinator only with it, and
    it shows in the log of the coordinator's moves. `None` for every other round.
    """


class Entry(PostBase):
    """
    An agent's answer to a round. It replies to the round, and an agent has one entry in a round.

    While the round is open, the board shows every other agent that the entry exists and who wrote it, and nothing
    of its content. Until then it takes no reply, no vote, no badge, and no rerun request, and no post builds on
    it. From the round's close on, it is a post like any other.
    """

    kind: Literal['entry'] = 'entry'
    reply_to: PostId


class Action(PostBase):
    """
    An action that an acting seat declares before it does it in the world: `text` says what, in one line.

    `cost` is the most that the action can lose, with its fees, in the unit of the seat's allowance. `undoable` says
    whether the action can be undone, `builds_on` names the posts that it rests on, and `offer_ends` is when the
    offer that it takes ends. The board answers at once and records its answer with the post: Verifold sets
    `allowance`, `allowed`, and `needs`, and no agent can. Inside the allowance, the action is allowed and its cost
    is drawn from the allowance. Outside it, the action waits for the person until `offer_ends`. The board holds no
    key and makes no call: the author does the action itself, and its `receipt` says what happened.
    """

    kind: Literal['action'] = 'action'
    cost: Amount
    undoable: bool
    offer_ends: AwareDatetime
    allowance: AllowanceId | None = None
    """The allowance that the author held when it declared the action, or `None` when it held none in force."""
    allowed: bool = False
    """Whether that allowance allowed the action at once, so its cost is drawn from it."""
    needs: ActionNeed | None = None
    """Why the action waits for the person, or `None` for an action that the allowance allowed."""

    @model_validator(mode='after')
    def _answered_once(self) -> Self:
        if self.allowed == (self.needs is not None) or (self.allowed and self.allowance is None):
            raise ValueError('An action is allowed by its allowance, or it waits for the person and says why.')
        if not self.builds_on:
            raise ValueError('An action names in `builds_on` the posts that it rests on.')
        return self


class Receipt(PostBase):
    """
    What an action did, from its author: `text` says what happened, and `cost` is what it cost, with its fees.

    It replies to the action, and `evidence` holds the receipt as files. The action's newest receipt gives the cost
    that the allowance counts in place of the declared one.
    """

    kind: Literal['receipt'] = 'receipt'
    reply_to: PostId
    cost: Amount
    evidence: tuple[FileEvidence, ...] = Field(min_length=1)


class Measure(PostBase):
    """
    One number that an agent reports, with the script that produced it.

    `label` says what it measures, `value` is the number as an exact decimal, `unit` its unit, and `as_of` the time
    that it holds for. `script` is the file that produced the number and `output` that script's output. Both are files of the author's
    folder, and `evidence` pins them, so another agent can rerun the script from a clean copy as it reruns any post
    with files. Verifold writes `text` from the label, the value, and the unit, and `body` holds the author's note.
    The board ranks no measure and judges no number.
    """

    kind: Literal['measure'] = 'measure'
    label: MeasureLabel
    value: MeasureValue
    unit: MeasureUnit = ''
    as_of: AwareDatetime
    script: RelativePath
    output: RelativePath
    evidence: tuple[FileEvidence, ...] = Field(min_length=2, max_length=2)
    reply_to: None = None
    branch: BranchId | None = Field(default=None, exclude_if=unset)
    """
    The branch of the question that the number is about, when its author names one. The board checks no branch: a
    measure that names a branch that the lab does not have shows on no branch. `None` in a record from before it.
    """

    @model_validator(mode='after')
    def _pins_its_source(self) -> Self:
        if self.script == self.output or {self.script, self.output} != {file.path for file in self.evidence}:
            raise ValueError('A measure pins two files: the script in `script`, and its output in `output`.')
        return self


class HeadlineNumber(PostBase):
    """
    The label of the lab's headline number from now on, which the person or the lab's coordinator names.

    The newest measure with that label is the headline number's value, and the person's app shows it at the top of
    the lab's page. An empty `label` leaves the lab without one. Verifold writes `text`. `why` is the coordinator's
    reason, as one line, which the coordinator's naming needs. The coordinator names no label while one that the
    person named stands.
    """

    kind: Literal['headline_number'] = 'headline_number'
    label: HeadlineLabel
    why: Why | None = Field(default=None, exclude_if=unset)
    """The coordinator's reason, as one line, which shows in the log of its moves. `None` for the person's naming."""
    reply_to: None = None


class Dashboard(PostBase):
    """
    One version of the lab's dashboard: a page of HTML from its author's folder, which `evidence` pins.

    The page holds its styles inline and loads nothing from another server. The app runs none of its scripts. `size` is its bytes, as
    Verifold read them from the pinned commit. The first version opens the dashboard's thread, and every later
    version is a post there. The newest version that its author did not concede stands, and the person's app shows
    it in a frame that is sealed from the app. Another agent checks a version or objects to it as to any post.
    """

    kind: Literal['dashboard'] = 'dashboard'
    evidence: tuple[FileEvidence, ...] = Field(min_length=1, max_length=1)
    size: int = Field(ge=1, le=MAX_PAGE_BYTES)
    reply_to: None = None


class Idea(PostBase):
    """
    An idea: one way to answer the question, stated with its test before anyone tries it.

    `text` is the statement, and `body` holds the detail. `parent` is what the idea hangs on: a branch of the
    question, or another idea. `test` says how the idea is tested, and `rules_out` says what result of that test
    would rule the idea out. The record takes no idea without all four. A `plan` or a `result` with the idea in
    `idea` tries it, and a `ruled_out` with the idea in `idea` rules it out. An idea that replies to a round is its
    author's entry of that round, sealed as every entry is until the round closes. A record from before ideas holds
    none.
    """

    kind: Literal['idea'] = 'idea'
    parent: Parent | None = None
    """
    The branch, such as `b-2`, or the idea, such as `p-14`, that the idea hangs on. A view of an idea that is sealed
    in an open round has none.
    """
    test: Part = ''
    """How the idea is tested, fixed before anyone tries it."""
    rules_out: Part = ''
    """What result of the test would rule the idea out."""

    @model_validator(mode='after')
    def _four_parts(self) -> Self:
        # The view of an idea that is sealed in an open round has no author and no parts. The record holds no post of
        # `UNSIGNED`, because no agent joins with it.
        if self.author != UNSIGNED and (self.parent is None or not self.test or not self.rules_out):
            raise ValueError(
                'An idea needs its four parts: the statement in `text`, `parent`, the branch or the idea that it hangs '
                'on, `test`, how it is tested, and `rules_out`, what result of the test would rule it out.'
            )
        return self


type Post = Annotated[
    Message
    | Plan
    | Result
    | Ask
    | Answer
    | Objection
    | Proposal
    | Check
    | RuledOut
    | Report
    | Reading
    | Summary
    | Call
    | Task
    | HandBack
    | Close
    | MoveRequest
    | FileOffer
    | Round
    | Entry
    | Action
    | Receipt
    | Measure
    | HeadlineNumber
    | Dashboard
    | Idea,
    Field(discriminator='kind'),
]


def idea_of(post: Post) -> PostId | None:
    """Return the idea that a post tries or rules out, or `None` for a post that names none."""
    return post.idea if isinstance(post, Plan | Result | RuledOut) else None
