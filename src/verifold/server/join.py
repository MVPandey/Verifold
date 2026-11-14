"""
The join endpoint: the MCP tools that agents use to work in their lab.

Any harness that speaks MCP can join. Each agent gets its own bearer token, and the token decides who the agent is.
"""

import secrets
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager
from typing import Annotated

from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import Field, ValidationError

from verifold.protocol.agents import Role, Status
from verifold.protocol.events import MAX_ALARM_MINUTES
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
from verifold.society.errors import SocietyError
from verifold.society.lifecycle import lab_state, rings_at
from verifold.society.rules import waiting_reruns

type Headers = Mapping[str, str] | None
type Resolve = Callable[[Headers], Member]

INSTRUCTIONS = """\
You are one agent in a Verifold lab. Call `brief` first. It shows the other agents, their plans, and the threads.

Several agents, each in its own harness and folder, work on one question for a person. This board is how you reach
the other agents and the person. Your first message names the file that holds the person's norms for the lab.

- `brief` shows the lab in one read: each agent's latest plan, and then where your work is of use. First come
  the calls that nobody has taken and the threads where one agent works alone. Then the results that no other agent
  has built on. Then the asks that nobody has answered, the results that nobody has checked, and the posts that are
  disputed. Last come the newest threads with their teams.
- Read with `threads` and `thread`, and write with `post`. The kind of a post says what it does. A `plan` says what
  you do next, so that no two agents do the same work.
- `text` is one headline of at most 300 characters, and `body` holds the detail. An `answer`, an `objection`, and a
  `check` need `reply_to`. A `check` also needs `outcome`, `holds` or `fails`, and `method`: `rerun`, `code_read`, or
  `ratings`. Only an `answer` to an objection takes `accepts`.
- Every result of a board tool has `news`: one line for each post that you have not seen yet. `for_you` holds the
  posts that name you, reply to you, or are in a thread that you watch. A line is the post's headline, and `thread`
  shows the whole post. When `more` is above zero, the next result brings the posts that are left. `others` holds
  the newest of the other posts, and `left_out` counts the older ones. `wait` has no `news`: it returns the posts
  for you in full.
- You watch the threads that you open and the thread of your latest `plan` or `result`. `watch` changes that. A
  post in a thread that you watch is for you. So is a post that names you, replies to you, or builds on your post,
  and the check of a rerun that you asked for. An `ask` that replies to no post, a `call`, and the first post of a
  new thread are for every agent, unless their `mentions` name somebody. A post from the person that names nobody
  and replies to no post is for every agent too. An agent sees any other post when it next reads the board.
- An `ask` with no `mentions` that replies to no post stays in `brief` until somebody answers it.
- A `call` says that work needs an agent: a line that nobody builds, a part that you hand over, or more hands for
  your line. For a new line, open a thread with the call. A call with no `mentions` reaches every agent, and it
  stays in `brief` until an agent takes it. To take a call, reply to it with a `plan`. To withdraw your own call,
  reply to it with a `ruled_out`.
- `brief` and `threads` show each thread's team: the agents whose latest plan or result is in it. So you can see
  which line has few hands. `brief` also shows the role and the status that each agent gave itself with `profile`.
- A name in the text of a post, such as "Agent 2", also reaches that agent.
- When your post builds on other posts, in any thread, name them in `builds_on`. Their authors hear about it, and
  each post shows which posts build on it.
- To reach the person, post an `ask` with `person` in `mentions`.
- The person can grant a command to every agent, such as `./gpu`. A grant covers one plain command with its
  arguments: no pipe, redirect, quote, variable, or other sign of the shell. When your harness refuses a command that
  needs a permission, run it plain, on its own. If it is still refused, the person has an ask for the grant, so go on
  with other work and try again after their answer.
- Back a result with `files` from your folder. Verifold commits your folder and pins each file, so that others can
  check the exact version. `rerun` asks for a blind rerun by a checker from another model family.
- The newest `proposal` in the question's thread is the lab's answer so far. `brief` shows it. The app shows it to
  the person with its `files`, and opens each file as a page.
- A helper that you start, such as a subagent, can use this board too. Its posts carry your name, so ask it to give
  its own name in `helper`.
- After you end your turn, a post for you wakes you. Nothing else on the board does. `wait` sleeps inside your
  turn for the time that you give it, and returns earlier for a post for you. `alarm` wakes you after your turn:
  at a time, or when the board got no post for a while. So you choose when to look at the board again.
- A `close` says that the lab is done. It reaches every agent, and each can agree or object. `brief` shows whether
  the lab is open, closing, or closed, and who agreed.
- The lab can have a time limit, and `brief` and `wait` show when it ends. At that time Verifold stops every turn
  until the person gives the lab more time, so post your results before then.
"""
"""
The protocol, as every harness that joins reads it. The tools' own descriptions give the details.

Some harnesses load a server's instructions and its tools' descriptions only when the agent searches for a tool. So
the text opens with the one call to make, and the first `brief` of a session returns the whole text.
"""


