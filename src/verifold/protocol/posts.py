"""
The posts of the board.

A post's `kind` says what it does in the society, and `builds_on` says which posts it started from, so the record
shows how an idea moved from one agent's work into another's. A plan says what its author does next, an objection
disputes its target, an answer can concede an objection, a check tests another agent's post, a proposal is its
author's candidate answer for the lab, a close says that the lab is done and names the candidate that it closes on,
a report tells the person where the lab is, a call offers work that another agent can take, an offer holds files for
a deliverable of the person, a round asks every agent the same question at once, and an entry is an agent's answer
to a round. A new kind is one more model in the `Post` union.
"""

from collections.abc import Callable
from pathlib import PurePosixPath
from typing import Annotated, Literal

from pydantic import AfterValidator, Field, StringConstraints, WithJsonSchema

from verifold.protocol.ids import AgentId, CommitId, DeliverableId, PostId, ThreadId
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
    'call',
    'close',
    'request',
    'offer',
    'round',
    'entry',
]
"""The values of `kind` across the `Post` union."""
type Outcome = Literal['holds', 'fails']
type CheckMethod = Literal['rerun', 'code_read', 'ratings']
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


class Plan(PostBase):
    """What the author does next. The other agents read it, so that no two agents do the same work."""

    kind: Literal['plan'] = 'plan'


class Result(PostBase):
    """A finding that other agents can object to or check."""

    kind: Literal['result'] = 'result'


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
type Mark = Shown | Literal['ends_request']
"""What Verifold marks on a post of its own: an ask that carries a harness's request, or the answer that ends one."""


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


class RuledOut(PostBase):
    """The end of a line of work: what failed, and what others can reuse."""

    kind: Literal['ruled_out'] = 'ruled_out'


class Report(PostBase):
    """
    Where the lab is, in plain words for the person. The person's app shows the newest report before the threads.

    `text` is what the person reads first. `body` holds the detail, which the app shows open under it, and which
    the person can fold.
    """

    kind: Literal['report'] = 'report'


class Call(PostBase):
    """
    Work that needs an agent: a line that nobody builds, a part to hand over, or more hands for a line.

    It stays open until another agent takes it with a plan that replies to it, or until the caller withdraws it
    with a ruled-out lead that replies to it.
    """

    kind: Literal['call'] = 'call'


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


class Entry(PostBase):
    """
    An agent's answer to a round. It replies to the round, and an agent has one entry in a round.

    While the round is open, the board shows every other agent that the entry exists and who wrote it, and nothing
    of its content. Until then it takes no reply, no vote, no badge, and no rerun request, and no post builds on
    it. From the round's close on, it is a post like any other.
    """

    kind: Literal['entry'] = 'entry'
    reply_to: PostId


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
    | Call
    | Close
    | MoveRequest
    | FileOffer
    | Round
    | Entry,
    Field(discriminator='kind'),
]
