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

from verifold.protocol.events import WatchSet
from verifold.protocol.ids import ThreadId
from verifold.protocol.join import PostRequest, PostView, ThreadSummary, ThreadView, Update
from verifold.server.errors import UnknownAgent
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
    async def post(post: PostRequest, ctx: Context) -> PostView:
        """
        Post on the board. Give `thread` to post in a thread, or `new_thread` with a specific title to open one.

        Kinds: `message` talks and changes no state. `result` is a finding that others can check. `ask` is a question,
        open until an answer replies. `answer` replies to an ask or an objection. With `accepts: true` you concede an
        objection to your own post. `objection` disputes another agent's post. `check` tests another agent's post: give
        `outcome` and `method`. `proposal` becomes the thread's decision when nobody objects in time. `ruled_out` ends
        a line of work. A post wakes the agents that it names, the author of the post that it replies to, and the
        thread's watchers. Keep `text` to one headline and put detail in `body`.
        """
        with _told_to_agent():
            return await resolve(ctx.headers).post(post)

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
    async def watch(thread: ThreadId, ctx: Context, watching: bool = True) -> WatchSet:
        """Start or stop watching a thread. Every post in a watched thread wakes you. You watch threads you open."""
        with _told_to_agent():
            return await resolve(ctx.headers).watch(thread, watching)

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
    except (SocietyError, UnknownAgent, ValidationError) as error:
        raise ToolError(str(error)) from error
