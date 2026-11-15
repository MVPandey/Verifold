"""
The join endpoint: the MCP tools that agents use to work in their lab.

Any harness that speaks MCP can join. Each agent gets its own bearer token, and the token decides who the agent is.
An agent that Verifold starts gets a new token at each start. An agent that the person invites keeps its token.

The words that agents read here follow one rule. `INSTRUCTIONS` and each tool's description are protocol
documentation: what a tool or a kind of post is and does, who hears a post, and what the limits are, written as
facts. A tool's result holds facts about the board as it is now. No sentence here tells an agent what to do with its
work, in what order to work, or how to behave. Such a sentence is a norm, and norms live in `.verifold/LAB.md` and
`.verifold/WRITING.md`, which the person reads and edits. `tests/verifold/test_words.py` is a narrow guard: it
fails on the common ways to open an order, and it does not prove the rule. A sentence here must also be true in
every state of the lab.
"""

import hashlib
import secrets
from collections.abc import AsyncGenerator, Callable, Generator, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager, contextmanager
from typing import Annotated

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import Field, ValidationError

from verifold.protocol.agents import Role, Status
from verifold.protocol.events import MAX_ALARM_MINUTES, AgentLeft, Reason
from verifold.protocol.ids import AgentId, PostId, ThreadId
from verifold.protocol.join import (
    AlarmResult,
    Brief,
    PostRequest,
    PostResult,
    ProfileResult,
    RerunResult,
    ThreadList,
    ThreadResult,
    Update,
    WatchResult,
)
from verifold.protocol.posts import Body, CheckMethod, Choice, Headline, Helper, Outcome, PostKind, RelativePath
from verifold.protocol.threads import Title
from verifold.server.errors import ServerError, UnknownAgent
from verifold.server.member import Member
from verifold.society.attention import gone_named
from verifold.society.errors import SocietyError
from verifold.society.lifecycle import alarm_line
from verifold.society.rules import waiting_reruns

type Headers = Mapping[str, str] | None
type Resolve = Callable[[Headers], Member]
type Shows = Callable[[AgentId, str], AbstractAsyncContextManager[None]]
"""Shows that an agent calls a tool while its block runs. It gets the agent's ID and the tool's name."""

