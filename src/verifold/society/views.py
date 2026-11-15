"""The board as one agent, or the person, sees it."""

from verifold.protocol.agents import Agent
from verifold.protocol.events import Posted, ThreadOpened
from verifold.protocol.ids import PERSON, AgentId, ThreadId
from verifold.protocol.join import (
    MAX_LEADS,
    MAX_LINKS,
    MAX_NEWS,
    AgentLine,
    AnswerView,
    Brief,
    News,
    PostLine,
    PostView,
    QuestionVersion,
    RevisionLine,
    SideLine,
    ThreadLine,
    ThreadLink,
    ThreadSummary,
    ThreadView,
)
from verifold.protocol.posts import Ask, Call, Check, Close, Objection, Plan, Proposal, Report, Result
from verifold.society.attention import left_line, watches_thread
from verifold.society.board import Board
from verifold.society.errors import NotFound
from verifold.society.lifecycle import alarm_line, lab_state
from verifold.society.lines import lines_of, question_thread
from verifold.society.rules import blind_checks
from verifold.society.standing import agreed, closing, is_answered, is_open_call, standing, waits_for_person


def post_view(board: Board, entry: Posted) -> PostView:
    """Return a post with its time, where it stands, and the posts that build on it."""
    return PostView(
        seq=entry.seq,
        at=entry.at,
        post=entry.post,
        standing=standing(board, entry.post.id),
        built_on_by=tuple(other.post.id for other in board.built_on(entry.post.id)),
    )