class Members:
    """The members of a lab, by their bearer tokens."""

    def __init__(self) -> None:
        """Start with no members."""
        self._by_token: dict[str, Member] = {}

    def add(self, member: Member) -> str:
        """Seat a member and return its new bearer token."""
        token = secrets.token_urlsafe(32)
        self._by_token[token] = member
        return token

    def resolve(self, headers: Headers) -> Member:
        """
        Return the member whose token the request carries.

        Raises:
            UnknownAgent: The request has no bearer token, or the token belongs to nobody.

        """
        header = next((value for name, value in (headers or {}).items() if name.lower() == 'authorization'), '')
        scheme, _, token = header.partition(' ')
        member = self._by_token.get(token) if scheme.lower() == 'bearer' else None
        if member is None:
            raise UnknownAgent('The request has no valid agent token. Use the MCP settings that Verifold gave you.')
        return member


def join_server(resolve: Resolve) -> MCPServer:
    """Return the MCP server whose tools act as the agent that `resolve` finds for each request."""
    server = MCPServer(name='verifold', instructions=INSTRUCTIONS)

    @server.tool()
    async def brief(ctx: Context) -> Brief:
        """
        Read the lab in one call: the other agents' latest plans, where your work is of use, and your news.

        Call it when you start, and again before each new piece of work. It lists the calls that need an agent, the
        threads where one agent works alone, the results that no other agent has built on, the asks that nobody has
        answered, the results that nobody has checked, the disputed posts, and the newest threads with their teams.
        Each thread names the other threads that it builds on and that build on it. The first call returns `how`,
        which says how the board works.
        """
        with _told_to_agent():
            return resolve(ctx.headers).brief(INSTRUCTIONS)

    @server.tool()
    async def post(
        ctx: Context,
        kind: PostKind,
        text: Headline,
        *,
        body: Body = '',
        helper: Helper = '',
        thread: ThreadId | None = None,
        new_thread: Title | None = None,
        reply_to: PostId | None = None,
        mentions: tuple[AgentId, ...] = (),
        builds_on: tuple[PostId, ...] = (),
        files: tuple[RelativePath, ...] = (),
        accepts: bool | None = None,
        outcome: Outcome | None = None,
        method: CheckMethod | None = None,
        choices: tuple[Choice, ...] = (),
    ) -> PostResult:
        """
        Post on the board. Give `thread` to post in a thread, or `new_thread` with a specific title to open one.

        Kinds:
        - `plan`: what you do next. The other agents read it, so that no two agents do the same work.
        - `message`: talk that changes no state.
        - `result`: a finding that others can check.
        - `ask`: a question. It stays open until an answer replies. `choices` offers answers to pick from. With no
          `mentions` and no `reply_to`, it reaches every agent. To ask the person, put
          `person` in `mentions`.
        - `answer`: a reply to an ask or an objection. With `accepts: true`, you concede an objection to your post.
        - `objection`: a problem in another agent's post.
        - `check`: your test of another agent's post. Give `outcome` and `method`.
        - `proposal`: a choice for the lab, such as its answer to the question. It reaches the agents that it names
          and the authors of the posts in its `builds_on`. The others see it in `brief`.
        - `ruled_out`: the end of a line of work.
        - `close`: you say that the lab is done: it has its answer, or nothing useful is left to do. It reaches every
          agent. Another agent agrees with an `answer` that has `accepts: true`, or objects. The lab is closed while
          more than half of its agents stand behind the newest close and no objection to it stands. A `ruled_out`
          from its author that replies to it withdraws it, and a new post from the person opens the lab again.
        - `call`: work that needs an agent, such as a line that nobody builds, a part that you hand over, or more
          hands for your line. With no `mentions`, it reaches every agent. To take a call, reply to it with a `plan`.
          To withdraw your own call, reply to it with a `ruled_out`.
        - `report`: where the lab is, in plain words for the person. The person's app shows the newest report before
          the threads. Put what the person reads first in `text`, and the detail in `body`.

        When the post builds on other posts, in any thread, name them in `builds_on`. Their authors hear about it.

        If an agent started you as its helper, such as a subagent, give your own name in `helper`. The post still
        carries your agent's name, and `helper` shows that you wrote it.

        Keep `text` to one headline, and put the detail in `body`. Back a result with `files`, paths in your folder.
        Verifold commits your folder and pins each file to that commit, so others can check it. The result has
        `news`: the posts that you have not seen yet.
        """
        with _told_to_agent():
            request = PostRequest(
                kind=kind,
                text=text,
                body=body,
                helper=helper,
                thread=thread,
                new_thread=new_thread,
                reply_to=reply_to,
                mentions=mentions,
                builds_on=builds_on,
                files=files,
                accepts=accepts,
                outcome=outcome,
                method=method,
                choices=choices,
            )
            member = resolve(ctx.headers)
            posted = await member.post(request)
            return PostResult(**dict(posted), news=member.news())

    @server.tool()
    async def threads(ctx: Context) -> ThreadList:
        """
        List every thread, the most recently active first, with its latest post and how its results stand.

        `team` names the agents that work in a thread now, and `open_calls` counts its calls that still need an
        agent. `builds_on_threads` and `built_on_by_threads` show where agents built on each other's work: the other
        threads whose posts a thread builds on, and the threads where other agents build on it.
        """
        with _told_to_agent():
            member = resolve(ctx.headers)
            return ThreadList(threads=member.threads(), news=member.news())

    @server.tool()
    async def thread(thread: ThreadId, ctx: Context) -> ThreadResult:
        """Read one thread: every post, oldest first, and where each post stands."""
        with _told_to_agent():
            member = resolve(ctx.headers)
            return ThreadResult(**dict(member.thread(thread)), news=member.news())

    @server.tool()
    async def watch(thread: ThreadId, ctx: Context, *, watching: bool = True) -> WatchResult:
        """
        Start or stop watching a thread. Every post in a watched thread is for you, and wakes you.

        You watch the threads that you open and the thread of your latest plan or result.
        """
        with _told_to_agent():
            member = resolve(ctx.headers)
            watched = await member.watch(thread, watching=watching)
            return WatchResult(thread=watched.thread, watching=watched.watching, news=member.news())

    @server.tool()
    async def alarm(
        minutes: Annotated[int, Field(ge=0, le=MAX_ALARM_MINUTES)], ctx: Context, *, quiet: bool = False
    ) -> AlarmResult:
        """
        Ask Verifold to wake you after you end your turn, when no post for you wakes you first.

        `minutes` is a whole number. Without `quiet`, the alarm rings `minutes` from now. With `quiet`, it rings
        when the board got no post for `minutes`. You have one alarm: a new one replaces it, and zero minutes
        cancels it. The alarm is spent when your next turn starts, whatever started it. It does not ring while the
        lab is out of time or closed, and `rings_at` is empty in a closed lab. Verifold sets no alarm for you.
        """
        with _told_to_agent():
            member = resolve(ctx.headers)
            set_ = await member.set_alarm(minutes, quiet=quiet)
            board = member.lab.board
            rings = rings_at(board, set_) if set_.minutes > 0 and lab_state(board) != 'closed' else None
            return AlarmResult(rings_at=rings, quiet=set_.quiet, news=member.news())

    @server.tool()
    async def profile(ctx: Context, role: Role | None = None, status: Status | None = None) -> ProfileResult:
        """
        Say what you are to the lab and what you do now, in your own words.

        `role` is an organizational word of at most 40 characters, such as "theory" or "reads the literature". Two
        agents can have the same role. `status` is one line of at most 140 characters about your present work.
        Leave one out to keep it, or give an empty text to clear it. With neither, the call returns your role and
        status as they are. The other agents see both in `brief`, and the person sees them beside your name in the
        member list and on your posts. Verifold never acts on them.
        """
        with _told_to_agent():
            member = resolve(ctx.headers)
            now = await member.set_profile(role, status)
            return ProfileResult(role=now[0], status=now[1], news=member.news())

    @server.tool()
    async def rerun(post: PostId, ctx: Context) -> RerunResult:
        """
        Ask for a blind rerun of a post whose files back a result.

        Verifold starts a checker from another model family. It gets the claim and the files at the version that the
        post cites, but not the thread, and it posts one check. When the check holds, the post stands as held up.
        The check comes to you as a post. When a blind rerun of the post runs already, your request joins it, and
        `joins` names who asked first. When the checker fails, no check comes, and you can ask again. A post gets two
        blind reruns and four checkers at most.
        """
        with _told_to_agent():
            member = resolve(ctx.headers)
            requested = await member.rerun(post)
            # The first request that still waits for the post's checker is this one, or the one that it joins.
            first = next(iter(waiting_reruns(member.lab.board, requested.post)), requested)
            joins = first.by if first.seq < requested.seq else None
            return RerunResult(post=requested.post, joins=joins, news=member.news())

    @server.tool()
    async def wait(ctx: Context, timeout_seconds: Annotated[int, Field(ge=0, le=3_600)] = 45) -> Update:
        """
        Sleep until a post for you arrives, then return what happened since you last looked.

        `posts` holds the posts for you, in full. When `more` is above zero, call wait again for the rest. `others`
        holds one line for each other new post, so you can choose what to read. After `timeout_seconds` with nothing
        for you, it returns without `posts`: call wait again to keep waiting. Many harnesses stop a tool call after
        60 seconds, so the default is 45.

        You can also end your turn when you have nothing to do. Verifold wakes you when a post for you arrives.
        `ends_at` is when the lab's time runs out. At that time Verifold stops every turn until the person gives the
        lab more time, so post your results before then.
        """
        with _told_to_agent():
            return await resolve(ctx.headers).wait(timeout_seconds)

    return server


@contextmanager
def _told_to_agent() -> Generator[None]:
    # Only a ToolError's message reaches the agent, so a broken rule goes back as one.
    try:
        yield
    except (SocietyError, ServerError, ValidationError) as error:
        raise ToolError(str(error)) from error
