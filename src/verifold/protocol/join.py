"""The messages of the join protocol: what an agent sends to its lab and what it gets back."""

from typing import Literal, Self

from pydantic import AwareDatetime, TypeAdapter, model_validator

from verifold.protocol.agents import Agent
from verifold.protocol.events import Posted
from verifold.protocol.ids import AgentId, PostId, ThreadId
from verifold.protocol.posts import Body, CheckMethod, FileEvidence, Headline, Outcome, Post, PostKind
from verifold.protocol.record import Record
from verifold.protocol.threads import Thread, Title

type Standing = Literal['open', 'checked', 'disputed', 'conceded']
"""Where a post stands after the objections, checks, and answers to it."""

_posts: TypeAdapter[Post] = TypeAdapter(Post)


class PostRequest(Record):
    """
    A post that an agent or the person sends. The lab gives it an ID and an author.

    Give `thread` to post in a thread, or `new_thread` to open a thread with this post. Fields that a kind does not
    use, such as `outcome` on a message, are rejected.

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
    evidence: tuple[FileEvidence, ...] = ()
    accepts: bool | None = None
    outcome: Outcome | None = None
    method: CheckMethod | None = None

    @model_validator(mode='after')
    def _one_thread(self) -> Self:
        if (self.thread is None) == (self.new_thread is None):
            raise ValueError('Give thread to post in a thread, or new_thread to open one.')
        if self.new_thread and self.reply_to:
            raise ValueError('A reply stays in the thread of the post that it answers. Give thread, not new_thread.')
        return self

    def to_post(self, post_id: PostId, thread_id: ThreadId, author: AgentId) -> Post:
        """
        Return the post that this request describes.

        Raises:
            pydantic.ValidationError: The kind does not accept a field of the request, or misses one that it needs.

        """
        # A false `accepts` means the same as no `accepts`, and only an answer accepts the field.
        unused = {'thread', 'new_thread'} if self.accepts else {'thread', 'new_thread', 'accepts'}
        fields = self.model_dump(exclude=unused, exclude_none=True)
        return _posts.validate_python(fields | {'id': post_id, 'thread': thread_id, 'author': author})


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


class ThreadSummary(Record):
    """One line about a thread: how many posts it has and when it last changed."""

    thread: Thread
    watching: bool
    posts: int
    last_at: AwareDatetime


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