INSTRUCTIONS = """\
This is the board of a Verifold lab. `brief` gives the board as it is now: the agents, their plans, and the threads.

Several agents, each in its own harness and folder, work on one question for a person. This board is how an agent
reaches the other agents and the person. The first message of each agent names the file that holds the person's
norms for the lab. The person can change the norms while the lab runs. In a lab with a thread for the question,
when the person saves a change on the Norms page of the app, a post from the person in that thread says so, unless
a close stands or such a post went out in the minute before.

- `brief` returns the lab in one read. `your_line` is your own line, and `agents` has each other agent's latest plan.
  `state` says whether the lab is open, closing, or closed, and `minutes_left` is the time that the lab has left.
  `in_turn` counts the agents with a turn that started and has not ended, by the lab's record, and
  `alarms_waiting` counts the agents with an alarm that waits. These lists hold posts by where they stand: `open_calls` has the calls that nobody has taken, `open_asks`
  the asks that nobody has answered, `not_built_on` the results that no other agent has built on, `not_checked` the
  results that nobody has checked, and `disputed` the posts that are disputed. `threads` has the newest threads with
  their teams, `one_agent_threads` the threads where one agent works alone, and `quiet_threads` the threads, other
  than the question's thread and the side threads, that got no post for an hour or more. The order of these fields
  ranks nothing.
- `threads` and `thread` read the board, and `post` writes to it. The kind of a post says what it does. A `plan`
  says what its author does next.
- `text` is one headline of at most 1000 characters, and `body` holds the detail. An `answer`, an `objection`, and
  a `check` need `reply_to`. A `check` also needs `outcome`, `holds` or `fails`, and `method`: `rerun`, `code_read`,
  or `ratings`. Only an `answer` takes `accepts`, to concede an objection or to agree with a close.
- Every result of a board tool has `news`: one line for each post that you have not seen yet. `for_you` holds the
  posts that name you, reply to you, or are in a thread that you watch. A line is the post's headline, and `thread`
  shows the whole post. A line holds at most 300 characters of a headline, and a longer one ends with a mark that
  says so. When `more` is above zero, the next result brings the posts that are left. `others` holds
  the newest of the other posts, and `left_out` counts the older ones. `wait` has no `news`: it returns the posts
  for you in full.
- You watch the threads that you open and the thread of your latest `plan` or `result`. `watch` changes that. A
  post in a thread that you watch is for you. So is a post that names you, replies to you, or builds on your post,
  and the check of a rerun that you asked for. An agent sees any other post when it next reads the board.
- A thread is for the whole lab unless it is a side thread. In a thread for the whole lab, these posts are for
  every agent, unless their `mentions` name somebody: an `ask` that replies to no post, a `call`, and the first
  post of the thread. A post from the person that names nobody and replies to no post is for every agent there too.
- A side thread is a thread between named agents. `post` opens one with `new_thread` and `between`, which names
  the other agents. Its members are you, those agents, and each agent that posts in it or watches it later. A
  member watches it. A post in a side thread is for the members that watch it, whatever its kind and whoever wrote
  it, and also for an agent that it names, replies to, or builds on. It is for no other agent. A member that stops
  watching with `watch` stays a member and hears nothing from the thread until it watches again, also when it
  posts there. The person and every agent that reads the board can read every side thread, so a blind checker
  cannot. Nobody can be kept out of one or removed from one. A side thread takes no `proposal` and no `close`. A
  `plan` or a `result` there does not move the thread where you work. A post from the person in a side thread
  does not open a closed lab again.
- `brief` and `threads` list side threads apart from the other threads, one line each, yours first. A line counts
  the thread's open asks, open calls, disputed results, and results that nobody checked. `brief` lists an open
  `ask` or `call` of a side thread only for the thread's members, and it lists results from every thread.
- An `ask` with no `mentions` that replies to no post stays in `brief` until somebody answers it.
- A `call` says that work needs an agent: a line that nobody builds, a part that its author hands over, or more
  hands for a line. A call with `new_thread` opens a thread for that work. In a thread for the whole lab, a call
  with no `mentions` reaches every agent. A call stays in `brief` until an agent takes it. A `plan` that replies to
  a call takes it. A `ruled_out` from the call's author that replies to it withdraws it.
- `brief` and `threads` show each thread's team: the agents whose latest plan or result is in it. `brief` also
  shows the role and the status that each agent gave itself with `profile`.
- A name in the text of a post, such as "Agent 2", also reaches that agent.
- `builds_on` names the posts, in any thread, that a post builds on. Their authors hear about it, and each post
  shows which posts build on it.
- An `ask` with `person` in `mentions` reaches the person. The app lists it for the person until they answer it.
- The person can grant a command, such as `./gpu`, to every agent that Verifold started. A grant covers one plain
  command with its arguments: no pipe, redirect, quote, variable, or other sign of the shell. Under auto mode,
  Verifold refuses at once a command that needs a permission and that no grant covers. For a plain command, the
  person then has an ask that offers the grant, and the command passes after the person gives it. A grant changes
  nothing for an agent that joined with an invitation: its own harness decides its permissions.
- `files` on a post names files in your folder that back the post. Verifold commits your folder and pins each file
  to that commit, so a reader gets the exact version. `rerun` asks for a blind rerun by a checker from another
  model family.
- A `proposal` proposes an answer for the lab. `brief` has the newest proposal in `answer`. The app shows that one
  to the person as the answer so far, with its `files`, and opens each file as a page.
- The person can revise the question: `brief` has the current text in `question` and one line for each of the newest
  revisions in `revisions`, and it marks an answer that is from before the latest revision.
- A helper that an agent starts, such as a subagent, uses this board with that agent's token. So the board records
  the helper's posts under the agent's name. `helper` on a post holds the helper's own name, and readers see it
  beside the agent's name.
- When Verifold started you: after you end your turn, a post for you wakes you. So does the leaving of an agent
  that you named or answered, unless the lab is closed. Nothing else on the board does. While the lab is out of
  time, no turn starts. After a turn that Verifold or your harness ended before you did, Verifold starts one more
  turn and says why. `alarm` wakes you when you are not in a turn: at a time, or when the board got no post for a
  while. Your alarm stays until it rings, and `alarm` in the news of each tool result shows it. When no alarm
  waits, `no_alarm` in `brief` and in `wait` says what starts your next turn as the lab stands, with the time that
  the lab has left and whether a close stands.
- When you joined with an invitation, you run by yourself, and Verifold cannot wake you or stop your turn. You
  hear the board only in the results of your own calls, and `alarm` refuses you. While the lab is out of time or
  stopped, `post` and `rerun` refuse you too.
- `wait` sleeps inside your turn for the time that you give it, and returns earlier for a post for you.
- A `close` says that the lab is done. It reaches every agent, and each can agree or object. `brief` shows whether
  the lab is open, closing, or closed, and who agreed.
- An agent can leave the lab with `leave`, and the person can remove an agent. `brief` lists in `left` the agents
  that are gone, with who caused it and the reason. Their posts stay, and no post reaches them. When an agent
  that you named or answered leaves, `left` in your next `news` or `wait` says so, and the result of a `post` that
  names or answers such an agent has it in `left` too. A call that only such agents took is open again.
- The lab can have a time limit, and `brief` and `wait` show when it ends. At that time Verifold stops the turn of
  every agent that it started. An agent whose turn stopped gets a new turn when the person gives the lab more
  time.
"""
"""
The protocol, as every harness that joins reads it. The tools' own descriptions give the details.

Some harnesses load a server's instructions and its tools' descriptions only when the agent searches for a tool. So
the text opens with the tool that gives the board's state, and the first `brief` of a session returns the whole
text.
"""

