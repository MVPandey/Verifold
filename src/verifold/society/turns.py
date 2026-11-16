"""What the record holds about an agent's turns, so that the agent goes on from there after Verifold restarts."""

from dataclasses import dataclass

from verifold.protocol.events import TurnStarted
from verifold.protocol.ids import AgentId
from verifold.society.board import Board


@dataclass(frozen=True, slots=True)
class Before:
    """Where an agent was when the record's last event came."""

    seen: int
    """The last event that the agent had got. A seat that starts here brings the agent every post after it."""
    session: str | None = None
    """The ID of the agent's conversation in its harness, or `None` when the record holds none."""
    worked: bool = False
    """Whether the record holds a turn of the agent."""
    cut_off: bool = False
    """Whether the agent's last turn started and did not end."""
    rested: TurnStarted | None = None
    """The start of the agent's last turn, when the record shows that the agent ended that turn by its own choice."""
    ended: int = 0
    """The sequence number of the end of the agent's last turn, or zero when no turn of the agent ended."""
    stopped: bool = False
    """Whether Verifold stopped the agent after its harness failed too often, and no turn of it started since."""


def before(board: Board, agent_id: AgentId) -> Before:
    """
    Return where an agent was, from its turns in the record.

    An entry for a harness that failed outside a turn ends no turn, so it changes only whether Verifold stopped the
    agent. A turn that did not end takes the agent back to what it had seen when that turn started, because the turn can
    have lost the tool results that carried its posts. An agent whose turns hold no read position has read the
    board up to its own last post, or up to its join when it has none. That is so in a record from before Verifold
    kept read positions, and for an agent that has no turn.
    """
    started = next((turn for turn in reversed(board.starts) if turn.agent == agent_id), None)
    entries = tuple(turn for turn in board.turns if turn.agent == agent_id)
    # A harness that failed outside a turn ended no turn, so the agent is still where its last turn left it.
    ended = next((turn for turn in reversed(entries) if not turn.no_turn), None)
    cut_off = started is not None and (ended is None or ended.seq < started.seq)
    if started and cut_off:
        seen = started.seen
    elif ended and ended.seen is not None:
        seen = ended.seen
    else:
        own = (entry.seq for entry in board.posts if entry.post.author == agent_id)
        joined = board.agent(agent_id)
        seen = max(own, default=joined.seq if joined else board.seq)
    chose = bool(started and ended and not cut_off and ended.error is None and ended.seen is not None)
    return Before(
        seen=seen,
        session=started.session if started else None,
        worked=started is not None or ended is not None,
        cut_off=cut_off,
        rested=started if chose else None,
        ended=ended.seq if ended else 0,
        stopped=stopped(board, agent_id),
    )


def stopped(board: Board, agent_id: AgentId, before: int | None = None) -> bool:
    """
    Return whether Verifold stopped an agent after its harness failed too often, and no turn of it started since.

    A harness that is not on the computer fails at every start, so Verifold stops its seat in the same way. With
    `before`, the answer is as it was just before that event.
    """
    ahead = lambda seq: before is None or seq < before
    ended = next((turn for turn in reversed(board.turns) if turn.agent == agent_id and ahead(turn.seq)), None)
    started = next((turn for turn in reversed(board.starts) if turn.agent == agent_id and ahead(turn.seq)), None)
    return bool(ended and ended.stopped and (started is None or started.seq < ended.seq))
