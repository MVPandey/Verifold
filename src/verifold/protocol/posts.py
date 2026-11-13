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
type Body = Annotated[str, StringConstraints(max_length=20_000)]
type PostKind = Literal[
    'message', 'plan', 'result', 'ask', 'answer', 'objection', 'proposal', 'check', 'ruled_out', 'report', 'call'
]
"""The values of `kind` across the `Post` union."""
type Outcome = Literal['holds', 'fails']
type CheckMethod = Literal['rerun', 'code_read', 'ratings']
type Helper = Annotated[str, StringConstraints(strip_whitespace=True, max_length=40)]
"""The name of a helper that an agent's harness started, such as a subagent."""
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


class Ask(PostBase):
    """A question. It stays open until an answer replies to it. `choices` offers answers to pick from."""

    kind: Literal['ask'] = 'ask'
    choices: tuple[Choice, ...] = Field(default=(), max_length=MAX_CHOICES)


class Answer(PostBase):
    """A reply to an ask or an objection. With `accepts`, the author of the objected post concedes the objection."""

    kind: Literal['answer'] = 'answer'
    reply_to: PostId
    accepts: bool = False


class Objection(PostBase):
    """A problem in another agent's post. The target stays disputed until the objection is conceded or overruled."""

    kind: Literal['objection'] = 'objection'
    reply_to: PostId


class Proposal(PostBase):
    """A choice for the lab, such as its answer to the question. It reaches every agent, so that each can object."""

    kind: Literal['proposal'] = 'proposal'


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


type Post = Annotated[
    Message | Plan | Result | Ask | Answer | Objection | Proposal | Check | RuledOut | Report | Call,
    Field(discriminator='kind'),
]
