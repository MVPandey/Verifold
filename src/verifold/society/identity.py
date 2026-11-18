"""
Who an agent is on the board, as facts: its name, its seat's label, the seats that it holds, and its role.

An agent's name is the name that it chose, or else the label of its seat. The label is the harness's title and the
model's name, and it stays a fact of its own beside a chosen name. A post shows the label as it was when the post
was written, so an older post keeps the model that wrote it.
"""

import re
from datetime import datetime

from verifold.protocol.agents import GUEST, SeatMark
from verifold.protocol.events import Posted
from verifold.protocol.ids import PERSON, AgentId
from verifold.protocol.join import MAX_SEAT, Byline, PostLine, PostView
from verifold.protocol.posts import MoveRequest
from verifold.protocol.votes import NEWEST_VOTES
from verifold.society.board import Board
from verifold.society.coordinator import request_end, request_waits
from verifold.society.labels import is_numbered, plain
from verifold.society.rounds import for_reader, sealed, stripped
from verifold.society.standing import standing
from verifold.society.tested import how_tested
from verifold.society.votes import badge_lines, marks, vote_lines
from verifold.society.votes import sealed as votes_sealed

GUEST_LABEL = 'Own harness · model not reported'
"""The label of an invited agent's seat. It runs in a harness that Verifold does not know, and reports no model."""


def seat_label(board: Board, agent_id: AgentId, before: int | None = None) -> str:
    """
    Return the label of an agent's seat, as it is now or, with `before`, as it was just before that event.

    A turn's start records the model that the harness reported. When that model is not the one in the seat's
    label, the label of that time names the reported model, so a post keeps the model that wrote it.
    """
    joined = board.agent(agent_id)
    if joined is None:
        return agent_id
    if joined.agent.harness == GUEST:
        return GUEST_LABEL
    label = board.label(agent_id, before)
    start = next(
        (
            turn
            for turn in reversed(board.starts)
            if turn.agent == agent_id and (before is None or turn.seq < before) and (turn.model_name or turn.model)
        ),
        None,
    )
    title, dot, _ = label.partition(' · ')
    if start is None or not dot:
        return label
    reported = plain(title, start.model_name or start.model)
    if is_numbered(label, reported):
        return label
    # The seat keeps its number: the second seat of a model is still the second when both report another model.
    number = re.search(r' (\d+)$', label)
    second = number is not None and any(text == label[: number.start()] for _, _, text in board.labels)
    return f'{reported}{number.group(0)}' if number and second else reported


def seat_marks(board: Board, agent_id: AgentId) -> tuple[SeatMark, ...]:
    """Return the seats that an agent holds now, in a fixed order: coordinator, reviewer, on call, desk."""
    held: tuple[tuple[SeatMark, bool], ...] = (
        ('coordinator', board.coordinator == agent_id),
        ('reviewer', board.reviewer(agent_id)),
        ('on_call', board.on_call(agent_id)),
        ('desk', board.is_desk(agent_id)),
    )
    return tuple(mark for mark, holds in held if holds)


def byline(board: Board, entry: Posted, cut: int | None = None) -> Byline | None:
    """
    Return who wrote a post: the author's name, its seat's label when the post was written, its seats, and its role.

    The role is the author's own word, or else the role that somebody gave its seat. With `cut`, a longer label
    keeps that many characters and ends with an ellipsis. A post of the person has no byline.
    """
    author = entry.post.author
    joined = board.agent(author)
    if author == PERSON or joined is None:
        return None
    seat = seat_label(board, author, entry.seq)
    if cut is not None and len(seat) > cut:
        seat = f'{seat[: cut - 1]}…'
    role, _ = board.profile(author)
    return Byline(
        name=joined.agent.name,
        seat='' if seat == joined.agent.name else seat,
        marks=seat_marks(board, author),
        role=role or board.given_role(author)[0],
    )


def post_line(
    board: Board, entry: Posted, reader: AgentId, now: datetime | None = None, *, news: bool = False
) -> PostLine:
    """
    Return a post as one line for `reader` at `now`: who wrote it, its votes, its badges, and how checks tested it.

    While the votes on the post are sealed for the reader, the line has no counts, as a line of a post without
    votes. While the post is an entry of an open round that another agent wrote, the line holds nothing of its
    content. With `news`, the line is one of the news, which carries a post of the person with its body.
    """
    hidden = sealed(board, reader, entry, now)
    shown = stripped(entry) if hidden else entry
    up, down, badges = marks(board, entry.post.id)
    counts = (0, 0) if votes_sealed(board, reader, entry, now) else (up, down)
    return PostLine.of(
        shown,
        byline(board, entry, MAX_SEAT),
        (*counts, badges),
        news=news,
        sealed=hidden,
        tested=how_tested(board, entry.post.id),
    )


def post_view(
    board: Board, entry: Posted, reader: AgentId, now: datetime | None = None, *, votes: int = NEWEST_VOTES
) -> PostView:
    """
    Return a post with its time, who wrote it, where it stands, the posts that build on it, its votes, and its badges.

    A result also has how checks tested it.

    While the votes on the post are sealed for `reader` at `now`, it has no counts and no votes. While the post is
    an entry of an open round that another agent wrote, it holds nothing of the entry's content, and no post
    shows that a sealed entry builds on it.
    """
    hidden = sealed(board, reader, entry, now)
    shown = not votes_sealed(board, reader, entry, now)
    up, down, _ = marks(board, entry.post.id) if shown else (0, 0, ())
    return PostView(
        seq=entry.seq,
        at=entry.at,
        post=stripped(entry).post if hidden else entry.post,
        sealed=hidden,
        by=byline(board, entry),
        standing=standing(board, entry.post.id),
        tested=how_tested(board, entry.post.id),
        built_on_by=tuple(other.post.id for other in for_reader(board, reader, now).built_on(entry.post.id)),
        decision=board.answer_to(entry.post.id) if isinstance(entry.post, MoveRequest) else None,
        waits=request_waits(board, entry),
        ended=None if board.answer_to(entry.post.id) else request_end(board, entry),
        up=up,
        down=down,
        votes=vote_lines(board, entry.post.id, votes) if shown else (),
        badges=badge_lines(board, entry.post.id),
    )
