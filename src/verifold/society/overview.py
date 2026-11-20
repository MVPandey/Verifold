"""
The lab as the desk reads it: what the person's app shows, in one result of bounded size.

The overview holds facts of the board only. The agents' turns come from the record, because this package does no
I/O and so knows no live activity.
"""

from datetime import datetime

from verifold.protocol.agents import GUEST
from verifold.protocol.deliverables import DeliverableLine
from verifold.protocol.ids import AgentId, ThreadId
from verifold.protocol.join import (
    MAX_NEWS,
    MAX_OBSTACLES,
    MAX_OVERVIEW_OFFERS,
    CandidateLine,
    DiskLine,
    News,
    Overview,
    PersonWait,
    SeatLine,
)
from verifold.protocol.usage import DiskUse
from verifold.society.allowances import allowance_line
from verifold.society.board import Board
from verifold.society.budget import budget_line, disk_limit
from verifold.society.candidates import closes_on
from verifold.society.coordinator import waiting_for_reply
from verifold.society.deliverables import deliverable_lines
from verifold.society.identity import post_line, seat_label, seat_marks
from verifold.society.lifecycle import lab_state, minutes_left
from verifold.society.lines import lines_of
from verifold.society.obstacles import obstacles
from verifold.society.pace import pause_line
from verifold.society.reruns import reruns_wanted
from verifold.society.standing import candidates, closing, standing
from verifold.society.tested import rests_on
from verifold.society.turns import before
from verifold.society.views import (
    minutes_since,
    newest_report,
    round_line,
    standing_reading,
    to_earlier_question,
    waiting_posts,
)


def overview(
    board: Board, desk: AgentId, now: datetime, news: News | None = None, disk: DiskUse | None = None
) -> Overview:
    """
    Return the lab for the desk at `now`: its time, budget, and disk, its agents and their turns, and what the app shows.

    Those are what waits for the person, the lab's reading of the question, the newest report, the candidate
    answers that stand, the open round, the
    wanted reruns, the open obstacles, the deliverables, and the person's post in the conversation that waits for
    the coordinator's reply. Each list holds its newest `MAX_NEWS` entries at most, and counts the others. Each
    deliverable holds its newest `MAX_OVERVIEW_OFFERS` offers, with the accepted one among them, and counts the
    others. `disk` is what Verifold measured of the lab's files last.
    """
    working = lines_of(board)
    done = closing(board)
    named = closes_on(board, done) if done else None
    waits = waiting_posts(board, now)
    reported = newest_report(board)
    reading = standing_reading(board)
    standing_now = candidates(board)
    wanted = reruns_wanted(board, now)
    blocking = tuple(found.entry for found in reversed(obstacles(board)) if found.state == 'open')
    waiting = waiting_for_reply(board)
    return Overview(
        question=board.question,
        state=lab_state(board),
        close=post_line(board, done, desk, now) if done else None,
        closes_on=named.post.id if named else None,
        ends_at=board.ends_at,
        minutes_left=minutes_left(board, now),
        agents=tuple(
            _seat_line(board, joined.agent.id, working, now)
            for joined in board.agents
            if not joined.agent.checks and board.here(joined) and not board.is_desk(joined.agent.id)
        ),
        left=len(board.left),
        coordinator=board.coordinator,
        conversation=board.conversation,
        desk_chat=board.desk_chat,
        no_reply=PersonWait(
            line=post_line(board, waiting[0], desk, now),
            minutes=minutes_since(waiting[0].at, now) or 0,
            more=len(waiting) - 1,
        )
        if waiting
        else None,
        waits=tuple(post_line(board, entry, desk, now) for entry in waits[-MAX_NEWS:]),
        more_waits=max(len(waits) - MAX_NEWS, 0),
        report=post_line(board, reported, desk, now) if reported else None,
        report_minutes_ago=minutes_since(reported.at, now) if reported else None,
        reading=post_line(board, reading, desk, now) if reading else None,
        reading_minutes_ago=minutes_since(reading.at, now) if reading else None,
        candidates=tuple(
            CandidateLine(
                line=post_line(board, entry, desk, now),
                minutes_ago=minutes_since(entry.at, now) or 0,
                standing=standing(board, entry.post.id),
                to_earlier_question=to_earlier_question(board, entry),
                rests_on=rests_on(board, entry),
            )
            for entry in standing_now[-MAX_NEWS:]
        ),
        more_candidates=max(len(standing_now) - MAX_NEWS, 0),
        round=round_line(board, desk, now),
        reruns_wanted=wanted[-MAX_NEWS:],
        more_reruns=max(len(wanted) - MAX_NEWS, 0),
        obstacles=tuple(post_line(board, entry, desk, now) for entry in blocking[:MAX_OBSTACLES]),
        more_obstacles=max(len(blocking) - MAX_OBSTACLES, 0),
        deliverables=tuple(_bounded(line) for line in deliverable_lines(board)),
        out_of_time=board.out_of_time,
        budget=budget_line(board),
        limit_reached=board.at_limit,
        disk=DiskLine(lab=disk.total, limit=disk_limit(board)) if disk else None,
        allowances=tuple(
            line
            for joined in board.agents
            if board.acting(joined.agent.id) and (line := allowance_line(board, joined.agent.id, now))
        ),
        actions_paused=board.actions_paused is not None,
        news=news,
    )


def _bounded(line: DeliverableLine) -> DeliverableLine:
    # The newest offers of a deliverable, and the accepted one among them whatever its age, in their order.
    kept = sorted(line.offers, key=lambda offer: (offer.state == 'accepted', offer.at))[-MAX_OVERVIEW_OFFERS:]
    offers = tuple(offer for offer in line.offers if offer in kept)
    return line.model_copy(update={'offers': offers, 'more_offers': len(line.offers) - len(offers)})


def _seat_line(board: Board, agent_id: AgentId, working: dict[AgentId, ThreadId | None], now: datetime) -> SeatLine:
    joined = board.agent(agent_id)
    agent = joined.agent if joined else None
    was = before(board, agent_id)
    started = next((turn for turn in reversed(board.starts) if turn.agent == agent_id), None)
    ended = next((turn for turn in reversed(board.turns) if turn.agent == agent_id and not turn.no_turn), None)
    seat = seat_label(board, agent_id)
    name = agent.name if agent else agent_id
    return SeatLine(
        id=agent_id,
        name=name,
        seat='' if seat == name else seat,
        marks=seat_marks(board, agent_id),
        status=board.profile(agent_id)[1],
        thread=working.get(agent_id),
        in_turn=was.cut_off,
        turn_since=started.at if started and was.cut_off else None,
        turn_ended_at=ended.at if ended and not was.cut_off else None,
        invited=bool(agent and agent.harness == GUEST),
        stopped=was.stopped,
        pause=pause_line(board, agent_id, now),
    )