def thread_view(board: Board, agent_id: AgentId, thread_id: ThreadId) -> ThreadView:
    """
    Return a thread and its posts.

    Raises:
        NotFound: No thread has this ID.

    """
    opened = board.thread(thread_id)
    if opened is None:
        raise NotFound(f'No thread has the ID {thread_id}.')
    return ThreadView(
        thread=opened.thread,
        watching=watches_thread(board, agent_id, thread_id),
        members=board.members(thread_id),
        posts=tuple(post_view(board, entry) for entry in board.posts if entry.post.thread == thread_id),
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


def _team(board: Board, opened: ThreadOpened, lines: dict[AgentId, ThreadId | None]) -> tuple[AgentId, ...]:
    # The lab's agents that work in the thread now. The agent that opened the thread is in its team until it works
    # in another one, unless it opened the thread with a call, which says that the work needs somebody else. The
    # person, blind checkers, and agents that left are in no team. The question's thread has none, and neither has a
    # side thread, where no agent works.
    thread = opened.thread
    if thread.between or thread.id == question_thread(board):
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
        latest=PostLine.of(latest) if latest else None,
        disputed=results.count('disputed'),
        checked=sum(state in {'checked', 'held_up'} for state in results),
        not_checked=results.count('open'),
        # Nobody waits for the answer to an ask whose author left.
        open_asks=sum(
            isinstance(entry.post, Ask) and not is_answered(board, entry.post.id) and not board.gone(entry.post.author)
            for entry in entries
        ),
        open_calls=sum(isinstance(entry.post, Call) and is_open_call(board, entry.post.id) for entry in entries),
        team=_team(board, opened, lines),
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


def brief(board: Board, agent_id: AgentId, news: News, how: str = '') -> Brief:
    """
    Return the lab for one agent in one read.

    It holds the agent's own line and the other agents with their latest plans, and then where the agent's work is
    of use: the calls that
    need an agent, the threads where one agent works alone, the results that nobody has built on, the asks that
    nobody has answered, the results that nobody has checked, and the disputed posts. Then come the newest threads,
    one line for each side thread, and the agent's `news`. `how` says how the board works.
    """
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
        PostLine.of(entry)
        for entry, state in stands
        if isinstance(entry.post, Result) and entry.post.author != agent_id and state == 'open'
    )
    disputed = tuple(PostLine.of(entry) for entry, state in stands if state == 'disputed')
    open_asks = tuple(
        PostLine.of(entry)
        for entry in board.posts
        if isinstance(entry.post, Ask)
        and entry.post.author != agent_id
        and entry.post.mentions != (PERSON,)
        and entry.post.thread not in not_mine
        and not is_answered(board, entry.post.id)
        and not board.gone(entry.post.author)
    )
    open_calls = tuple(
        PostLine.of(entry)
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
    not_built_on = tuple(
        PostLine.of(entry)
        for entry, state in stands
        if isinstance(entry.post, Result)
        and entry.post.author != agent_id
        and state not in {'conceded', 'disputed'}
        and not _built_on(board, entry)
    )
    proposed = answer(board)
    done = closing(board)
    you = board.agent(agent_id)
    return Brief(
        you=agent_id,
        your_line=_agent_line(board, you.agent, working) if you else None,
        your_alarm=alarm_line(board, agent_id),
        how=how,
        question=board.question,
        revisions=tuple(
            RevisionLine(at=entry.at, note=entry.note, post=entry.post) for entry in board.revisions[-MAX_LEADS:]
        ),
        agents=tuple(_agent_line(board, agent, working) for agent in others),
        left=tuple(left_line(board, entry) for entry in board.left),
        answer=PostLine.of(proposed) if proposed else None,
        answer_standing=standing(board, proposed.post.id) if proposed else None,
        answer_to_earlier_question=bool(proposed) and to_earlier_question(board, proposed),
        state=lab_state(board),
        close=PostLine.of(done) if done else None,
        close_agreed=agreed(board, done) if done else (),
        open_calls=open_calls[-MAX_NEWS:],
        one_agent_threads=alone[:MAX_LEADS],
        not_built_on=not_built_on[-MAX_LEADS:],
        open_asks=open_asks[-MAX_NEWS:],
        not_checked=not_checked[-MAX_NEWS:],
        disputed=disputed[-MAX_NEWS:],
        threads=summaries[:MAX_NEWS],
        more_threads=max(len(summaries) - MAX_NEWS, 0),
        side_threads=side[:MAX_NEWS],
        more_side_threads=max(len(side) - MAX_NEWS, 0),
        news=news,
        ends_at=board.ends_at,
    )


def _agent_line(board: Board, agent: Agent, working: dict[AgentId, ThreadId | None]) -> AgentLine:
    posts = tuple(entry for entry in board.posts if entry.post.author == agent.id)
    plan = next((entry for entry in reversed(posts) if isinstance(entry.post, Plan)), None)
    role, status = board.profile(agent.id)
    return AgentLine(
        id=agent.id,
        name=agent.name,
        harness=agent.harness,
        role=role,
        status=status,
        thread=working.get(agent.id),
        plan=PostLine.of(plan) if plan else None,
        latest=PostLine.of(posts[-1]) if posts and posts[-1] is not plan else None,
    )


def needs_person(board: Board) -> tuple[PostView, ...]:
    """
    Return the asks that name the person and have no answer from the person yet, oldest first.

    Permission requests are asks too. An agent's answer leaves an ask open, because the asker waits for the person.
    An ask that carried a harness's request is not among them after Verifold ended the request.
    The ask of an agent that left is not among them: nobody waits for its answer.
    """
    return tuple(
        post_view(board, entry)
        for entry in board.posts
        if isinstance(entry.post, Ask)
        and PERSON in entry.post.mentions
        and waits_for_person(board, entry.post.id)
        and not board.gone(entry.post.author)
    )


def answer(board: Board) -> Posted | None:
    """
    Return the lab's answer so far: the newest proposal in the question's thread.

    Where it stands says whether an agent disputes it or its author conceded it. An older proposal does not come
    back as the answer, because the lab moved on from it.
    """
    thread = question_thread(board)
    return next(
        (entry for entry in reversed(board.posts) if isinstance(entry.post, Proposal) and entry.post.thread == thread),
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
            QuestionVersion(question=entry.question, at=entry.at, note=entry.note, post=entry.post)
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
    # A blind rerun needs files to run.
    return isinstance(entry.post, Result) and bool(entry.post.evidence)


def _not_rerun(board: Board, results: tuple[Posted, ...]) -> tuple[Posted, ...]:
    # The results that no blind checker has checked, whatever the check said, and that their author still holds.
    return tuple(
        entry
        for entry in results
        if not blind_checks(board, entry.post.id) and standing(board, entry.post.id) != 'conceded'
    )


def latest_report(board: Board) -> PostView | None:
    """Return the newest report that an agent posted, or `None` when no agent has posted one."""
    reports = (entry for entry in reversed(board.posts) if isinstance(entry.post, Report))
    entry = next((entry for entry in reports if entry.post.author != PERSON), None)
    return post_view(board, entry) if entry else None
