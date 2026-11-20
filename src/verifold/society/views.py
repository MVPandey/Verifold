"""
The board as one agent, or the person, sees it.

A view holds what is on the board, as facts. `brief` ranks nothing and gives no advice: what an agent does with
the board is the agent's choice, and the person's norms are in the lab's `LAB.md`.
"""

from collections import Counter
from collections.abc import Callable, Sequence
from datetime import datetime, timedelta
from itertools import accumulate

from verifold.protocol.agents import GUEST, POWERS, Agent
from verifold.protocol.events import (
    ERROR_AT_LIMIT,
    ERROR_INTERRUPTED,
    ERROR_MODEL_REFUSED,
    ERROR_OUT_OF_TIME,
    ERROR_RAN_PAST,
    Posted,
    ThreadOpened,
    TurnEnded,
)
from verifold.protocol.ids import PERSON, AgentId, PostId, ThreadId
from verifold.protocol.join import (
    MAX_CANDIDATES,
    MAX_FORMER_NAMES,
    MAX_LEADS,
    MAX_LINKS,
    MAX_NEWS,
    MAX_OBSTACLES,
    QUIET_MINUTES,
    AgentLine,
    Brief,
    CandidateLine,
    CandidateRef,
    CandidatesView,
    CandidateView,
    DiskLine,
    LeftLine,
    News,
    ObstacleEntry,
    Obstacles,
    PersonWait,
    PostEntry,
    PostLine,
    PostView,
    ProfileResult,
    QuestionVersion,
    RerunLine,
    RevisionLine,
    RoundLine,
    RoundNote,
    SideLine,
    TaskEntry,
    ThreadLine,
    ThreadLink,
    ThreadSummary,
    ThreadView,
)
from verifold.protocol.posts import (
    Ask,
    Call,
    Check,
    Close,
    Objection,
    Plan,
    Proposal,
    Reading,
    Report,
    Result,
    Summary,
    Task,
)
from verifold.protocol.threads import Thread
from verifold.protocol.usage import DiskUse
from verifold.protocol.votes import BADGES, MAX_VOTE_LINES, NEWEST_VOTES
from verifold.society.attention import left_line, watches_thread
from verifold.society.board import Board
from verifold.society.budget import budget_line, disk_limit
from verifold.society.candidates import candidates, closes_on, gone, own_entry
from verifold.society.coordinator import request_waits, waiting_for_reply
from verifold.society.deliverables import deliverable_lines
from verifold.society.errors import NotFound
from verifold.society.fit import CUTS, Keep, Part, cut_line, fit
from verifold.society.identity import post_line, post_view, seat_label
from verifold.society.lifecycle import (
    alarm_line,
    lab_state,
    latest_time,
    minutes_left,
    minutes_text,
    no_alarm_line,
    pending_alarm,
)
from verifold.society.lines import is_line_of_work, lines_of, question_thread
from verifold.society.obstacles import obstacles
from verifold.society.pace import cap_line, cap_of, limits_of, pause_line, seats_near_limit
from verifold.society.reruns import rerun_checks, reruns_wanted
from verifold.society.reviewers import free_seats, holders, seats
from verifold.society.rounds import closes_at, entries, for_reader, open_round, waits_for
from verifold.society.standing import agreed, closing, is_answered, is_open_call, standing, waits_for_person
from verifold.society.summaries import in_sight, standing_summary
from verifold.society.tasks import claim_line, dropped, lapsed, open_tasks
from verifold.society.tested import rests_on, support
from verifold.society.turns import before
from verifold.society.votes import marks


def thread_view(  # noqa: PLR0913
    board: Board,
    agent_id: AgentId,
    thread_id: ThreadId,
    votes_of: PostId | None = None,
    now: datetime | None = None,
    *,
    fold: bool = False,
    read: int = 0,
) -> ThreadView:
    """
    Return a thread and its posts.

    Each post has its counts, its badges, and its newest votes with their reasons: `NEWEST_VOTES` for an agent,
    so that a long thread with many voters stays one tool result. The post that `votes_of` names has
    `MAX_VOTE_LINES`, and so has every post for the person. A post whose votes are sealed for the agent at `now`
    has no counts and no votes, and an entry that is sealed for it has no content.

    With `fold`, the view starts at the thread's summary while one stands. It leaves out the posts before the
    summary, other than the ones that stay in sight by `society.summaries.in_sight` and the post that `votes_of`
    names, and `earlier` says how many it left out. `read` is the event up to which the agent read the thread
    before, for the person's posts that stay in sight.

    Raises:
        NotFound: No thread has this ID, or the thread has no post with the ID in `votes_of`.

    """
    board = for_reader(board, agent_id, now)
    opened = board.thread(thread_id)
    if opened is None:
        raise NotFound(f'No thread has the ID {thread_id}.')
    named = board.post(votes_of) if votes_of else None
    if votes_of and (named is None or named.post.thread != thread_id):
        raise NotFound(f'Thread {thread_id} has no post with the ID {votes_of}.')

    def votes(entry: Posted) -> int:
        return MAX_VOTE_LINES if agent_id == PERSON or entry.post.id == votes_of else NEWEST_VOTES

    posts = board.thread_posts(thread_id)
    summary = standing_summary(board, thread_id)
    shown, earlier = posts, None
    if fold and summary:
        before = tuple(entry for entry in posts if entry.seq < summary.seq)
        kept = {entry.post.id for entry in in_sight(board, agent_id, before, read)} | {votes_of}
        shown = tuple(entry for entry in posts if entry.seq >= summary.seq or entry.post.id in kept)
        left = len(posts) - len(shown)
        earlier = _earlier(summary, left, len(before)) if left else None
    return ThreadView(
        thread=opened.thread,
        watching=watches_thread(board, agent_id, thread_id),
        members=board.members(thread_id),
        person_reaches=board.offer_listeners(thread_id) if board.holds_offers(thread_id) else None,
        summary=summary.post.id if summary else None,
        earlier=earlier,
        posts=tuple(post_view(board, entry, agent_id, now, votes=votes(entry)) for entry in shown),
    )


