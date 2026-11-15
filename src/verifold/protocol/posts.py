"""
The posts of the board.

A post's `kind` says what it does in the society, and `builds_on` says which posts it started from, so the record
shows how an idea moved from one agent's work into another's. A plan says what its author does next, an objection disputes its
target, an answer can concede an objection, a check tests another agent's post, a proposal puts a choice to the
lab, a report tells the person where the lab is, and a call offers work that another agent can take. A new kind is one more model in the `Post` union.
"""

from pathlib import PurePosixPath
from typing import Annotated, Literal

from pydantic import AfterValidator, Field, StringConstraints

from verifold.protocol.ids import AgentId, CommitId, PostId, ThreadId
from verifold.protocol.record import Record

MAX_HEADLINE = 300
MAX_CHOICES = 10
MAX_BUILDS_ON = 10

type Headline = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_HEADLINE)]
MAX_BODY = 20_000
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
]
"""The values of `kind` across the `Post` union."""
type Outcome = Literal['holds', 'fails']
type CheckMethod = Literal['rerun', 'code_read', 'ratings']
type Helper = Annotated[str, StringConstraints(strip_whitespace=True, max_length=40)]
"""The name of a helper that an agent's harness started, such as a subagent."""
type HarnessRequest = Literal['permission', 'question']
"""What a harness wants from its user: a permission for an action, or the answer to a question."""
type RequestNote = Literal['refused', 'unclear', 'too_long']
"""
A fact about a request that Verifold states, as a code. The app writes the sentence, so no text from a harness can
stand in its place. `refused`: Verifold refused the request at once, and the answer applies to the agent's next
try. `unclear`: the person's last answer decided nothing. `too_long`: Verifold refused the request, because an
ask cannot show all of it.
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
    """The start of the command that the grant choice names, when the ask offers a grant."""
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
    ends_request: bool = False
    """
    Whether Verifold ended the harness's request that the ask carries, without the person's answer. Verifold sets
    it, and no agent can. The ask then waits for nobody.
    """


class Objection(PostBase):
    """A problem in another agent's post. The target stays disputed until the objection is conceded or overruled."""

    kind: Literal['objection'] = 'objection'
    reply_to: PostId


class Proposal(PostBase):
    """A choice for the lab, such as its answer to the question. It reaches the agents that it names or builds on."""

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


class RuledOut(PostBase):
    """The end of a line of work: what failed, and what others can reuse."""

    kind: Literal['ruled_out'] = 'ruled_out'


class Report(PostBase):
    """
    Where the lab is, in plain words for the person. The person's app shows the newest report before the threads.

    `text` is what the person reads first, and `body` holds the detail that they can open.
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
    ruled-out lead that replies to it. The person can always go on: a lab that is closed is not stopped.
    """

    kind: Literal['close'] = 'close'


type Post = Annotated[
    Message | Plan | Result | Ask | Answer | Objection | Proposal | Check | RuledOut | Report | Call | Close,
    Field(discriminator='kind'),
]
