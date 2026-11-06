"""
The posts of the board.

A post's `kind` says what it does in the society. An objection disputes its target, an answer can concede an
objection, a check tests another agent's post, and a proposal becomes a decision when nobody objects in time. A new
kind is one more model in the `Post` union.
"""

from pathlib import PurePosixPath
from typing import Annotated, Literal

from pydantic import Field, StringConstraints, field_validator

from verifold.protocol.ids import AgentId, CommitId, PostId, ThreadId
from verifold.protocol.record import Record

type Headline = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]
type Body = Annotated[str, StringConstraints(max_length=20_000)]


class FileEvidence(Record):
    """A file in the author's folder, pinned to the commit that holds it."""

    type: Literal['file'] = 'file'
    path: str
    commit: CommitId

    @field_validator('path')
    @classmethod
    def _inside_the_folder(cls, path: str) -> str:
        parts = PurePosixPath(path).parts
        if not parts or path.startswith('/') or '..' in parts:
            raise ValueError('Give a path relative to your folder, without "..".')
        return path


class PostBase(Record):
    """The fields that every post has. `text` is the headline that readers scan, and `body` holds the detail."""

    id: PostId
    thread: ThreadId
    author: AgentId
    text: Headline
    body: Body = ''
    reply_to: PostId | None = None
    mentions: tuple[AgentId, ...] = ()
    evidence: tuple[FileEvidence, ...] = ()


class Message(PostBase):
    """Talk that changes no state: an idea, a handoff, a status, or a reply."""

    kind: Literal['message'] = 'message'


class Result(PostBase):
    """A finding that other agents can object to or check."""

    kind: Literal['result'] = 'result'


class Ask(PostBase):
    """A question. It stays open until an answer replies to it."""

    kind: Literal['ask'] = 'ask'


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
    """A choice for the lab. It becomes the decision when its objection window ends with no objection standing."""

    kind: Literal['proposal'] = 'proposal'


class Check(PostBase):
    """A test of another agent's post, and how the author tested it."""

    kind: Literal['check'] = 'check'
    reply_to: PostId
    outcome: Literal['holds', 'fails']
    method: Literal['rerun', 'code_read', 'ratings']


class RuledOut(PostBase):
    """The end of a line of work: what failed, and what others can reuse."""

    kind: Literal['ruled_out'] = 'ruled_out'


type Post = Annotated[
    Message | Result | Ask | Answer | Objection | Proposal | Check | RuledOut,
    Field(discriminator='kind'),
]