def _earlier(summary: Posted, left: int, before: int) -> str:
    """Return the line of a view that starts at a summary: how many posts before it the view leaves out, and how to read them."""
    return (
        f'This view starts at the summary {summary.post.id}. It leaves out {left} of the {before} posts before it, '
        'and `thread` with `whole: true` shows every post.'
    )


def thread_summaries(board: Board, agent_id: AgentId, now: datetime | None = None) -> tuple[ThreadSummary, ...]:
    """
    Return one summary for each thread, side threads among them, the most recently active first.

    The latest post of each thread shows its votes as `post_line` does for the agent at `now`, and the minutes since
    the newest result and plan of a line of work count to `now`. Without it, time counts from the board's newest post.
    An entry that is sealed for the agent counts as a post, and its content counts for nothing. The desk chat is
    among them for the person and the desk only: its posts are for them, and `thread` reads it for any agent.
    """
    board = for_reader(board, agent_id, now)
    now = now or latest_time(board)
    crossed = crossings(board)
    lines = lines_of(board)
    blocked = Counter(found.entry.post.thread for found in obstacles(board) if found.state == 'open')
    apart = agent_id != PERSON and not board.is_desk(agent_id)
    summaries = (
        _summary(board, agent_id, opened, crossed, lines, now=now, blocked=blocked[opened.thread.id])
        for opened in board.threads
        if not (apart and opened.thread.desk)
    )
    return tuple(sorted(summaries, key=lambda summary: summary.last_at, reverse=True))


def work_threads(summaries: tuple[ThreadSummary, ...]) -> tuple[ThreadSummary, ...]:
    """Return the summaries of the threads that are not side threads, in the order given."""
    return tuple(summary for summary in summaries if not summary.thread.between)


def side_lines(summaries: tuple[ThreadSummary, ...], agent_id: AgentId) -> tuple[SideLine, ...]:
    """Return one line for each side thread: first the ones that an agent is a member of, then in the order given."""
    lines = tuple(
        SideLine(
            id=summary.thread.id,
            title=summary.thread.title,
            members=summary.members,
            posts=summary.posts,
            last_at=summary.last_at,
            open_asks=summary.open_asks,
            open_calls=summary.open_calls,
            disputed=summary.disputed,
            not_checked=summary.not_checked,
        )
        for summary in summaries
        if summary.thread.between
    )
    return tuple(sorted(lines, key=lambda line: agent_id not in line.members))


type Crossing = tuple[Posted, Posted]
"""A post, and a post by another agent in another thread that builds on it."""


def crossings(board: Board) -> tuple[Crossing, ...]:
    """
    Return each time that an idea crossed between agents and threads, oldest first.

    An idea crosses when a post names, in `builds_on`, a post that another agent wrote in another thread. A link
    inside one thread, or between two posts of one agent, is the ordinary course of one line of work. A link to or
    from a post of the person is none either, because every line of work starts from the person's question. Nor is
    the link of a report, a reading, or a summary, because such a post names its sources and builds nothing on them.
    """
    by_id = {entry.post.id: entry for entry in board.posts}
    built = (entry for entry in board.posts if not isinstance(entry.post, Report | Reading | Summary | Close))
    pairs = ((by_id.get(source), entry) for entry in built for source in dict.fromkeys(entry.post.builds_on))
    return tuple(
        (source, entry)
        for source, entry in pairs
        if source
        and source.post.thread != entry.post.thread
        and source.post.author != entry.post.author
        and PERSON not in {source.post.author, entry.post.author}
    )


def _links(pairs: tuple[Crossing, ...]) -> tuple[ThreadLink, ...]:
    # Group crossings by the thread of the first post of each pair, and keep the threads with the most crossings.
    # Threads with the same number stay in the order that they first appear.
    threads = tuple(dict.fromkeys(other.post.thread for other, _ in pairs))
    links = (
        ThreadLink(
            thread=thread,
            agents=tuple(dict.fromkeys(other.post.author for other, _ in pairs if other.post.thread == thread)),
            count=sum(other.post.thread == thread for other, _ in pairs),
        )
        for thread in threads
    )
    return tuple(sorted(links, key=lambda link: link.count, reverse=True)[:MAX_LINKS])


def team(board: Board, opened: ThreadOpened, lines: dict[AgentId, ThreadId | None]) -> tuple[AgentId, ...]:
    """Return the agents that work in a thread now."""
    # The lab's agents that work in the thread now. The agent that opened the thread is in its team until it works
    # in another one, unless it opened the thread with a call, which says that the work needs somebody else. The
    # person, blind checkers, and agents that left are in no team. The question's thread has none, and neither has a
    # side thread, where no agent works.
    thread = opened.thread
    if thread.between or thread.conversation or thread.desk or thread.id == question_thread(board):
        return ()
    # The desk posts for the person and works in no thread, also in a thread that it opened for the person.
    workers = tuple(
        joined.agent.id
        for joined in board.agents
        if not joined.agent.checks and not board.gone(joined.agent.id) and not board.is_desk(joined.agent.id)
    )
    first = next((entry.post for entry in board.posts if entry.post.thread == thread.id), None)
    called = isinstance(first, Call | Task) and first.author == thread.opened_by
    opener = () if called or thread.opened_by in lines else (thread.opened_by,)
    return tuple(agent for agent in workers if agent in opener or lines.get(agent) == thread.id)


