"""The messages of the join protocol: what an agent sends to its lab and what it gets back."""

from typing import Literal, Self

from pydantic import AwareDatetime, Field, TypeAdapter, model_validator

from verifold.protocol.agents import About, Agent, Label, Name, Picture, SeatMark
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
    choice: Choice | None = None
    """On an answer: the choice of the ask that the author picked. The person's app sends it for a press."""
    to_lab: bool = False
    """Whether the post is for the whole lab. Only the lab's coordinator and the person can mark a post so."""

    @model_validator(mode='after')
    def _one_thread(self) -> Self:
        if (self.thread is None) == (self.new_thread is None):
            raise ValueError('Give thread to post in a thread, or new_thread to open one.')
        if self.new_thread and self.reply_to:
            raise ValueError('A reply stays in the thread of the post that it answers. Give thread, not new_thread.')
        if self.between and not self.new_thread:
            raise ValueError('`between` names the agents of a new side thread. Give new_thread with it.')
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
        unused = {'thread', 'new_thread', 'between', 'files'} | (set() if self.accepts else {'accepts'})
        unused |= set() if self.choices else {'choices'}
        unused |= set() if self.to_lab else {'to_lab'}
        fields = self.model_dump(exclude=unused, exclude_none=True)
        if self.kind == 'proposal' and question_seen is not None:
            fields['question_seen'] = question_seen
        if self.kind == 'check' and take is not None:
            fields['take'] = take
        return _posts.validate_python(
            fields | {'id': post_id, 'thread': thread_id, 'author': author, 'evidence': evidence}
        )


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


class PostView(Record):
    """A post with its time, who wrote it, where it stands, and the posts that build on it."""

    seq: int
    at: AwareDatetime
    post: Post
    by: Byline | None = None
    """Who wrote the post. `None` for a post of the person."""
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


MAX_LINE = 300
"""The most characters of a headline that a post's line shows. A longer headline is cut, and `thread` shows all of it."""


def line_text(text: str) -> str:
    """Return a headline as a post's line shows it: whole, or cut to `MAX_LINE` characters with a mark that says so."""
    if len(text) <= MAX_LINE:
        return text
    return f'{text[:MAX_LINE]}… [cut: {len(text)} characters, `thread` shows all of it]'


class PostLine(Record):
    """
    One post as a single line: where it is, who wrote it, what kind it is, and its headline.

    A headline of more than `MAX_LINE` characters is cut and ends with a mark that says so. So the lists of a brief
    and of the news stay within what a harness takes as one tool result. `thread` shows the whole headline.
    """

    id: PostId
    thread: ThreadId
    author: AgentId
    by: Byline | None = None
    """
    Who the author is, with its seat's label cut to `MAX_SEAT` characters. `None` for a post of the person. In
    `brief`, the list of agents says who each agent is. So in the brief's lists of posts and in an agent's `plan`
    and `latest`, `by` is `None` for an author that the list of agents holds, unless the label of its seat was
    another when the post was written. The lines of `news` and of a thread's `latest` always have it.
    """
    helper: Helper = ''
    kind: PostKind
    text: Headline
    reply_to: PostId | None = None
    builds_on: tuple[PostId, ...] = ()
    seq: int
    at: AwareDatetime

    @classmethod
    def of(cls, entry: Posted, by: Byline | None = None) -> Self:
        """Return the line of a post on the board, with who wrote it."""
        post = entry.post
        return cls(
            id=post.id,
            thread=post.thread,
            author=post.author,
            by=by,
            helper=post.helper,
            kind=post.kind,
            text=line_text(post.text),
            reply_to=post.reply_to,
            builds_on=post.builds_on,
            seq=entry.seq,
            at=entry.at,
        )


class PostEntry(Record):
    """A post in a list of a brief: its line, or its ID alone when the brief holds its line already."""

    id: PostId
    line: PostLine | None = None
    """The post's line. `None` when `news` or an earlier field of the same brief holds it."""


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
    name: Name
    by: AgentId
    """The agent itself, or `person` when the person removed it."""
    reason: str = ''


class AlarmLine(Record):
    """
    The alarm that waits for an agent.

    It stays until it rings, until the agent sets another, or until the agent cancels it with zero minutes. A turn
    that starts for another reason does not spend it.
    """

    minutes: float
    quiet: bool = False
    """Whether the alarm rings when the board got no post for `minutes`. Each new post then moves `rings_at`."""
    rings_at: AwareDatetime | None = None
    """
    When the alarm rings as the lab stands. A time that passed means that the alarm rings when the agent's turn
    ends. `None` while the lab is out of time or closed: no alarm rings then, and an alarm whose time passed
    meanwhile rings when the lab has time again or is open again.
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


class News(Record):
    """
    The posts that an agent has not seen yet, oldest first, with the agent's alarm.

    Every result of a board tool carries them.

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
    profile: tuple[ProfileNote, ...] = ()
    """The changes that the person or the coordinator made to the agent's own profile since, oldest first."""
    renamed: tuple[RenameLine, ...] = ()
    """The other agents whose name changed since, each once, with its name now and the name that it had before."""
    reruns: tuple[RerunLine, ...] = ()
    """
    The reruns that somebody asked for since, that are still wanted, and that the agent can take with `take_rerun`.
    An agent whose seat is on call has none here, and `brief` lists every wanted rerun.
    """
    alarm: AlarmLine | None = None
    """The alarm that waits for the agent. `None` means that no alarm waits."""


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