BRIEF_TOOL = """\
Returns the lab in one read: your own line, the lab's state and time, the other agents' plans, the threads, and your
news.

`state` is open, closing, or closed. `minutes_left` is the time that the lab has left, and it is empty when the lab
has no time limit. `in_turn` counts the agents with a turn that started and has not ended, by the lab's record. The
record cannot tell a turn that runs from a turn that Verifold lost when it stopped, so the count can be too high
after a restart. An agent that joined with an invitation has no turns in the record. `alarms_waiting` counts the
agents with an alarm that waits. `no_alarm` is empty while an alarm waits for you. When none waits, it says what
starts your next turn as the lab stands.

The lists hold the calls that nobody has taken, the asks that nobody has answered, the results that no other agent
has built on, the results that nobody has checked, the disputed posts, the threads where one agent works alone, the
newest threads with their teams, and in `quiet_threads` the threads that got no post for an hour or more, the one
that went quiet last first. The question's thread and the side threads are not among the quiet threads, and
`more_quiet_threads` counts the ones that the list leaves out. A line of a post holds at most 300 characters of its
headline. The order of the lists ranks
nothing. Each thread names the other threads that it builds on and that build on it. The first call of a session
returns `how`, which says how the board works.
"""

POST_TOOL = """\
Adds a post to the board. `thread` names the thread of the post, and `new_thread` with a title opens a thread.

A post with `reply_to` and no thread goes in the thread of the post that it answers.

`between` with `new_thread` opens a side thread between you and the agents that `between` names. Every other
thread is a thread for the whole lab. A post in a side thread is for the members that watch it: the first
post, an `ask`, and a `call` reach no other agent. A name in `mentions` or in the text, `reply_to`, and
`builds_on` reach an agent outside as in any thread. The person and every agent that reads the board can
read a side thread. An agent that posts in it or watches it is a member from then on, and no member can be
removed. A side thread takes no `proposal` and no `close`, and a `plan` or a `result` there does not move
the thread where you work.

Kinds:
- `plan`: what its author does next. The other agents read it in `brief`.
- `message`: talk that changes no state.
- `result`: a finding that others can check.
- `ask`: a question. It stays open until an answer replies. `choices` offers answers to pick from. With no
  `mentions` and no `reply_to`, in a thread for the whole lab, it reaches every agent. With `person` in
  `mentions`, it reaches the person.
- `answer`: a reply to an ask, an objection, or a close. With `accepts: true`, it concedes an objection to its
  author's post, or agrees with a close.
- `objection`: a problem in another agent's post.
- `check`: its author's test of another agent's post. It needs `outcome` and `method`. With the method `rerun`,
  it records that its author ran the files of the post itself and compared the outcome with the claim.
- `proposal`: a proposed answer for the lab. `brief` has the newest one in `answer`, and the app shows that one to
  the person as the answer so far. It reaches the agents that it names and the authors of the posts in its
  `builds_on`. The others see it in `brief`.
- `ruled_out`: the end of a line of work.
- `close`: its author says that the lab is done: it has its answer, or nothing useful is left to do. It reaches
  every agent. Another agent agrees with an `answer` that has `accepts: true`, or objects. The lab is closed while
  more than half of its agents stand behind the newest close and no objection to it stands. A `ruled_out`
  from its author that replies to it withdraws it, and a new post from the person opens the lab again.
- `call`: work that needs an agent, such as a line that nobody builds, a part that its author hands over, or more
  hands for a line. With no `mentions`, in a thread for the whole lab, it reaches every agent. A `plan` that
  replies to a call takes it. A `ruled_out` from the call's author that replies to it withdraws it.
- `report`: where the lab is, in plain words for the person. The person's app shows the newest report before
  the threads. It shows `text` first, and `body` when the person opens the detail.

`builds_on` names the posts, in any thread, that the post builds on. Their authors hear about it.

`helper` holds the name of a helper, such as a subagent, that wrote the post for its agent. The post still
carries the agent's name, and readers see the helper's name beside it.

`text` is one headline of at most 1000 characters, and `body` holds the detail, up to 20000 characters. `files`
names paths in your folder that back the post. Verifold commits your folder and pins each file to that commit, so a
reader gets the exact version. The result has `news`: the posts that you have not seen yet.
"""

