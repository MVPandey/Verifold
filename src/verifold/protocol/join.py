"""The messages of the join protocol: what an agent sends to its lab and what it gets back."""

from typing import Literal, Self

from pydantic import AwareDatetime, Field, TypeAdapter, model_validator

from verifold.protocol.agents import Agent, Label
from verifold.protocol.events import Note, Posted, Question
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

type LabState = Literal['open', 'closing', 'closed']
"""Whether the lab's agents say that it is done. `closing`: one said so. `closed`: more than half stand behind it."""

type Standing = Literal['open', 'checked', 'held_up', 'disputed', 'conceded']
"""Where a post stands after the objections, checks, and answers to it."""

MAX_NEWS = 20
"""The most posts in each list of an agent's news or update, and the most threads in a brief."""

_posts: TypeAdapter[Post] = TypeAdapter(Post)


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

    @model_validator(mode='after')
    def _one_thread(self) -> Self:
        if (self.thread is None) == (self.new_thread is None):
            raise ValueError('Give thread to post in a thread, or new_thread to open one.')
        if self.new_thread and self.reply_to:
            raise ValueError('A reply stays in the thread of the post that it answers. Give thread, not new_thread.')
        if self.between and not self.new_thread:
            raise ValueError('`between` names the agents of a new side thread. Give new_thread with it.')
        return self

    def to_post(
        self,
        post_id: PostId,
        thread_id: ThreadId,
        author: AgentId,
        evidence: tuple[FileEvidence, ...] = (),
        question_seen: int | None = None,
    ) -> Post:
        """
        Return the post that this request describes, with the evidence that Verifold pinned for its files.

        `question_seen` is how many revisions of the question the author had been shown. Only a proposal keeps it.

        Raises:
            pydantic.ValidationError: The kind does not accept a field of the request, or misses one that it needs.

        """
        # `accepts=False` and empty `choices` mean the same as leaving them out. Only an answer takes `accepts`, and
        # only an ask takes `choices`.
        unused = {'thread', 'new_thread', 'between', 'files'} | (set() if self.accepts else {'accepts'})
        unused |= set() if self.choices else {'choices'}
        fields = self.model_dump(exclude=unused, exclude_none=True)
        if self.kind == 'proposal' and question_seen is not None:
            fields['question_seen'] = question_seen
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
    members: tuple[AgentId, ...] = ()
    """The members of a side thread, in the order that they came. Empty for any other thread."""
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
    A thread at a glance: its latest post, how its results and asks stand, and where its ideas come from and go.

    `checked` counts results that a check holds up, and `not_checked` counts results that nobody has checked yet.
    """

    thread: Thread
    watching: bool
    members: tuple[AgentId, ...] = ()
    """The members of a side thread, in the order that they came. Empty for any other thread."""
    posts: int
    last_at: AwareDatetime
    latest: PostLine | None = None
    disputed: int = 0
    checked: int = 0
    not_checked: int = 0
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


class LeftLine(Record):
    """An agent that left the lab: who caused it, and why. Its posts stay, and no post reaches it."""

    id: AgentId
    name: Label
    by: AgentId
    """The agent itself, or `person` when the person removed it."""
    reason: str = ''


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
    left: tuple[LeftLine, ...] = ()
    """The agents that left the lab since, among those that the agent wrote to: who caused it, and the reason."""


class PostResult(PostView):
    """What the `post` tool returns: the post as it stands, and the agent's news."""

    news: News | None = None
    """`None` for a blind checker, which reads nothing but its claim."""
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


class RerunResult(Record):
    """What the `rerun` tool returns: the post that gets a blind rerun, and the agent's news."""

    post: PostId
    joins: AgentId | None = None
    """Who asked first, when a blind rerun of the post runs already. This request joins it: one check answers both."""
    news: News | None = None


class AgentLine(Record):
    """An agent of the lab at a glance: the plan that it posted last, and its latest post."""

    id: AgentId
    name: Label
    harness: Label
    role: str = ''
    """What the agent says that it is to the lab, in its own words."""
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


MAX_LEADS = 10
"""The most entries in each list of a brief that shows where another agent's work can use the reader."""


class ThreadLine(Record):
    """A thread as one line: its title and the agents that work in it now."""

    id: ThreadId
    title: Title
    team: tuple[AgentId, ...]


class QuestionVersion(Record):
    """One version of the lab's question: the text that the lab opened with, or a revision by the person."""

    question: Question
    at: AwareDatetime
    note: Note = ''
    """Why the person revised the question, when they said so."""
    post: PostId | None = None
    """The person's post that told the lab of the revision. `None` for the text that the lab opened with."""


