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

from verifold.protocol.events import RerunRequested, WatchSet
from verifold.protocol.ids import AgentId, PostId, ThreadId
from verifold.protocol.join import PostRequest, PostView, ThreadSummary, ThreadView, Update
from verifold.protocol.posts import Body, CheckMethod, Headline, Outcome, PostKind, RelativePath
from verifold.protocol.threads import Title
from verifold.server.errors import ServerError, UnknownAgent
from verifold.server.member import Member
from verifold.society.errors import SocietyError

type Headers = Mapping[str, str] | None
type Resolve = Callable[[Headers], Member]

INSTRUCTIONS = (
    'You are an agent in a Verifold lab: a shared board where several agents work on one research question. '
    'Read with threads and thread, talk with post, choose what wakes you with watch, and call wait to sleep until a '
    'post for you arrives.'
)


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
    async def post(
        ctx: Context,
        kind: PostKind,
        text: Headline,
        *,
        body: Body = '',
        thread: ThreadId | None = None,
        new_thread: Title | None = None,
        reply_to: PostId | None = None,
        mentions: tuple[AgentId, ...] = (),
        files: tuple[RelativePath, ...] = (),
        accepts: bool | None = None,
        outcome: Outcome | None = None,
        method: CheckMethod | None = None,
    ) -> PostView:
        """
        Post on the board. Give `thread` to post in a thread, or `new_thread` with a specific title to open one.

        Kinds:
        - `message`: talk that changes no state.
        - `result`: a finding that others can check.
        - `ask`: a question. It stays open until an answer replies.
        - `answer`: a reply to an ask or an objection. With `accepts: true`, you concede an objection to your post.
        - `objection`: a problem in another agent's post.
        - `check`: your test of another agent's post. Give `outcome` and `method`.
        - `proposal`: a choice for the lab. It becomes the decision when nobody objects in time.
        - `ruled_out`: the end of a line of work.

        Keep `text` to one headline, and put the detail in `body`. Back a result with `files`, paths in your folder.
        Verifold commits your folder and pins each file to that commit, so others can check it. A post wakes the
        agents that it names, the author of the post that it replies to, and the thread's watchers.
        """
        with _told_to_agent():
            request = PostRequest(
                kind=kind,
                text=text,
                body=body,
                thread=thread,
                new_thread=new_thread,
                reply_to=reply_to,
                mentions=mentions,
                files=files,
                accepts=accepts,
                outcome=outcome,
                method=method,
            )
            return await resolve(ctx.headers).post(request)

    @server.tool()
    async def threads(ctx: Context) -> tuple[ThreadSummary, ...]:
        """List every thread, the most recently active first, and whether you watch it."""
        with _told_to_agent():
            return resolve(ctx.headers).threads()

    @server.tool()
    async def thread(thread: ThreadId, ctx: Context) -> ThreadView:
        """Read one thread: every post, oldest first, and where each post stands."""
        with _told_to_agent():
            return resolve(ctx.headers).thread(thread)

    @server.tool()
    async def watch(thread: ThreadId, ctx: Context, *, watching: bool = True) -> WatchSet:
        """Start or stop watching a thread. Every post in a watched thread wakes you. You watch threads you open."""
        with _told_to_agent():
            return await resolve(ctx.headers).watch(thread, watching=watching)

    @server.tool()
    async def rerun(post: PostId, ctx: Context) -> RerunRequested:
        """
        Ask for a blind rerun of a post whose files back a result.

        Verifold starts a checker from another model family. It gets the claim and the files at the version that the
        post cites, but not the thread, and it posts one check. When the check holds, the post stands as held up.
        """
        with _told_to_agent():
            return await resolve(ctx.headers).rerun(post)

    @server.tool()
    async def wait(ctx: Context, timeout_seconds: Annotated[int, Field(ge=0, le=3_600)] = 45) -> Update:
        """
        Sleep until a post for you arrives, then return what happened since you last looked.

        `posts` holds the posts for you. The other fields summarize the rest of the lab, so you can choose what to
        read. After `timeout_seconds` with nothing for you, it returns the summary alone: call wait again to keep
        waiting. Many harnesses stop a tool call after 60 seconds, so the default is 45.
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
