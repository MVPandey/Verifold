"""The messages of the join protocol: what an agent sends to its lab and what it gets back."""

from typing import Literal, Self

from pydantic import AwareDatetime, Field, TypeAdapter, model_validator

from verifold.protocol.agents import Agent
from verifold.protocol.events import Posted
from verifold.protocol.ids import AgentId, PostId, ThreadId
from verifold.protocol.posts import (
    MAX_CHOICES,
    Body,
    CheckMethod,
    Choice,
    FileEvidence,
    Headline,
    Outcome,
    Post,
    PostKind,
    RelativePath,
)
from verifold.protocol.record import Record
from verifold.protocol.threads import Thread, Title

type Standing = Literal['open', 'checked', 'held_up', 'disputed', 'conceded']
"""Where a post stands after the objections, checks, and answers to it."""

_posts: TypeAdapter[Post] = TypeAdapter(Post)


class PostRequest(Record):
    """
    A post that an agent or the person sends. The lab gives it an ID and an author.

    Give `thread` to post in a thread, or `new_thread` to open a thread with this post. The lab rejects fields that a
    kind doesn't use, such as `outcome` on a message.

    The request is one flat object, not a union of kinds, because harnesses fill a flat tool schema more reliably
    than a `oneOf`. The `post` tool takes the same fields as its own parameters, for the same reason. `to_post`
    validates the request against the `Post` union, so a new kind needs its fields here, in the tool, and in its
    model.
    """

    kind: PostKind
    text: Headline
    body: Body = ''
    thread: ThreadId | None = None
    new_thread: Title | None = None
    reply_to: PostId | None = None
    mentions: tuple[AgentId, ...] = ()
    files: tuple[RelativePath, ...] = ()
    """Files in the author's folder that back the post. Verifold commits the folder and pins each file."""
    accepts: bool | None = None
    outcome: Outcome | None = None
    method: CheckMethod | None = None
    choices: tuple[Choice, ...] = Field(default=(), max_length=MAX_CHOICES)

    @model_validator(mode='after')
    def _one_thread(self) -> Self:
        if (self.thread is None) == (self.new_thread is None):
            raise ValueError('Give thread to post in a thread, or new_thread to open one.')
        if self.new_thread and self.reply_to:
            raise ValueError('A reply stays in the thread of the post that it answers. Give thread, not new_thread.')
        return self

    def to_post(
        self, post_id: PostId, thread_id: ThreadId, author: AgentId, evidence: tuple[FileEvidence, ...] = ()
    ) -> Post:
        """
        Return the post that this request describes, with the evidence that Verifold pinned for its files.

        Raises:
            pydantic.ValidationError: The kind does not accept a field of the request, or misses one that it needs.

        """
        # `accepts=False` and empty `choices` mean the same as leaving them out. Only an answer takes `accepts`, and
        # only an ask takes `choices`.
        unused = {'thread', 'new_thread', 'files'} | (set() if self.accepts else {'accepts'})
        unused |= set() if self.choices else {'choices'}
        fields = self.model_dump(exclude=unused, exclude_none=True)
        return _posts.validate_python(
            fields | {'id': post_id, 'thread': thread_id, 'author': author, 'evidence': evidence}
        )


class PostView(Record):
    """A post with its time and where it stands."""

    seq: int
    at: AwareDatetime
    post: Post
    standing: Standing


class ThreadView(Record):
    """A thread with its posts, oldest first."""

    thread: Thread
    watching: bool
    posts: tuple[PostView, ...]


class PostLine(Record):
    """One post as a single line: who wrote it, what kind it is, and its headline."""

    seq: int
    at: AwareDatetime
    author: AgentId
    kind: PostKind
    text: Headline


class ThreadSummary(Record):
    """
    A thread at a glance: its latest post, and how its results and asks stand.

    `checked` counts results that a check holds up, and `not_checked` counts results that nobody has checked yet.
    """

    thread: Thread
    watching: bool
    posts: int
    last_at: AwareDatetime
    latest: PostLine | None = None
    disputed: int = 0
    checked: int = 0
    not_checked: int = 0
    open_asks: int = 0


class Update(Record):
    """
    What happened in the lab after an agent last looked, up to event `seq`.

    `posts` holds the posts for the agent. The other fields summarize the rest, so the agent can choose what to read.
    """

    seq: int
    posts: tuple[Posted, ...] = ()
    threads: tuple[Thread, ...] = ()
    agents: tuple[Agent, ...] = ()
    other_posts: int = 0
    ends_at: AwareDatetime | None = None
    """When the lab ends. At that time Verifold stops the agents' turns. `None` means no time limit."""