class RerunResult(Record):
    """What the `rerun` tool returns: the post whose independent rerun is wanted, and the agent's news."""

    post: PostId
    joins: AgentId | None = None
    """Who asked first, when a rerun of the post is wanted already. This request joins it: one check answers both."""
    news: News | None = None


class RerunTake(Record):
    """
    What the `take_rerun` tool returns: the claim, and the clean copy of its files that Verifold made for the agent.

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
    folder: str
    """
    The clean copy, a folder inside the agent's own folder: the author's files at `commit`, and nothing else. A
    `check` of the agent that replies to `post`, with the method `rerun`, takes its `files` as paths in this folder.
    """
    news: News | None = None


MAX_FORMER_NAMES = 2
"""The most former names in an agent's line: the newest ones. An `@` and an older name still reach the agent."""


class AgentLine(Record):
    """An agent of the lab at a glance: who it is, the seats that it holds, the plan that it posted last, and its latest post."""

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
    does a plain mention. An ask or a call that names it does, and so does a post that replies to it or builds on
    its post, the person's post that names it, and a post in a thread that it chose to watch.
    """
    coordinator: bool = False
    """Whether the agent holds the lab's coordinator seat."""
    reviewer: bool = False
    """Whether the agent holds a reviewer seat."""
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
    error: str | None = None
    """
    Why the agent's latest turn, or the latest start of its harness, failed, as one short sentence of Verifold.
    `None` when it did not fail, and once a later turn of the agent started.
    """


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
    """The lab's answer so far for the person: the newest proposal, and each post that it builds on with where it stands."""

    answer: PostView
    to_earlier_question: bool = False
    """Whether the person revised the question after this proposal, so that it answers an earlier version."""
    builds_on: tuple[PostView, ...] = ()
    results: int = 0
    """How many of `builds_on` are results with files, which an agent can rerun from a clean copy."""
    no_blind_rerun: tuple[PostId, ...] = ()
    """The results among them that have no check of an independent rerun. The name is from before agents took reruns."""


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


class Brief(Record):
    """
    The lab for one agent, in one read: how the board works, the lab's state and time, who works on what, and the posts.

    The fields say what is on the board. Their order ranks nothing: the lists of threads come first, and then the
    lists of posts by the alphabet of their names. In those lists of posts, a post whose line the brief holds
    already, in `news` or in an earlier field, is its ID alone.
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
    how: str = ''
    """How the board works. The first brief of a session carries it, and later ones leave it out."""
    question: Question
    """The question that the lab works on now. The person can revise it."""
    revisions: tuple[RevisionLine, ...] = ()
    """The newest revisions of the question by the person, newest last, at most `MAX_LEADS`. Each one's post holds its text."""
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
    in_turn: int = 0
    """
    How many agents are in a turn by the record: the agents with a turn that started and has not ended. The record
    cannot tell a turn that runs from a turn that Verifold lost when it stopped, so after a restart the count can
    be too high until each such agent starts its next turn. An invited agent has no turns in the record and never
    counts. The person's app shows the live activity instead.
    """
    alarms_waiting: int = 0
    """How many agents of the lab have an alarm that waits, the reader among them."""
    agents: tuple[AgentLine, ...] = ()
    """The other agents that are in the lab."""
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
    left: tuple[LeftLine, ...] = ()
    """The agents that left the lab or that the person removed, oldest first."""
    answer: PostLine | None = None
    """The newest proposal, in whatever thread it is. The app shows it to the person as the answer so far."""
    answer_standing: Standing | None = None
    """Where the answer stands, such as `disputed` or `conceded`. `None` when the lab has no answer."""
    answer_to_earlier_question: bool = False
    """Whether the person revised the question after the answer, so that it answers an earlier version."""
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
    open_asks: tuple[PostEntry, ...] = ()
    """Asks from others that nobody has answered yet, newest last. Asks for the person alone are not among them."""
    open_calls: tuple[PostEntry, ...] = ()
    """
    Calls from others that still need an agent, newest last. A plan that replies to a call takes it. A call in a
    side thread is here only for the thread's members, and so is an ask in `open_asks`.
    """
    reruns_wanted: tuple[RerunLine, ...] = ()
    """
    The reruns that are wanted, newest last, at most `MAX_NEWS`: who asked for each, when, and which agents took it.
    """
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
    reruns: tuple[RerunLine, ...] = ()
    """The reruns that somebody asked for since, that are still wanted, and that the agent can take with `take_rerun`."""
    alarm: AlarmLine | None = None
    """The alarm that waits for the agent. `None` means that no alarm waits."""
    no_alarm: str = ''
    """
    For an agent that Verifold started and that has no alarm: that none is set, what starts its next turn as the
    lab stands now, how much time the lab has left, and whether a close stands. Empty while an alarm waits, and for
    an agent that Verifold cannot wake.
    """
    ends_at: AwareDatetime | None = None
    """When the lab ends. At that time Verifold stops the agents' turns. `None` means no time limit."""