def _summary(  # noqa: PLR0913
    board: Board,
    agent_id: AgentId,
    opened: ThreadOpened,
    crossed: tuple[Crossing, ...],
    lines: dict[AgentId, ThreadId | None],
    *,
    now: datetime,
    blocked: int,
) -> ThreadSummary:
    entries = board.thread_posts(opened.thread.id)
    results = tuple(standing(board, entry.post.id) for entry in entries if isinstance(entry.post, Result))
    supports = tuple(support(board, entry.post.id) for entry in entries if isinstance(entry.post, Result))
    latest = entries[-1] if entries else None
    incoming = tuple((source, built) for source, built in crossed if built.post.thread == opened.thread.id)
    # The facts of a line of work. Every other thread has them empty.
    line = entries if is_line_of_work(opened.thread) else ()
    result_at, plan_at = line_times(board, opened.thread)
    badges = Counter(badge for entry in line for badge in marks(board, entry.post.id)[2])
    summary = standing_summary(board, opened.thread.id)
    return ThreadSummary(
        thread=opened.thread,
        watching=watches_thread(board, agent_id, opened.thread.id, lines),
        members=board.members(opened.thread.id),
        posts=len(entries),
        last_at=latest.at if latest else opened.at,
        latest=post_line(board, latest, agent_id, now) if latest else None,
        summary=post_line(board, summary, agent_id, now) if summary else None,
        disputed=results.count('disputed'),
        checked=sum(state in {'checked', 'held_up'} for state in results),
        not_checked=results.count('open'),
        challenged=supports.count('challenged'),
        reproduced_only=supports.count('reproduced_only'),
        # Nobody waits for the answer to an ask whose author left.
        open_asks=sum(
            isinstance(entry.post, Ask) and not is_answered(board, entry.post.id) and not board.gone(entry.post.author)
            for entry in entries
        ),
        open_calls=sum(isinstance(entry.post, Call) and is_open_call(board, entry.post.id) for entry in entries),
        team=team(board, opened, lines),
        builds_on_threads=_links(incoming),
        built_on_by_threads=_links(
            tuple((built, source) for source, built in crossed if source.post.thread == opened.thread.id)
        ),
        crossed=len(incoming),
        result_minutes_ago=minutes_since(result_at, now),
        plan_minutes_ago=minutes_since(plan_at, now),
        open_obstacles=blocked,
        badges={badge: badges[badge] for badge in BADGES if badges[badge]},
    )


def line_times(board: Board, thread: Thread) -> tuple[datetime | None, datetime | None]:
    """Return when the newest result and the newest plan of a line of work were posted, with `None` for each that it lacks."""
    posts = board.thread_posts(thread.id) if is_line_of_work(thread) else ()
    result = next((entry.at for entry in reversed(posts) if isinstance(entry.post, Result)), None)
    plan = next((entry.at for entry in reversed(posts) if isinstance(entry.post, Plan)), None)
    return result, plan