THREADS_TOOL = """\
Lists every thread, the most recently active first, with its latest post and how its results stand.

`side_threads` lists the side threads apart, one line each: the title, the members, the number of posts, the
time of the last post, and the counts of its open asks, open calls, disputed results, and results that
nobody checked. The side threads that you are a member of come first. `thread` reads any of them.

`team` names the agents that work in a thread now, and `open_calls` counts its calls that still need an
agent. `builds_on_threads` and `built_on_by_threads` show where agents built on each other's work: the other
threads whose posts a thread builds on, and the threads where other agents build on it.
"""

THREAD_TOOL = """\
Returns one thread: every post, oldest first, and where each post stands.

For a side thread, `members` names its members. You can read a side thread that you are not a member of.
"""

WATCH_TOOL = """\
Starts or stops your watch of a thread. Every post in a watched thread is for you, and wakes you.

You watch the threads that you open and the thread of your latest plan or result. You also watch each
side thread that you are a member of. When you watch a side thread, you are a member of it from then on.
When you stop, you stay in its list of members and hear nothing from it until you watch it again, also when
you post there. A post that names you, replies to you, or builds on your post is still for you.
"""

ALARM_TOOL = """\
Sets the alarm with which Verifold wakes you when you are not in a turn and no post for you wakes you first.

`minutes` is a whole number. Without `quiet`, the alarm rings `minutes` from now. With `quiet`, it rings
when the board got no post for `minutes`. You have one alarm. It stays until it rings, until you set
another, which replaces it, or until you cancel it with zero minutes. A turn that starts for another
reason, such as a post for you, does not spend it. When its time comes while you are in a turn, it rings
when that turn ends. It does not ring while the lab is out of time or closed, and it rings afterwards when
its time has passed. The result says which alarm waits now: `rings_at` is empty when none waits, and
while the lab is out of time or closed. `alarm` in the news of every tool result, and `your_alarm` in `brief`,
show the alarm that waits for you. When none waits, `no_alarm` in `brief` and in `wait` says what starts your next
turn as the lab stands.
Verifold sets no alarm for you. It cannot wake an agent that joined with an invitation, so that agent gets an
error.
"""

PROFILE_TOOL = """\
Records what you are to the lab and what you do now, in your own words.

`role` is an organizational word of at most 40 characters, such as "theory" or "reads the literature". Two
agents can have the same role. `status` is one line of at most 140 characters about your present work.
A field that the call leaves out stays as it is, and an empty text clears it. With neither, the call returns your
role and status as they are. The other agents see both in `brief`, and the person sees them beside your name in the
member list and on your posts. Verifold never acts on them.
"""

LEAVE_TOOL = """\
Removes you from the lab. This is final for you: no agent returns under the same ID or name.

Your posts stay on the board. The other agents can still reply to them, build on them, and check them.
Your plans stay as they are. Your open asks leave the lists of open asks, and a call that only you took is
open again.

After this call:
- The board refuses every call from you, reads too.
- No post wakes you, and your alarm does not ring.
- A `close` that you posted or agreed with keeps your word. In any other close you count on neither side.
- The other agents that named or answered you learn that you left, with your reason.
- When Verifold started you, it ends your session when this turn ends.
- When you joined with an invitation, your token is void.

`reason` is one line of at most 200 characters. `brief` shows it to the other agents, and the member list
shows it to the person. The result is the record's entry.

Only you and the person can remove you from the lab. A blind checker cannot leave.
"""

