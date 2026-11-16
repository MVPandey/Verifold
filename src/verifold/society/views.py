"""
The board as one agent, or the person, sees it.

A view holds what is on the board, as facts. `brief` ranks nothing and gives no advice: what an agent does with
the board is the agent's choice, and the person's norms are in the lab's `LAB.md`.
"""

from datetime import datetime, timedelta

from verifold.protocol.agents import GUEST, POWERS, Agent
from verifold.protocol.events import (
    ERROR_MODEL_REFUSED,
    ERROR_OUT_OF_TIME,
    ERROR_RAN_PAST,
    Posted,
    ThreadOpened,
    TurnEnded,
)
from verifold.protocol.ids import PERSON, AgentId, PostId, ThreadId
from verifold.protocol.join import (
    MAX_FORMER_NAMES,
    MAX_LEADS,
    MAX_LINKS,
    MAX_NEWS,
    QUIET_MINUTES,
    AgentLine,
    AnswerView,
    Brief,
    News,
    PostEntry,
    PostLine,
    PostView,
    ProfileResult,
    QuestionVersion,
    RevisionLine,
    SideLine,
    ThreadLine,
    ThreadLink,
    ThreadSummary,
    ThreadView,
)
from verifold.protocol.posts import Ask, Call, Check, Close, Objection, Plan, Proposal, Report, Result
from verifold.protocol.votes import MAX_VOTE_LINES, NEWEST_VOTES
from verifold.society.attention import left_line, watches_thread
from verifold.society.board import Board
from verifold.society.coordinator import request_waits
from verifold.society.deliverables import deliverable_lines
from verifold.society.errors import NotFound
from verifold.society.identity import post_line, post_view, seat_label
from verifold.society.lifecycle import (
    alarm_line,
    lab_state,
    latest_time,
    minutes_left,
    no_alarm_line,
    pending_alarm,
)
from verifold.society.lines import lines_of, question_thread
from verifold.society.reruns import rerun_checks, reruns_wanted
from verifold.society.reviewers import free_seats, holders, seats
from verifold.society.standing import agreed, closing, is_answered, is_open_call, standing, waits_for_person
from verifold.society.turns import before


def thread_view(board: Board, agent_id: AgentId, thread_id: ThreadId, votes_of: PostId | None = None) -> ThreadView:
    """
    Return a thread and its posts.

    Each post has its counts, its badges, and its newest votes with their reasons: `NEWEST_VOTES` for an agent,
    so that a long thread with many voters stays one tool result. The post that `votes_of` names has
    `MAX_VOTE_LINES`, and so has every post for the person.

    Raises:
        NotFound: No thread has this ID, or the thread has no post with the ID in `votes_of`.

    """
    opened = board.thread(thread_id)
    if opened is None:
        raise NotFound(f'No thread has the ID {thread_id}.')
    named = board.post(votes_of) if votes_of else None
    if votes_of and (named is None or named.post.thread != thread_id):
        raise NotFound(f'Thread {thread_id} has no post with the ID {votes_of}.')

    def votes(entry: Posted) -> int:
        return MAX_VOTE_LINES if agent_id == PERSON or entry.post.id == votes_of else NEWEST_VOTES

    return ThreadView(
        thread=opened.thread,
        watching=watches_thread(board, agent_id, thread_id),
        members=board.members(thread_id),
        person_reaches=board.offer_listeners(thread_id) if board.holds_offers(thread_id) else None,
        posts=tuple(post_view(board, entry, votes(entry)) for entry in board.posts if entry.post.thread == thread_id),
    )