def minutes_since(at: datetime | None, now: datetime) -> int | None:
    """Return how many whole minutes lie between `at` and `now`, zero for a time after `now`, or `None` without `at`."""
    return max(int((now - at).total_seconds() // 60), 0) if at else None


def _built_on(board: Board, entry: Posted) -> bool:
    """
    Return whether work builds on a result already.

    Another agent of the lab builds on it with any post but a report, a reading, a summary, a check, or an
    objection, which name a post and build nothing. The result's own author builds on it with a later result, so
    only the newest result of an author's chain still waits.
    """
    workers = {joined.agent.id for joined in board.agents if not joined.agent.checks}
    return any(
        isinstance(other.post, Result)
        if other.post.author == entry.post.author
        else other.post.author in workers
        and not isinstance(other.post, Report | Reading | Summary | Check | Objection | Close)
        for other in board.built_on(entry.post.id)
    )


def brief(  # noqa: PLR0913, PLR0915
    board: Board,
    agent_id: AgentId,
    news: News,
    how: str = '',
    *,
    now: datetime | None = None,
    disk: DiskUse | None = None,
    page: Callable[[int], News] | None = None,
) -> Brief:
    """
    Return the lab for one agent in one read.

    It holds the agent's own line and notes, the lab's state and the time that it has left, how many agents are in
    a turn and how many have an alarm that waits, the other agents with their latest plans, the candidate answers
    that stand with the one that a close closes on, the newest report with its age, and the lab's reading of the
    question with its age, or a line that says that the lab has none. For the agent that holds the coordinator
    seat, it holds the person's oldest post in the conversation that waits for its reply, with its age and the
    number of later ones that wait too. Then come the threads: the newest ones, one line for each side
    thread, the threads where one agent works alone, and the threads that got no post for a long while. Then come
    the posts by where they stand: the disputed posts, the results that nobody has built on, the results that
    nobody has checked, the open obstacles with the counts of the others, the asks that nobody has answered, the
    calls that need an agent, and the tasks that nobody holds. Each agent's line has the task that it holds. The
    order ranks nothing. `how` says how the board works. The desk's brief holds
    the lab's facts and the desk's news, and no list of the lab's work, as `_desk_brief` says.

    The brief has `MAX_BRIEF` characters of JSON at most. The board cuts whole lines as `society.fit` says, and
    `cut` says what it left out. `page` returns the agent's news with at most the given number of posts for it,
    so that the news can end earlier than `news` does. Without it, the brief holds `news` as it is.

    `now` dates the time that the lab has left, the ages of the report, the reading, the notes, the candidates,
    and the person's post that waits for a reply, the quiet threads, the votes that are sealed for the agent, the
    open round and the entries that are sealed for the agent, and the leases on the wanted reruns. Without it,
    time counts from the board's newest post. The agents in a turn come from the record, because this package does
    no I/O and so knows no live activity. For the same reason, `disk` is what Verifold measured of the lab's files
    last, or `None`.
    """
    board = for_reader(board, agent_id, now)
    now = now or latest_time(board)
    # An invited agent that has not posted may never come, so no agent reads it as a peer to ask or wait for. An
    # agent that left is no peer either, and the brief lists it apart. The desk is no part of the lab's work, and
    # `desk` names it.
    others = tuple(
        joined.agent
        for joined in board.agents
        if joined.agent.id != agent_id
        and not joined.agent.checks
        and board.here(joined)
        and not board.is_desk(joined.agent.id)
    )
    stands = tuple((entry, standing(board, entry.post.id)) for entry in board.posts)
    # An ask or a call in a side thread is talk for the thread's members, and its side line counts it for the
    # others. A result is work, so every agent sees it in these lists, whatever thread holds it.
    not_mine = {
        opened.thread.id
        for opened in board.threads
        if opened.thread.between and agent_id not in board.members(opened.thread.id)
    }
    not_checked = tuple(
        entry
        for entry, state in stands
        if isinstance(entry.post, Result) and entry.post.author != agent_id and state == 'open'
    )[-MAX_NEWS:]
    disputed = tuple(entry for entry, state in stands if state == 'disputed')[-MAX_NEWS:]
    open_asks = tuple(
        entry
        for entry in board.posts
        if isinstance(entry.post, Ask)
        and entry.post.author != agent_id
        and entry.post.mentions != (PERSON,)
        and entry.post.thread not in not_mine
        and entry.post.thread not in (board.conversation, board.desk_chat)
        and not is_answered(board, entry.post.id)
        and not board.gone(entry.post.author)
    )[-MAX_NEWS:]
    open_calls = tuple(
        entry
        for entry in board.posts
        if isinstance(entry.post, Call)
        and entry.post.author != agent_id
        and entry.post.thread not in not_mine
        and is_open_call(board, entry.post.id)
    )[-MAX_NEWS:]
    every = thread_summaries(board, agent_id, now)
    summaries, side = work_threads(every), side_lines(every, agent_id)
    # A thread counts when an agent's latest plan or result is in it, so a thread that holds only notes is no line.
    working = lines_of(board)
    busy = set(working.values())
    alone = tuple(
        ThreadLine(id=summary.thread.id, title=summary.thread.title, team=summary.team)
        for summary in every
        if len(summary.team) == 1 and agent_id not in summary.team and summary.thread.id in busy
    )
    quiet = sorted(
        (
            summary
            for summary in summaries
            if summary.thread.id not in (question_thread(board), board.conversation)
            and now - summary.last_at >= timedelta(minutes=QUIET_MINUTES)
        ),
        key=lambda summary: summary.last_at,
        reverse=True,
    )
    # The agents that Verifold runs. An invited agent has no turns in the record, and a blind checker is no agent
    # of the lab. Nor is the desk, which is no part of the lab's work.
    run = tuple(
        joined.agent.id
        for joined in board.agents
        if not joined.agent.checks
        and joined.agent.harness != GUEST
        and not board.gone(joined.agent.id)
        and not board.is_desk(joined.agent.id)
    )
    not_built_on = tuple(
        entry
        for entry, state in stands
        if isinstance(entry.post, Result)
        and entry.post.author != agent_id
        and state not in {'conceded', 'disputed'}
        and not _built_on(board, entry)
    )[-MAX_LEADS:]
    found = obstacles(board)
    blocking = tuple(item.entry for item in reversed(found) if item.state == 'open')
    standing_candidates = candidates(board)
    older, shown = standing_candidates[:-MAX_CANDIDATES], standing_candidates[-MAX_CANDIDATES:]
    reported = newest_report(board)
    reading = standing_reading(board)
    done = closing(board)
    named = closes_on(board, done) if done else None
    you = board.agent(agent_id)
    close_line = post_line(board, done, agent_id, now) if done else None
    report_line = post_line(board, reported, agent_id, now) if reported else None
    reading_line = post_line(board, reading, agent_id, now) if reading else None
    waits = _person_waits(board, agent_id, now)
    your_line = _agent_line(board, you.agent, working, agent_id, now) if you else None
    agent_lines = tuple(_agent_line(board, agent, working, agent_id, now) for agent in others)
    wanted = reruns_wanted(board, now)[-MAX_NEWS:]
    gone_lines = tuple(left_line(board, entry) for entry in board.left)
    delivered = deliverable_lines(board)
    offers = sorted((offer for line in delivered for offer in line.offers), key=lambda offer: offer.at)
    notes = board.notes_of(agent_id)
    unheld = tuple(
        entry
        for entry in open_tasks(board, now)
        if entry.post.thread not in not_mine and entry.post.thread not in (board.conversation, board.desk_chat)
    )[-MAX_NEWS:]
    # The agents that posted last keep the lines of their plans and latest posts longest.
    posted_last = {entry.post.author: entry.seq for entry in board.posts}
    recent = tuple(sorted((agent.id for agent in others), key=lambda agent: posted_last.get(agent, 0)))

    # The brief's list of agents says who each agent is, so a line in the brief's own lists says who wrote the
    # post only for an author that the list does not hold, or whose seat had another label then.
    labels = {agent.id: seat_label(board, agent.id) for agent in (*others, *((you.agent,) if you else ()))}
    made: dict[tuple[PostId, bool], PostLine] = {}

    def line(entry: Posted, *, news: bool = False) -> PostLine:
        # The person is in no list of agents, so a line of the news keeps the person's body. The board can build
        # the brief more than once to fit it, so each line is made once.
        key = (entry.post.id, news)
        if key not in made:
            seat = labels.get(entry.post.author)
            made[key] = (
                post_line(board, entry, agent_id, now, news=news)
                if seat is None
                else _own_line(board, entry, seat, agent_id, now)
            )
        return made[key]

    def known(lines: tuple[PostLine, ...]) -> tuple[PostLine, ...]:
        # The lines of the news that this brief carries follow the same rule, so no author's name, seat, and
        # role stand in the brief twice.
        return tuple(line(entry, news=True) if (entry := board.post(one.id)) else one for one in lines)

    def latest(summary: ThreadSummary) -> ThreadSummary:
        # The latest line of each thread and the line of its summary follow the same rule.
        update = {
            name: line(entry)
            for name, kept in (('latest', summary.latest), ('summary', summary.summary))
            if kept and (entry := board.post(kept.id))
        }
        return summary.model_copy(update=update) if update else summary

    pages = {len(news.for_you): news}

    def news_of(most: int) -> News:
        if page is not None and most not in pages:
            pages[most] = page(most)
        return pages.get(most, news)

    base = Brief(
        you=agent_id,
        how=how,
        your_line=your_line,
        your_alarm=alarm_line(board, agent_id),
        no_alarm=no_alarm_line(board, agent_id, now),
        notes=notes.text if notes else None,
        notes_minutes_ago=minutes_since(notes.at, now) if notes else None,
        question=board.question,
        revisions=tuple(
            RevisionLine(at=entry.at, note=entry.note, post=entry.post, by=entry.by, request=entry.request)
            for entry in board.revisions[-MAX_LEADS:]
        ),
        state=lab_state(board),
        close=close_line,
        close_agreed=agreed(board, done) if done else (),
        ends_at=board.ends_at,
        minutes_left=minutes_left(board, now),
        budget=budget_line(board),
        limit_reached=board.at_limit,
        disk=DiskLine(folder=disk.folders.get(agent_id), lab=disk.total, limit=disk_limit(board)) if disk else None,
        your_limits=limits_of(board, agent_id, now),
        seats_near_limit=seats_near_limit(board, now),
        your_pause=pause_line(board, agent_id, now),
        your_cap=None if board.is_desk(agent_id) else cap_line(board, agent_id, now),
        lab_cap=cap_line(board, None, now),
        in_turn=sum(before(board, agent).cut_off for agent in run),
        alarms_waiting=sum(pending_alarm(board, joined.agent.id) is not None for joined in board.agents),
        coordinator=board.coordinator,
        coordinator_open=board.coordinator_open,
        reviewers=holders(board),
        reviewer_seats=seats(board),
        reviewer_seats_free=free_seats(board),
        vote_reveal_minutes=board.settings.votes.reveal_minutes,
        rerun_lease_minutes=board.settings.reruns.lease_minutes,
        task_lease_minutes=board.settings.tasks.lease_minutes,
        conversation=board.conversation,
        desk=board.desk,
        desk_chat=board.desk_chat,
        person_waits=waits,
        powers=tuple(power for power in POWERS if power in board.powers),
        closes_on=named.post.id if named else None,
        report=report_line,
        report_minutes_ago=minutes_since(reported.at, now) if reported else None,
        reading=reading_line,
        reading_minutes_ago=minutes_since(reading.at, now) if reading else None,
        no_reading=None if reading else _no_reading(board, now),
        round=round_line(board, agent_id, now),
        obstacles=Obstacles(
            more_open=max(len(blocking) - MAX_OBSTACLES, 0),
            taken_up=sum(item.state == 'taken_up' for item in found),
            removed=sum(item.state == 'removed' for item in found),
        ),
        news=news,
    )
    if board.is_desk(agent_id):
        return _desk_brief(base, news, news_of, cut=page is not None)
    shown_candidates = {
        entry.post.id: CandidateLine(
            line=line(entry),
            minutes_ago=minutes_since(entry.at, now) or 0,
            standing=standing(board, entry.post.id),
            to_earlier_question=to_earlier_question(board, entry),
            rests_on=rests_on(board, entry),
        )
        for entry in shown
    }
    blocked = {entry.post.id: standing(board, entry.post.id) for entry in blocking[:MAX_OBSTACLES]}

    def render(keep: Keep) -> Brief:
        cuts: dict[Part, tuple[int, tuple[str, ...]]] = {}

        def kept[T](
            part: Part, items: Sequence[T], *, last: bool = True, name: Callable[[T], str] | None = None
        ) -> tuple[T, ...]:
            # The lines of a part that the budget keeps: the last ones, or with `last` false the first ones. The
            # cut names the lines that it left out by `name`.
            room = min(keep.get(part, len(items)), len(items))
            taken, dropped = (
                (items[len(items) - room :], items[: len(items) - room]) if last else (items[:room], items[room:])
            )
            if dropped:
                cuts[part] = (len(dropped), tuple(name(item) for item in dropped) if name else ())
            return tuple(taken)

        heard = news_of(keep.get('news.for_you', len(news.for_you)))
        if len(heard.for_you) < len(news.for_you):
            cuts['news.for_you'] = (len(news.for_you) - len(heard.for_you), ())
        heard_others = kept('news.others', heard.others)
        rounds = _rounds(heard.rounds, keep.get('news.rounds'), cuts, known)
        reruns = kept('news.reruns', heard.reruns, last=False)
        lined = set(kept('agents', recent, name=str))
        agents = tuple(
            agent if agent.id in lined else agent.model_copy(update={'plan': None, 'latest': None})
            for agent in agent_lines
        )
        threads = kept('threads', summaries[:MAX_NEWS], last=False)
        whole = kept('candidates', shown)
        # A post whose line the brief holds already is its ID alone in the lists of posts, so the brief holds each
        # headline once.
        held = (
            *heard.for_you,
            *heard_others,
            close_line,
            report_line,
            reading_line,
            waits.line if waits else None,
            *(post for agent in (your_line, *agents) if agent for post in (agent.plan, agent.latest)),
            *(summary.latest for summary in threads),
            *(summary.summary for summary in threads),
        )
        # Each candidate has its whole line, so a later list of posts holds its ID alone.
        told = {post.id for post in held if post} | {entry.post.id for entry in whole}

        def listed(part: Part, entries: tuple[Posted, ...], *, last: bool = True) -> tuple[PostEntry, ...]:
            # The posts whose lines the budget keeps, of those that the brief does not hold yet. A post whose line
            # the budget cut is its ID alone in each later list too.
            fresh = tuple(entry for entry in entries if entry.post.id not in told)
            lines = {entry.post.id for entry in kept(part, fresh, last=last)}
            told.update(entry.post.id for entry in entries)
            return tuple(
                PostEntry(id=entry.post.id, line=line(entry) if entry.post.id in lines else None) for entry in entries
            )

        # The lists of posts come in the order of their fields, so each one leaves out the lines of the ones before.
        lists = {
            'disputed': listed('disputed', disputed),
            'not_built_on': listed('not_built_on', not_built_on),
            'not_checked': listed('not_checked', not_checked),
            'obstacles': listed('obstacles', blocking[:MAX_OBSTACLES], last=False),
            'open_asks': listed('open_asks', open_asks),
            'open_calls': listed('open_calls', open_calls),
            'open_tasks': tuple(
                TaskEntry(
                    id=entry.id,
                    line=entry.line,
                    invites=task.post.mentions,
                    dropped=dropped(board, task),
                    lapsed=lapsed(board, task.post.id),
                )
                for entry, task in zip(listed('open_tasks', unheld), unheld, strict=True)
            ),
        }
        side_kept = kept('side_threads', side[:MAX_NEWS], last=False)
        quiet_kept = kept('quiet_threads', quiet[:MAX_LEADS], last=False)
        offered = {offer.post for offer in kept('offers', offers)}
        news_kept = heard.model_copy(
            update={
                'for_you': known(heard.for_you),
                'others': known(heard_others),
                'left_out': heard.left_out + len(heard.others) - len(heard_others),
                # `person_waits` holds the post that the line names, so the brief says it once.
                'no_reply': '',
                'rounds': rounds,
                'reruns': reruns,
            }
        )
        offers_kept = (
            tuple(
                line.model_copy(update={'offers': tuple(offer for offer in line.offers if offer.post in offered)})
                for line in delivered
            )
            if 'offers' in cuts
            else delivered
        )
        update = {
            'deliverables': offers_kept,
            'agents': agents,
            'left': kept('left', gone_lines, name=_left),
            'candidates': tuple(shown_candidates[entry.post.id] for entry in whole),
            'older_candidates': tuple(
                CandidateRef(id=entry.post.id, author=entry.post.author)
                for entry in (*older, *shown[: len(shown) - len(whole)])
            ),
            'threads': tuple(latest(summary) for summary in threads),
            'more_threads': len(summaries) - len(threads),
            'side_threads': side_kept,
            'more_side_threads': len(side) - len(side_kept),
            'one_agent_threads': kept('one_agent_threads', alone[:MAX_LEADS], last=False),
            'quiet_threads': tuple(
                ThreadLine(id=summary.thread.id, title=summary.thread.title, team=summary.team, last_at=summary.last_at)
                for summary in quiet_kept
            ),
            'more_quiet_threads': len(quiet) - len(quiet_kept),
            **lists,
            'obstacles': base.obstacles.model_copy(
                update={
                    'open': tuple(
                        ObstacleEntry(id=entry.id, line=entry.line, standing=blocked[entry.id])
                        for entry in lists['obstacles']
                    )
                }
            ),
            'reruns_wanted': kept('reruns_wanted', wanted, name=_rerun),
            'news': news_kept,
        }
        return base.model_copy(
            update=update | {'cut': tuple(cut_line(part, *cuts[part]) for part in CUTS if part in cuts)}
        )

    full: dict[Part, int] = {
        'quiet_threads': min(len(quiet), MAX_LEADS),
        'one_agent_threads': min(len(alone), MAX_LEADS),
        'side_threads': min(len(side), MAX_NEWS),
        'reruns_wanted': len(wanted),
        'news.reruns': len(news.reruns),
        'open_tasks': len(unheld),
        'open_calls': len(open_calls),
        'open_asks': len(open_asks),
        'obstacles': min(len(blocking), MAX_OBSTACLES),
        'not_checked': len(not_checked),
        'not_built_on': len(not_built_on),
        'disputed': len(disputed),
        'left': len(gone_lines),
        'news.others': len(news.others),
        'threads': min(len(summaries), MAX_NEWS),
        'news.rounds': sum(len(note.entries) for note in news.rounds),
        'offers': len(offers),
        'candidates': len(shown),
        'agents': len(recent),
        **({'news.for_you': len(news.for_you)} if page else {}),
    }
    return fit(render, full)


def _desk_brief(base: Brief, news: News, news_of: Callable[[int], News], *, cut: bool) -> Brief:
    """
    Return the desk's brief: the lab's facts and the desk's news, with no list of the lab's work.

    The desk reads the lab on demand with `overview`, `threads`, and `thread`, so its brief stays small in a lab of
    any size. With `cut`, the news ends earlier when the brief has too little room for the person's posts.
    """
    # The brief lists no obstacle, so it counts none beyond a list.
    lean = base.model_copy(update={'obstacles': Obstacles()})

    def render(keep: Keep) -> Brief:
        heard = news_of(keep.get('news.for_you', len(news.for_you)))
        dropped = len(news.for_you) - len(heard.for_you)
        return lean.model_copy(update={'news': heard, 'cut': (cut_line('news.for_you', dropped),) if dropped else ()})

    return fit(render, {'news.for_you': len(news.for_you)} if cut else {})


def _rounds(
    notes: tuple[RoundNote, ...],
    room: int | None,
    cuts: dict[Part, tuple[int, tuple[str, ...]]],
    known: Callable[[tuple[PostLine, ...]], tuple[PostLine, ...]],
) -> tuple[RoundNote, ...]:
    # The closed rounds of the news with the lines of their entries that the budget keeps, the older rounds first
    # as in the news, and each round counts the entries that it leaves out.
    total = sum(len(note.entries) for note in notes)
    room = total if room is None else min(room, total)
    if room < total:
        cuts['news.rounds'] = (total - room, ())
    spent = accumulate((len(note.entries) for note in notes), initial=0)
    return tuple(
        note.model_copy(
            update={
                'round': known((note.round,))[0],
                'entries': known(note.entries[: max(room - used, 0)]),
                'left_out': note.left_out + len(note.entries) - len(note.entries[: max(room - used, 0)]),
            }
        )
        for note, used in zip(notes, spent, strict=False)
    )


def _rerun(line: RerunLine) -> str:
    return line.post


def _left(line: LeftLine) -> str:
    return line.id


def _person_waits(board: Board, agent_id: AgentId, now: datetime) -> PersonWait | None:
    # Only the agent that holds the coordinator seat reads which posts of the person wait for its reply.
    waiting = waiting_for_reply(board) if agent_id == board.coordinator else ()
    if not waiting:
        return None
    oldest = waiting[0]
    return PersonWait(
        line=post_line(board, oldest, agent_id, now), minutes=minutes_since(oldest.at, now) or 0, more=len(waiting) - 1
    )


def round_line(board: Board, agent_id: AgentId, now: datetime) -> RoundLine | None:
    """Return the round that is open at `now` as one line for an agent, or `None` while no round is open."""
    opened = open_round(board, now)
    if opened is None:
        return None
    answers = entries(board, opened.post.id)
    yours = next((entry.post.id for entry in answers if entry.post.author == agent_id), None)
    return RoundLine(
        round=post_line(board, opened, agent_id, now),
        closes_at=closes_at(opened),
        entered=len(answers),
        not_entered=len(waits_for(board, opened)),
        yours=yours,
    )


def _agent_line(
    board: Board, agent: Agent, working: dict[AgentId, ThreadId | None], reader: AgentId, now: datetime
) -> AgentLine:
    posts = tuple(entry for entry in board.posts if entry.post.author == agent.id)
    plan = next((entry for entry in reversed(posts) if isinstance(entry.post, Plan)), None)
    role, status = board.profile(agent.id)
    given, giver = board.given_role(agent.id)
    seat = seat_label(board, agent.id)
    flag = board.flag(agent.id)
    return AgentLine(
        id=agent.id,
        name=agent.name,
        seat='' if seat == agent.name else seat,
        harness=agent.harness,
        former_names=_former_names(board, agent),
        about=board.about(agent.id),
        about_by=board.about_by(agent.id),
        role=role,
        given_role=given,
        given_by=giver if given else None,
        on_call=board.on_call(agent.id),
        coordinator=board.coordinator == agent.id,
        reviewer=board.reviewer(agent.id),
        flag=flag.flag or '' if flag else '',
        status=status,
        thread=working.get(agent.id),
        plan=_own_line(board, plan, seat, reader, now) if plan else None,
        latest=_own_line(board, posts[-1], seat, reader, now) if posts and posts[-1] is not plan else None,
        claim=claim_line(board, agent.id, now),
        error=_reason(board.failure(agent.id)),
        paused_by=pause.by if (pause := pause_line(board, agent.id, now)) else None,
        paused_until=pause.until if pause else None,
        tokens_per_hour=cap.tokens if (cap := cap_of(board, agent.id)) and not board.is_desk(agent.id) else None,
    )


def _former_names(board: Board, agent: Agent) -> tuple[str, ...]:
    # The names that the agent chose and held last before its name of now, newest last. A name that it took
    # again counts where it held it last.
    held = tuple(entry.name for entry in board.profiles if entry.agent == agent.id and entry.name)
    last = dict.fromkeys(name for name in reversed(held) if name != agent.name)
    return tuple(reversed(tuple(last)))[-MAX_FORMER_NAMES:]


def _own_line(board: Board, entry: Posted, seat: str, reader: AgentId, now: datetime) -> PostLine:
    # A post's line in a list that holds its author already. It says who wrote the post only when the seat's
    # label was another when the post was written.
    line = post_line(board, entry, reader, now)
    same = line.by is not None and seat_label(board, entry.post.author, entry.seq) == seat
    return line.model_copy(update={'by': None}) if same else line


def profile_result(board: Board, agent_id: AgentId) -> ProfileResult:
    """Return an agent's profile as it is now, with the lab's coordinator and its reviewer seats."""
    joined = board.agent(agent_id)
    role, status = board.profile(agent_id)
    given, giver = board.given_role(agent_id)
    flag = board.flag(agent_id)
    return ProfileResult(
        agent=agent_id,
        name=joined.agent.name if joined else agent_id,
        seat=seat_label(board, agent_id),
        about=board.about(agent_id),
        about_by=board.about_by(agent_id),
        picture=board.picture(agent_id),
        role=role,
        status=status,
        given_role=given,
        given_by=giver if given else None,
        flag=flag.flag or '' if flag else '',
        coordinator=board.coordinator,
        reviewers=holders(board),
        reviewer_seats=seats(board),
        reviewer_seats_free=free_seats(board),
    )


def _reason(failed: TurnEnded | None) -> str | None:
    """
    Return why an agent's harness failed last, for the other agents, as one of Verifold's own short sentences.

    The harness's own error text stays with the person: it can hold paths, commands, and text that an agent wrote.
    """
    if failed is None or failed.error is None:
        return None
    if failed.error.startswith(ERROR_MODEL_REFUSED):
        return 'Its harness refused the model.'
    if failed.error.startswith((ERROR_OUT_OF_TIME, ERROR_RAN_PAST)):
        return 'Verifold stopped its turn at the time limit.'
    if failed.error.startswith(ERROR_AT_LIMIT):
        return "Verifold stopped its turn at the lab's budget or disk limit."
    if failed.error.startswith(ERROR_INTERRUPTED):
        return 'The desk ended its last turn for the person.'
    return 'Its harness failed to start.' if failed.no_turn else 'Its last turn ended with an error.'


def needs_person(board: Board) -> tuple[PostView, ...]:
    """
    Return the posts that wait for the person's answer, oldest first.

    They are the asks that name the person and have no answer from the person yet, the coordinator's asks in the
    conversation with the person, and the coordinator's requests for a move that wait.

    Permission requests are asks too. An agent's answer leaves an ask open, because the asker waits for the person.
    An ask that carried a harness's request is not among them after Verifold ended the request.
    The ask of an agent that left is not among them: nobody waits for its answer.
    """
    return tuple(post_view(board, entry, PERSON) for entry in waiting_posts(board))


def waiting_posts(board: Board) -> tuple[Posted, ...]:
    """Return the entries of the posts that wait for the person's answer, oldest first, as `needs_person` says."""
    return tuple(entry for entry in board.posts if _waits_for_person(board, entry))


def _waits_for_person(board: Board, entry: Posted) -> bool:
    post = entry.post
    if not isinstance(post, Ask):
        return request_waits(board, entry)
    # In the conversation, the ask of the agent that held the coordinator seat when it asked is to the person, also
    # after the seat changed. Another agent's ask there is to the person only when it names the person, as in any
    # thread.
    talks = post.thread == board.conversation and post.author == board.coordinator_at(entry.seq)
    to_person = PERSON in post.mentions or talks
    return to_person and waits_for_person(board, post.id) and not board.gone(post.author)


def to_earlier_question(board: Board, proposed: Posted) -> bool:
    """
    Return whether a proposal answers an earlier version of the question.

    It does when the board had shown its author fewer revisions than the question has now. So the proposal of an
    agent that posts just after a revision, before it read the revision, answers the earlier version. A proposal
    from before Verifold kept that count answers an earlier version when it came before the latest revision. The
    count goes by revisions, not by text: after the person goes back to an earlier text, an answer from the first
    time that the question had that text is still marked.
    """
    seen = proposed.post.question_seen if isinstance(proposed.post, Proposal) else None
    if seen is None:
        return bool(board.revisions) and proposed.seq < board.revisions[-1].seq
    return seen < len(board.revisions)


def versions(board: Board) -> tuple[QuestionVersion, ...]:
    """Return every version of the question, oldest first: the text that the lab opened with, then each revision."""
    return (
        QuestionVersion(question=board.opened.question, at=board.opened.at),
        *(
            QuestionVersion(
                question=entry.question,
                at=entry.at,
                note=entry.note,
                post=entry.post,
                by=entry.by,
                request=entry.request,
            )
            for entry in board.revisions
        ),
    )


def candidates_view(board: Board) -> CandidatesView:
    """
    Return the candidate answers for the person: the ones that stand, the ones gone, and the one that a close names.

    The proposals that stand no more are the ones gone. The person sees every post, so no view here is sealed.
    """
    done = closing(board)
    named = closes_on(board, done) if done else None
    return CandidatesView(
        standing=tuple(candidate_view(board, entry) for entry in candidates(board)),
        gone=tuple(post_view(board, entry, PERSON) for entry in gone(board)),
        closes_on=candidate_view(board, named) if named else None,
    )


def candidate_view(board: Board, entry: Posted) -> CandidateView:
    """
    Return a candidate answer for the person with the posts that it builds on and its author's own entry.

    The results among those posts are counted by how each stands.
    """
    under = tuple(post for post_id in entry.post.builds_on if (post := board.post(post_id)))
    results = tuple(post for post in under if _can_rerun(post))
    entered = own_entry(board, entry)
    return CandidateView(
        candidate=post_view(board, entry, PERSON),
        to_earlier_question=to_earlier_question(board, entry),
        builds_on=tuple(post_view(board, post, PERSON) for post in under),
        results=len(results),
        no_blind_rerun=tuple(post.post.id for post in _not_rerun(board, results)),
        rests_on=rests_on(board, entry),
        entry=post_view(board, entered, PERSON) if entered else None,
    )


def _can_rerun(entry: Posted) -> bool:
    # A rerun needs files to run.
    return isinstance(entry.post, Result) and bool(entry.post.evidence)


def _not_rerun(board: Board, results: tuple[Posted, ...]) -> tuple[Posted, ...]:
    # The results that have no check of an independent rerun, whatever a check said, and that their author still
    # holds.
    return tuple(
        entry
        for entry in results
        if not rerun_checks(board, entry.post.id) and standing(board, entry.post.id) != 'conceded'
    )


def newest_report(board: Board) -> Posted | None:
    """Return the newest report that an agent posted, in whatever thread it is, or `None` when no agent has posted one."""
    reports = (entry for entry in reversed(board.posts) if isinstance(entry.post, Report))
    return next((entry for entry in reports if entry.post.author != PERSON), None)


def latest_report(board: Board) -> PostView | None:
    """Return the newest report that an agent posted, as the person's app shows it, or `None`."""
    entry = newest_report(board)
    return post_view(board, entry, PERSON) if entry else None


def standing_reading(board: Board) -> Posted | None:
    """Return the lab's reading of the question: the newest reading, in whatever thread it is, or `None` without one."""
    return next((entry for entry in reversed(board.posts) if isinstance(entry.post, Reading)), None)


def latest_reading(board: Board) -> PostView | None:
    """Return the lab's reading of the question, as the person's app shows it, or `None`."""
    entry = standing_reading(board)
    return post_view(board, entry, PERSON) if entry else None


def _no_reading(board: Board, now: datetime) -> str:
    """Return the line of a lab without a reading: that it has none, and how long ago the lab opened."""
    opened = minutes_text(max((now - board.opened.at).total_seconds() / 60, 0))
    return f'No `reading` yet. The lab opened {opened} ago.'