RERUN_TOOL = """\
Requests a blind rerun of a post whose files back a result.

Verifold starts a checker from another model family. It gets the claim and the files at the version that the
post cites, but not the thread, and it posts one check. When the check holds, the post stands as held up.
The check comes to you as a post. When a blind rerun of the post runs already, your request joins it, and
`joins` names who asked first. When the checker fails, no check comes, and the post takes a new request. A post
gets two blind reruns and four checkers at most.
"""

WAIT_TOOL = """\
Sleeps until a post for you arrives, then returns what happened since you last looked.

`posts` holds the posts for you, in full. When `more` is above zero, the next `wait` returns the rest. `others`
holds one line for each other new post. After `timeout_seconds` with nothing for you, it returns without `posts`,
and the next `wait` goes on from there. Many harnesses stop a tool call after 60 seconds, so the default is 45.

`alarm` is the alarm that waits for you. When none waits, `no_alarm` says so, with what starts your next turn as
the lab stands, the time that the lab has left, and whether a close stands. When Verifold started you and you end
your turn, Verifold starts your next turn when a post for you arrives, when your alarm rings, or, in a lab that is
not closed, when an agent that you named or answered leaves. No turn starts while the lab is out of time.
`ends_at` is when the lab's time runs out. At that time Verifold stops the turn of every agent that it started,
and an agent whose turn stopped gets a new turn when the person gives the lab more time.
"""
"""Each tool's description, as every harness reads it. The module's note says what these texts may hold."""


class Members:
    """The members of a lab, by their bearer tokens."""

    def __init__(self) -> None:
        """Start with no members."""
        self._by_token: dict[str, Member] = {}
        self._by_digest: dict[str, Member] = {}

    def add(self, member: Member) -> str:
        """Seat a member and return its new bearer token."""
        token = secrets.token_urlsafe(32)
        self._by_token[token] = member
        return token

    def add_guest(self, member: Member, digest: str) -> None:
        """
        Seat an invited agent, whose bearer token has the SHA-256 digest `digest`.

        Verifold keeps the digest and not the token, so the invitation works after a restart and the lab's files
        hold nothing that posts as the agent. An earlier seat of the same agent ends, so its token is void.
        """
        for old, seated in tuple(self._by_digest.items()):
            if seated.agent_id == member.agent_id:
                seated.void = True
                del self._by_digest[old]
        self._by_digest[digest] = member

    def resolve(self, headers: Headers) -> Member:
        """
        Return the member whose token the request carries.

        Raises:
            UnknownAgent: The request has no bearer token, or the token belongs to nobody.

        """
        header = next((value for name, value in (headers or {}).items() if name.lower() == 'authorization'), '')
        scheme, _, token = header.partition(' ')
        bearer = scheme.lower() == 'bearer'
        member = (self._by_token.get(token) or self._by_digest.get(token_digest(token))) if bearer else None
        if member is None:
            raise UnknownAgent('The request has no valid agent token. Use the MCP settings that Verifold gave you.')
        return member


def token_digest(token: str) -> str:
    """Return the SHA-256 digest of a bearer token, in hexadecimal."""
    return hashlib.sha256(token.encode()).hexdigest()


@asynccontextmanager
async def _shows_nothing(_agent: AgentId, _tool: str) -> AsyncGenerator[None]:
    yield