def thread_summaries(board: Board, agent_id: AgentId) -> tuple[ThreadSummary, ...]:
    """Return one summary for each thread, side threads among them, the most recently active first."""
    crossed = crossings(board)
    lines = lines_of(board)
    summaries = (_summary(board, agent_id, opened, crossed, lines) for opened in board.threads)
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
    a report's link, because a report names its sources and builds nothing on them.
    """
    by_id = {entry.post.id: entry for entry in board.posts}
    built = (entry for entry in board.posts if not isinstance(entry.post, Report | Close))
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
    if thread.between or thread.conversation or thread.id == question_thread(board):
        return ()
    workers = tuple(
        joined.agent.id for joined in board.agents if not joined.agent.checks and not board.gone(joined.agent.id)
    )
    first = next((entry.post for entry in board.posts if entry.post.thread == thread.id), None)
    called = isinstance(first, Call) and first.author == thread.opened_by
    opener = () if called or thread.opened_by in lines else (thread.opened_by,)
    return tuple(agent for agent in workers if agent in opener or lines.get(agent) == thread.id)


def _summary(
    board: Board,
    agent_id: AgentId,
    opened: ThreadOpened,
    crossed: tuple[Crossing, ...],
    lines: dict[AgentId, ThreadId | None],
) -> ThreadSummary:
    entries = tuple(entry for entry in board.posts if entry.post.thread == opened.thread.id)
    results = tuple(standing(board, entry.post.id) for entry in entries if isinstance(entry.post, Result))
    latest = entries[-1] if entries else None
    incoming = tuple((source, built) for source, built in crossed if built.post.thread == opened.thread.id)
    return ThreadSummary(
        thread=opened.thread,
        watching=watches_thread(board, agent_id, opened.thread.id, lines),
        members=board.members(opened.thread.id),
        posts=len(entries),
        last_at=latest.at if latest else opened.at,
        latest=post_line(board, latest) if latest else None,
        disputed=results.count('disputed'),
        checked=sum(state in {'checked', 'held_up'} for state in results),
        not_checked=results.count('open'),
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
    )


def _built_on(board: Board, entry: Posted) -> bool:
    """
    Return whether work builds on a result already.

    Another agent of the lab builds on it with any post but a report, a check, or an objection, which name a post
    and build nothing. The result's own author builds on it with a later result, so only the newest result of an
    author's chain still waits.
    """
    workers = {joined.agent.id for joined in board.agents if not joined.agent.checks}
    return any(
        isinstance(other.post, Result)
        if other.post.author == entry.post.author
        else other.post.author in workers and not isinstance(other.post, Report | Check | Objection | Close)
        for other in board.built_on(entry.post.id)
    )


def brief(board: Board, agent_id: AgentId, news: News, how: str = '', *, now: datetime | None = None) -> Brief:
    """
    Return the lab for one agent in one read.

    It holds the agent's own line, the lab's state and the time that it has left, how many agents are in a turn
    and how many have an alarm that waits, the other agents with their latest plans, the newest proposal, and the
    newest report with its age. Then come the threads: the
    newest ones, one line for each side thread, the threads where one agent works alone, and the threads that got
    no post for a long while. Then come the posts by where they stand: the disputed posts, the results that nobody
    has built on, the results that nobody has checked, the asks that nobody has answered, and the calls that need an
    agent. The order ranks nothing. `how` says how the board works.

    `now` dates the time that the lab has left, the report's age, and the quiet threads. Without it, time counts from the board's
    newest post. The agents in a turn come from the record, because this package does no I/O and so knows no live
    activity.
    """
    now = now or latest_time(board)
    # An invited agent that has not posted may never come, so no agent reads it as a peer to ask or wait for. An
    # agent that left is no peer either, and the brief lists it apart.
    others = tuple(
        joined.agent
        for joined in board.agents
        if joined.agent.id != agent_id and not joined.agent.checks and board.here(joined)
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
    )
    disputed = tuple(entry for entry, state in stands if state == 'disputed')
    open_asks = tuple(
        entry
        for entry in board.posts
        if isinstance(entry.post, Ask)
        and entry.post.author != agent_id
        and entry.post.mentions != (PERSON,)
        and entry.post.thread not in not_mine
        and entry.post.thread != board.conversation
        and not is_answered(board, entry.post.id)
        and not board.gone(entry.post.author)
    )
    open_calls = tuple(
        entry
        for entry in board.posts
        if isinstance(entry.post, Call)
        and entry.post.author != agent_id
        and entry.post.thread not in not_mine
        and is_open_call(board, entry.post.id)
    )
    every = thread_summaries(board, agent_id)
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
    # of the lab.
    run = tuple(
        joined.agent.id
        for joined in board.agents
        if not joined.agent.checks and joined.agent.harness != GUEST and not board.gone(joined.agent.id)
    )
    not_built_on = tuple(
        entry
        for entry, state in stands
        if isinstance(entry.post, Result)
        and entry.post.author != agent_id
        and state not in {'conceded', 'disputed'}
        and not _built_on(board, entry)
    )
    proposed = answer(board)
    reported = newest_report(board)
    done = closing(board)
    you = board.agent(agent_id)
    close_line = post_line(board, done) if done else None
    answer_line = post_line(board, proposed) if proposed else None
    report_line = post_line(board, reported) if reported else None
    your_line = _agent_line(board, you.agent, working) if you else None
    lines = tuple(_agent_line(board, agent, working) for agent in others)
    # A post whose line the brief holds already is its ID alone in the lists of posts, so the brief holds each
    # headline once.
    held = (
        *news.for_you,
        *news.others,
        close_line,
        answer_line,
        report_line,
        *(line for agent in (your_line, *lines) if agent for line in (agent.plan, agent.latest)),
        *(summary.latest for summary in summaries[:MAX_NEWS]),
    )
    told = {line.id for line in held if line}

    # The brief's list of agents says who each agent is, so a line in the brief's own lists says who wrote the
    # post only for an author that the list does not hold, or whose seat had another label then.
    labels = {agent.id: seat_label(board, agent.id) for agent in (*others, *((you.agent,) if you else ()))}

    def line(entry: Posted, *, news: bool = False) -> PostLine:
        # The person is in no list of agents, so a line of the news keeps the person's body.
        seat = labels.get(entry.post.author)
        return post_line(board, entry, news=news) if seat is None else _own_line(board, entry, seat)

    def known(lines: tuple[PostLine, ...]) -> tuple[PostLine, ...]:
        # The lines of the news that this brief carries follow the same rule, so no author's name, seat, and
        # role stand in the brief twice.
        return tuple(line(entry, news=True) if (entry := board.post(one.id)) else one for one in lines)

    def listed(entries: tuple[Posted, ...]) -> tuple[PostEntry, ...]:
        shown = tuple(
            PostEntry(id=entry.post.id, line=None if entry.post.id in told else line(entry)) for entry in entries
        )
        told.update(entry.post.id for entry in entries)
        return shown

    return Brief(
        you=agent_id,
        your_line=your_line,
        your_alarm=alarm_line(board, agent_id),
        no_alarm=no_alarm_line(board, agent_id, now),
        how=how,
        question=board.question,
        revisions=tuple(
            RevisionLine(at=entry.at, note=entry.note, post=entry.post, by=entry.by, request=entry.request)
            for entry in board.revisions[-MAX_LEADS:]
        ),
        deliverables=deliverable_lines(board),
        state=lab_state(board),
        close=close_line,
        close_agreed=agreed(board, done) if done else (),
        ends_at=board.ends_at,
        minutes_left=minutes_left(board, now),
        in_turn=sum(before(board, agent).cut_off for agent in run),
        alarms_waiting=sum(pending_alarm(board, joined.agent.id) is not None for joined in board.agents),
        agents=lines,
        coordinator=board.coordinator,
        coordinator_open=board.coordinator_open,
        reviewers=holders(board),
        reviewer_seats=seats(board),
        reviewer_seats_free=free_seats(board),
        conversation=board.conversation,
        powers=tuple(power for power in POWERS if power in board.powers),
        left=tuple(left_line(board, entry) for entry in board.left),
        answer=answer_line,
        answer_standing=standing(board, proposed.post.id) if proposed else None,
        answer_to_earlier_question=bool(proposed) and to_earlier_question(board, proposed),
        report=report_line,
        report_minutes_ago=max(int((now - reported.at).total_seconds() // 60), 0) if reported else None,
        threads=summaries[:MAX_NEWS],
        more_threads=max(len(summaries) - MAX_NEWS, 0),
        side_threads=side[:MAX_NEWS],
        more_side_threads=max(len(side) - MAX_NEWS, 0),
        one_agent_threads=alone[:MAX_LEADS],
        quiet_threads=tuple(
            ThreadLine(id=summary.thread.id, title=summary.thread.title, team=summary.team, last_at=summary.last_at)
            for summary in quiet[:MAX_LEADS]
        ),
        more_quiet_threads=max(len(quiet) - MAX_LEADS, 0),
        disputed=listed(disputed[-MAX_NEWS:]),
        not_built_on=listed(not_built_on[-MAX_LEADS:]),
        not_checked=listed(not_checked[-MAX_NEWS:]),
        open_asks=listed(open_asks[-MAX_NEWS:]),
        open_calls=listed(open_calls[-MAX_NEWS:]),
        reruns_wanted=reruns_wanted(board)[-MAX_NEWS:],
        news=news.model_copy(update={'for_you': known(news.for_you), 'others': known(news.others)}),
    )


def _agent_line(board: Board, agent: Agent, working: dict[AgentId, ThreadId | None]) -> AgentLine:
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
        plan=_own_line(board, plan, seat) if plan else None,
        latest=_own_line(board, posts[-1], seat) if posts and posts[-1] is not plan else None,
        error=_reason(board.failure(agent.id)),
    )


def _former_names(board: Board, agent: Agent) -> tuple[str, ...]:
    # The names that the agent chose and held last before its name of now, newest last. A name that it took
    # again counts where it held it last.
    held = tuple(entry.name for entry in board.profiles if entry.agent == agent.id and entry.name)
    last = dict.fromkeys(name for name in reversed(held) if name != agent.name)
    return tuple(reversed(tuple(last)))[-MAX_FORMER_NAMES:]


def _own_line(board: Board, entry: Posted, seat: str) -> PostLine:
    # A post's line in a list that holds its author already. It says who wrote the post only when the seat's
    # label was another when the post was written.
    line = post_line(board, entry)
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
    return tuple(post_view(board, entry) for entry in board.posts if _waits_for_person(board, entry))


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


def answer(board: Board) -> Posted | None:
    """
    Return the lab's answer so far: the newest proposal, in whatever thread for the whole lab it is.

    The person steers the lab by opening threads, and an agent proposes where it was asked. A side thread takes no
    proposal. Where the answer stands says whether an agent disputes it or its author conceded it. An older
    proposal does not come back as the answer, because the lab moved on from it.
    """
    return next(
        (
            entry
            for entry in reversed(board.posts)
            if isinstance(entry.post, Proposal) and not board.is_side(entry.post.thread)
        ),
        None,
    )


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


def answer_view(board: Board) -> AnswerView | None:
    """Return the lab's answer so far with the posts that it builds on, or `None` when no agent proposed one."""
    entry = answer(board)
    if entry is None:
        return None
    under = tuple(post for post_id in entry.post.builds_on if (post := board.post(post_id)))
    results = tuple(post for post in under if _can_rerun(post))
    return AnswerView(
        answer=post_view(board, entry),
        to_earlier_question=to_earlier_question(board, entry),
        builds_on=tuple(post_view(board, post) for post in under),
        results=len(results),
        no_blind_rerun=tuple(post.post.id for post in _not_rerun(board, results)),
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
    return post_view(board, entry) if entry else None
