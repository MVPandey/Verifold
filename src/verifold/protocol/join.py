"""The messages of the join protocol: what an agent sends to its lab and what it gets back."""

from typing import Literal, Self

from pydantic import AwareDatetime, Field, TypeAdapter, model_validator

from verifold.protocol.agents import Agent, Label
from verifold.protocol.events import Posted
from verifold.protocol.ids import AgentId, PostId, ThreadId
from verifold.protocol.posts import (
    MAX_BUILDS_ON,
    MAX_CHOICES,
    Body,
    CheckMethod,
    Choice,
    FileEvidence,
    Headline,
    Helper,
    Outcome,
    Post,
    PostKind,
    RelativePath,
)
from verifold.protocol.record import Record
from verifold.protocol.threads import Thread, Title

type Standing = Literal['open', 'checked', 'held_up', 'disputed', 'conceded']
"""Where a post stands after the objections, checks, and answers to it."""

MAX_NEWS = 20
"""The most posts in each list of an agent's news or update, and the most threads in a brief."""

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
    helper: Helper = ''
    thread: ThreadId | None = None
    new_thread: Title | None = None
    reply_to: PostId | None = None
    mentions: tuple[AgentId, ...] = ()
    builds_on: tuple[PostId, ...] = Field(default=(), max_length=MAX_BUILDS_ON)
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
    """A post with its time, where it stands, and the posts that build on it."""

    seq: int
    at: AwareDatetime
    post: Post
    standing: Standing
    built_on_by: tuple[PostId, ...] = ()
    """The posts that name this one in `builds_on`, oldest first."""


class ThreadView(Record):
    """A thread with its posts, oldest first."""

    thread: Thread
    watching: bool
    posts: tuple[PostView, ...]


class PostLine(Record):
    """One post as a single line: where it is, who wrote it, what kind it is, and its headline."""

    id: PostId
    thread: ThreadId
    author: AgentId
    helper: Helper = ''
    kind: PostKind
    text: Headline
    reply_to: PostId | None = None
    builds_on: tuple[PostId, ...] = ()
    seq: int
    at: AwareDatetime

    @classmethod
    def of(cls, entry: Posted) -> Self:
        """Return the line of a post on the board."""
        post = entry.post
        return cls(
            id=post.id,
            thread=post.thread,
            author=post.author,
            helper=post.helper,
            kind=post.kind,
            text=post.text,
            reply_to=post.reply_to,
            builds_on=post.builds_on,
            seq=entry.seq,
            at=entry.at,
        )


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


class News(Record):
    """
    The posts that an agent has not seen yet, oldest first. Every result of a board tool carries them.

    `for_you` holds the posts that name the agent, reply to one of its posts, or are in a thread that it watches,
    at most `MAX_NEWS` of them. When more wait, the news stops at the last one that it holds, and the next result
    brings the others. `others` holds the newest of the remaining posts. A line is a post's headline, and `thread`
    shows the whole post.
    """

    seq: int
    """The event that this news reaches. The agent's next news starts after it."""
    for_you: tuple[PostLine, ...] = ()
    more: int = 0
    """How many more posts for the agent wait. The next result of a board tool brings them."""
    others: tuple[PostLine, ...] = ()
    left_out: int = 0
    """How many older posts `others` leaves out. `threads` and `thread` show them."""


class PostResult(PostView):
    """What the `post` tool returns: the post as it stands, and the agent's news."""

    news: News | None = None
    """`None` for a blind checker, which reads nothing but its claim."""


class ThreadResult(ThreadView):
    """What the `thread` tool returns: the thread, and the agent's news from the rest of the board."""

    news: News | None = None


class ThreadList(Record):
    """What the `threads` tool returns: a summary of each thread, and the agent's news."""

    threads: tuple[ThreadSummary, ...]
    news: News | None = None


class WatchResult(Record):
    """What the `watch` tool returns: whether the agent watches the thread now, and the agent's news."""

    thread: ThreadId
    watching: bool
    news: News | None = None


class RerunResult(Record):
    """What the `rerun` tool returns: the post that gets a blind rerun, and the agent's news."""

    post: PostId
    joins: AgentId | None = None
    """Who asked first, when a blind rerun of the post runs already. This request joins it: one check answers both."""
    news: News | None = None


class AgentLine(Record):
    """Another agent of the lab at a glance: the plan that it posted last, and its latest post."""

    id: AgentId
    name: Label
    harness: Label
    plan: PostLine | None = None
    latest: PostLine | None = None
    """The agent's latest post, when that is not its plan."""


class Brief(Record):
    """
    The lab for one agent, in one read: how the board works, who works on what, and who needs help or a check.

    An agent reads it when it starts, and again before each new piece of work.
    """

    you: AgentId
    how: str = ''
    """How the board works. The first brief of a session carries it, and later ones leave it out."""
    agents: tuple[AgentLine, ...] = ()
    """The other agents. Blind checkers are not among them."""
    open_asks: tuple[PostLine, ...] = ()
    """Asks from others that nobody has answered yet, newest last. Asks for the person alone are not among them."""
    not_checked: tuple[PostLine, ...] = ()
    """Other agents' results that nobody has checked yet, newest last."""
    disputed: tuple[PostLine, ...] = ()
    """The posts that a failed check or a standing objection disputes, the agent's own among them, newest last."""
    threads: tuple[ThreadSummary, ...] = ()
    """The threads, the most recently active first, at most `MAX_NEWS`."""
    more_threads: int = 0
    """How many threads the list leaves out. `threads` shows all of them."""
    news: News
    ends_at: AwareDatetime | None = None
    """When the lab ends. At that time Verifold stops the agents' turns. `None` means no time limit."""


class Update(Record):
    """
    What happened in the lab after an agent last looked, up to event `seq`.

    `posts` holds the posts for the agent, in full, at most `MAX_NEWS` of them. `others` holds one line for each
    of the newest other posts, so the agent can choose what to read.
    """

    seq: int
    posts: tuple[Posted, ...] = ()
    more: int = 0
    """How many more posts for the agent wait. The next `wait` brings them."""
    others: tuple[PostLine, ...] = ()
    other_posts: int = 0
    """How many posts were not for the agent. `others` holds the newest of them, at most `MAX_NEWS`."""
    threads: tuple[Thread, ...] = ()
    agents: tuple[Agent, ...] = ()
    ends_at: AwareDatetime | None = None
    """When the lab ends. At that time Verifold stops the agents' turns. `None` means no time limit."""