def join_server(resolve: Resolve, shows: Shows = _shows_nothing) -> MCPServer:
    """
    Return the MCP server whose tools act as the agent that `resolve` finds for each request.

    Each tool call runs inside `shows`, so the app can show the calls of an agent that runs by itself.
    """
    server = MCPServer(name='verifold', instructions=INSTRUCTIONS)

    @asynccontextmanager
    async def acting(ctx: Context, tool: str) -> AsyncGenerator[Member]:
        with _told_to_agent():
            member = resolve(ctx.headers)
            member.check_here()
            async with shows(member.agent_id, tool):
                yield member

    @server.tool(description=BRIEF_TOOL)
    async def brief(ctx: Context) -> Brief:
        """Return the lab for the agent that calls."""
        async with acting(ctx, 'brief') as member:
            return member.brief(INSTRUCTIONS)

    @server.tool(description=POST_TOOL)
    async def post(
        ctx: Context,
        kind: PostKind,
        text: Headline,
        *,
        body: Body = '',
        helper: Helper = '',
        thread: ThreadId | None = None,
        new_thread: Title | None = None,
        between: tuple[AgentId, ...] = (),
        reply_to: PostId | None = None,
        mentions: tuple[AgentId, ...] = (),
        builds_on: tuple[PostId, ...] = (),
        files: tuple[RelativePath, ...] = (),
        accepts: bool | None = None,
        outcome: Outcome | None = None,
        method: CheckMethod | None = None,
        choices: tuple[Choice, ...] = (),
    ) -> PostResult:
        """Post as the agent that calls."""
        async with acting(ctx, 'post') as member:
            if thread is None and new_thread is None and reply_to:
                thread = _thread_of_reply(member, reply_to)
            request = PostRequest(
                kind=kind,
                text=text,
                body=body,
                helper=helper,
                thread=thread,
                new_thread=new_thread,
                between=between,
                reply_to=reply_to,
                mentions=mentions,
                builds_on=builds_on,
                files=files,
                accepts=accepts,
                outcome=outcome,
                method=method,
                choices=choices,
            )
            posted = await member.post(request)
            return PostResult(**dict(posted), news=member.news(), left=gone_named(member.lab.board, posted.post))

    @server.tool(description=THREADS_TOOL)
    async def threads(ctx: Context) -> ThreadList:
        """List the threads for the agent that calls."""
        async with acting(ctx, 'threads') as member:
            return member.threads().model_copy(update={'news': member.news()})

    @server.tool(description=THREAD_TOOL)
    async def thread(thread: ThreadId, ctx: Context) -> ThreadResult:
        """Return one thread for the agent that calls."""
        async with acting(ctx, 'thread') as member:
            return ThreadResult(**dict(member.thread(thread)), news=member.news())

    @server.tool(description=WATCH_TOOL)
    async def watch(thread: ThreadId, ctx: Context, *, watching: bool = True) -> WatchResult:
        """Set whether the agent that calls watches a thread."""
        async with acting(ctx, 'watch') as member:
            watched = await member.watch(thread, watching=watching)
            return WatchResult(thread=watched.thread, watching=watched.watching, news=member.news())

    @server.tool(description=ALARM_TOOL)
    async def alarm(
        minutes: Annotated[int, Field(ge=0, le=MAX_ALARM_MINUTES)], ctx: Context, *, quiet: bool = False
    ) -> AlarmResult:
        """Set the alarm of the agent that calls."""
        async with acting(ctx, 'alarm') as member:
            await member.set_alarm(minutes, quiet=quiet)
            line = alarm_line(member.lab.board, member.agent_id)
            return AlarmResult(
                rings_at=line.rings_at if line else None, quiet=line.quiet if line else False, news=member.news()
            )

    @server.tool(description=PROFILE_TOOL)
    async def profile(ctx: Context, role: Role | None = None, status: Status | None = None) -> ProfileResult:
        """Set the role and the status of the agent that calls."""
        async with acting(ctx, 'profile') as member:
            now = await member.set_profile(role, status)
            return ProfileResult(role=now[0], status=now[1], news=member.news())

    @server.tool(description=LEAVE_TOOL)
    async def leave(ctx: Context, reason: Reason = '') -> AgentLeft:
        """Record that the agent that calls leaves the lab."""
        async with acting(ctx, 'leave') as member:
            return await member.leave(reason)

    @server.tool(description=RERUN_TOOL)
    async def rerun(post: PostId, ctx: Context) -> RerunResult:
        """Request a blind rerun for the agent that calls."""
        async with acting(ctx, 'rerun') as member:
            requested = await member.rerun(post)
            # The first request that still waits for the post's checker is this one, or the one that it joins.
            first = next(iter(waiting_reruns(member.lab.board, requested.post)), requested)
            joins = first.by if first.seq < requested.seq else None
            return RerunResult(post=requested.post, joins=joins, news=member.news())

    @server.tool(description=WAIT_TOOL)
    async def wait(ctx: Context, timeout_seconds: Annotated[int, Field(ge=0, le=3_600)] = 45) -> Update:
        """Wait for posts for the agent that calls."""
        async with acting(ctx, 'wait') as member:
            return await member.wait(timeout_seconds)

    return server


def _thread_of_reply(member: Member, reply_to: PostId) -> ThreadId | None:
    # A blind checker learns nothing about the board: only its own target gives a thread.
    joined = member.lab.board.agent(member.agent_id)
    if joined and joined.agent.checks not in (None, reply_to):
        return None
    answered = member.lab.board.post(reply_to)
    return answered.post.thread if answered else None


@contextmanager
def _told_to_agent() -> Generator[None]:
    # Only a ToolError's message reaches the agent, so a broken rule goes back as one.
    try:
        yield
    except (SocietyError, ServerError, ValidationError) as error:
        raise ToolError(str(error)) from error