class RevisionLine(Record):
    """A revision of the question as one line: when it came, why, and the post that holds its text."""

    at: AwareDatetime
    note: Note = ''
    post: PostId


class AnswerView(Record):
    """The lab's answer so far for the person: the proposal, and each post that it builds on with where it stands."""

    answer: PostView
    to_earlier_question: bool = False
    """Whether the person revised the question after this proposal, so that it answers an earlier version."""
    builds_on: tuple[PostView, ...] = ()
    results: int = 0
    """How many of `builds_on` are results with files, which a blind checker can rerun."""
    no_blind_rerun: tuple[PostId, ...] = ()
    """The results among them that no blind checker has rerun."""


class FileText(Record):
    """The text of one file that backs a post, at the commit that the post pins."""

    path: str
    commit: str
    text: str


class AlarmResult(Record):
    """What the `alarm` tool returns: when the alarm rings, or `None` when the agent has none."""

    rings_at: AwareDatetime | None = None
    quiet: bool = False
    news: News | None = None


class ProfileResult(Record):
    """What an agent's role and status are after it set them."""

    role: str
    status: str
    news: News | None = None


class Brief(Record):
    """
    The lab for one agent, in one read: how the board works, who works on what, and where the agent's work is of use.

    The lists come in this order: calls and threads with one agent, results to build on, asks, and results to check.

    An agent reads it when it starts, and again before each new piece of work.
    """

    you: AgentId
    your_line: AgentLine | None = None
    """What the board holds about you: your role and status, the thread where you work, and your latest plan and post."""
    how: str = ''
    """How the board works. The first brief of a session carries it, and later ones leave it out."""
    question: Question
    """The question that the lab works on now. The person can revise it."""
    revisions: tuple[RevisionLine, ...] = ()
    """The newest revisions of the question by the person, newest last, at most `MAX_LEADS`. Each one's post holds its text."""
    agents: tuple[AgentLine, ...] = ()
    """The other agents that are in the lab. Blind checkers are not among them."""
    left: tuple[LeftLine, ...] = ()
    """The agents that left the lab or that the person removed, oldest first."""
    answer: PostLine | None = None
    """The lab's answer so far: the newest proposal in the question's thread."""
    answer_standing: Standing | None = None
    """Where the answer stands, such as `disputed` or `conceded`. `None` when the lab has no answer."""
    answer_to_earlier_question: bool = False
    """Whether the person revised the question after the answer, so that it answers an earlier version."""
    state: LabState = 'open'
    """Whether the lab's agents say that it is done."""
    close: PostLine | None = None
    """The post that says that the lab is done, while it stands."""
    close_agreed: tuple[AgentId, ...] = ()
    """The agents that agreed with it. Its author is not among them."""
    open_calls: tuple[PostLine, ...] = ()
    """
    Calls from others that still need an agent, newest last. A plan that replies to a call takes it. A call in a
    side thread is here only for the thread's members, and so is an ask in `open_asks`.
    """
    one_agent_threads: tuple[ThreadLine, ...] = ()
    """The threads where one other agent works alone, the most recently active first, at most `MAX_LEADS`."""
    not_built_on: tuple[PostLine, ...] = ()
    """Other agents' results that no other agent has built on yet, newest last, at most `MAX_LEADS`."""
    open_asks: tuple[PostLine, ...] = ()
    """Asks from others that nobody has answered yet, newest last. Asks for the person alone are not among them."""
    not_checked: tuple[PostLine, ...] = ()
    """Other agents' results that nobody has checked yet, newest last."""
    disputed: tuple[PostLine, ...] = ()
    """The posts that a failed check or a standing objection disputes, the agent's own among them, newest last."""
    threads: tuple[ThreadSummary, ...] = ()
    """The threads that are not side threads, the most recently active first, at most `MAX_NEWS`."""
    more_threads: int = 0
    """How many threads the list leaves out. `threads` shows all of them."""
    side_threads: tuple[SideLine, ...] = ()
    """The side threads, the agent's own first and then the most recently active, at most `MAX_NEWS`."""
    more_side_threads: int = 0
    """How many side threads the list leaves out. `threads` shows all of them."""
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
    left: tuple[LeftLine, ...] = ()
    """The agents that left the lab since, among those that the agent wrote to: who caused it, and the reason."""
    ends_at: AwareDatetime | None = None
    """When the lab ends. At that time Verifold stops the agents' turns. `None` means no time limit."""
