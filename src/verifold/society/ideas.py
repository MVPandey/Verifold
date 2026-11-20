"""
The map of the lab: the branches of the question, the ideas that hang on them, and where each idea stands.

A reading can split the question into branches. It adds new ones, each with a short title, and it retires ones in
force. Verifold numbers the branches of a lab in the order that they come, and a branch keeps its ID across later
readings, so the ideas that hang on it stay on it. The branches in force, in the order that readings added them, are
the lab's split of the question. A retired branch and its ideas stay in the record and on the map.

An idea is a post that states one way to answer the question with its test and what result of the test would rule
it out, before anyone tries it. It hangs on a branch, or on another idea and through it on that idea's branch. A plan
or a result tries an idea when it names the idea in `idea`, and its author may be the idea's own. A `ruled_out` that
names an idea rules it out while it stands. `IdeaState` in the join protocol says where an idea stands, and the board
computes it from these posts. An idea that replies to a round is its author's entry there, sealed with its author
until the round closes, as `society.rounds` says.

The board picks nothing. It ranks no idea and no branch, keeps no score for either, and orders them only as the
readings and the record do. Every count here is a count of the record.

One limit rests on the map: in a lab with two or more agents that do the work, the board takes no new proposal while
a result that it builds on has no challenge, a check with the method `challenge`, from another agent. A record from
before the rule holds such proposals, so the board checks it for a new post only.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta

from verifold.protocol.events import Posted
from verifold.protocol.ids import PERSON, AgentId, BranchId, PostId
from verifold.protocol.join import (
    MAX_MAP_IDEAS,
    RECENT_HOURS,
    BranchLine,
    BranchView,
    ChallengeLine,
    IdeaState,
    IdeaView,
    MapView,
    TryLine,
    line_text,
)
from verifold.protocol.posts import (
    MAX_BRANCHES,
    Branch,
    Check,
    Idea,
    Plan,
    Post,
    Proposal,
    Reading,
    Result,
    RuledOut,
    idea_of,
)
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.rounds import check_unsealed
from verifold.society.standing import standing


@dataclass(frozen=True, slots=True)
class Held:
    """A branch of the question as the record holds it: the branch, the reading that added it, and the one that retired it."""

    branch: Branch
    added: Posted
    retired: Posted | None = None


def branches(board: Board) -> tuple[Held, ...]:
    """Return every branch that a reading added, in the order that readings added them, with its retirement."""
    readings = tuple(entry for entry in board.posts if isinstance(entry.post, Reading))
    retired = {branch_id: entry for entry in reversed(readings) for branch_id in _retires(entry.post)}
    return tuple(
        Held(branch=branch, added=entry, retired=retired.get(branch.id))
        for entry in readings
        for branch in _added(entry.post)
    )


def in_force(board: Board) -> tuple[Held, ...]:
    """Return the branches in force: the ones that no reading retired, in the order that readings added them."""
    return tuple(held for held in branches(board) if held.retired is None)


def next_branch(board: Board) -> int:
    """Return the number of the next branch that a reading adds: one more than the branches of the lab so far."""
    return len(branches(board)) + 1


def _added(post: Post) -> tuple[Branch, ...]:
    return post.branches if isinstance(post, Reading) else ()


def _retires(post: Post) -> tuple[BranchId, ...]:
    return post.retires if isinstance(post, Reading) else ()


@dataclass(frozen=True, slots=True)
class Ideas:
    """The ideas of a board, each with its branch, its tries, the posts that rule it out, and where it stands."""

    ideas: tuple[Posted, ...]
    branch: dict[PostId, BranchId | None]
    tries: dict[PostId, tuple[Posted, ...]]
    rulings: dict[PostId, tuple[Posted, ...]]
    states: dict[PostId, IdeaState]


_built: list[tuple[tuple[Posted, ...], Ideas]] = []
"""
The ideas of the boards that were read last, each with the posts of its board. A board never changes, so what it
holds stays true for as long as it lives.
"""

_KEPT = 4


def ideas_of(board: Board) -> Ideas:
    """Return the ideas of a board, with what the record holds about each, as the module says."""
    for posts, built in _built:
        if posts is board.posts:
            return built
    ideas = tuple(entry for entry in board.posts if isinstance(entry.post, Idea))
    named: dict[PostId, list[Posted]] = {}
    for entry in board.posts:
        if (target := idea_of(entry.post)) is not None:
            named.setdefault(target, []).append(entry)
    # A try or a ruling that its author conceded counts for nothing, and a ruling that is disputed rules nothing out.
    tries = {
        idea: tuple(
            entry
            for entry in entries
            if isinstance(entry.post, Plan | Result) and standing(board, entry.post.id) != 'conceded'
        )
        for idea, entries in named.items()
    }
    rulings = {
        idea: tuple(
            entry
            for entry in entries
            if isinstance(entry.post, RuledOut) and standing(board, entry.post.id) not in {'disputed', 'conceded'}
        )
        for idea, entries in named.items()
    }
    branch = _branches_of(ideas)
    states = {
        entry.post.id: _state(board, tries.get(entry.post.id, ()), rulings.get(entry.post.id, ())) for entry in ideas
    }
    built = Ideas(ideas=ideas, branch=branch, tries=tries, rulings=rulings, states=states)
    _built.append((board.posts, built))
    del _built[:-_KEPT]
    return built


def _branches_of(ideas: tuple[Posted, ...]) -> dict[PostId, BranchId | None]:
    # The branch of each idea: its parent when that is a branch, or else its parent idea's branch. A parent comes
    # before its child in the record, so one pass in order finds each one. A sealed idea has no parent.
    found: dict[PostId, BranchId | None] = {}
    for entry in ideas:
        parent = entry.post.parent if isinstance(entry.post, Idea) else None
        found[entry.post.id] = parent if parent and parent.startswith('b-') else found.get(parent) if parent else None
    return found


def _state(board: Board, tries: tuple[Posted, ...], rulings: tuple[Posted, ...]) -> IdeaState:
    if rulings:
        return 'ruled_out'
    results = tuple(entry for entry in tries if isinstance(entry.post, Result))
    if any(_challenges(board, entry) for entry in results):
        return 'challenged'
    if results:
        return 'result_in'
    return 'being_tried' if tries else 'untried'


def _challenges(board: Board, result: Posted) -> tuple[Posted, ...]:
    # The challenges of a result that count: a check with the method `challenge`, from another agent, that its own
    # author did not concede. The record takes no check of a post from the post's own author.
    return tuple(
        reply
        for reply in board.replies(result.post.id)
        if isinstance(reply.post, Check)
        and reply.post.method == 'challenge'
        and reply.post.author != result.post.author
        and standing(board, reply.post.id) != 'conceded'
    )


def branch_lines(board: Board, now: datetime) -> tuple[BranchLine, ...]:
    """Return each branch in force with its counts at `now`, in the order that readings added them."""
    return tuple(_line(board, held, now) for held in in_force(board))


def _line(board: Board, held: Held, now: datetime) -> BranchLine:
    found = ideas_of(board)
    mine = tuple(entry for entry in found.ideas if found.branch[entry.post.id] == held.branch.id)
    states = [found.states[entry.post.id] for entry in mine]
    tries = tuple(entry for idea in mine for entry in found.tries.get(idea.post.id, ()))
    since = now - timedelta(hours=RECENT_HOURS)
    return BranchLine(
        id=held.branch.id,
        title=held.branch.title,
        ideas=len(mine),
        untried=states.count('untried'),
        being_tried=states.count('being_tried'),
        results=sum(isinstance(entry.post, Result) for entry in tries),
        ruled_out=states.count('ruled_out'),
        recent_tries=sum(since < entry.at <= now for entry in tries),
        no_idea_hours=None if mine else _hours(now - held.added.at),
        retired=held.retired is not None,
    )


def without_idea(board: Board) -> tuple[Held, ...]:
    """Return the branches in force on which no idea hangs, in the order that readings added them."""
    found = ideas_of(board)
    taken = set(found.branch.values())
    return tuple(held for held in in_force(board) if held.branch.id not in taken)


def new_ideas(board: Board, since: datetime, now: datetime) -> int:
    """Return how many ideas came after `since` and by `now`."""
    return sum(since < entry.at <= now for entry in ideas_of(board).ideas)


def map_view(board: Board, now: datetime, *, whole: bool = False) -> MapView:
    """
    Return the map as the board shows it: each branch with its counts and its ideas, in force first.

    The caller passes the board as its reader sees it, so an idea that is sealed for the reader hangs on no branch.
    With `whole`, as for the person, every idea is there with its whole text. Otherwise the map holds the newest
    `MAX_MAP_IDEAS` ideas, each text cut to `MAX_LINE` characters.
    """
    found = ideas_of(board)
    listed = found.ideas if whole else found.ideas[-MAX_MAP_IDEAS:]
    views = {entry.post.id: _idea_view(board, entry, found, whole=whole) for entry in listed}
    held = branches(board)
    ordered = (*(item for item in held if item.retired is None), *(item for item in held if item.retired is not None))
    return MapView(
        branches=tuple(
            BranchView(
                **dict(_line(board, item, now)),
                added_by=item.added.post.id,
                retired_by=item.retired.post.id if item.retired else None,
                idea_list=tuple(view for view in views.values() if view.branch == item.branch.id),
            )
            for item in ordered
        ),
        sealed=sum(_sealed(entry.post) for entry in found.ideas),
        left_out=len(found.ideas) - len(listed),
    )


def _idea_view(board: Board, entry: Posted, found: Ideas, *, whole: bool) -> IdeaView:
    post = entry.post
    cut = (lambda text: text) if whole else line_text
    tries = found.tries.get(post.id, ())
    challenges = tuple(
        (check, result) for result in tries if isinstance(result.post, Result) for check in _challenges(board, result)
    )
    return IdeaView(
        id=post.id,
        thread=post.thread,
        author=post.author,
        at=entry.at,
        text=cut(post.text),
        parent=post.parent if isinstance(post, Idea) else None,
        branch=found.branch.get(post.id),
        state=found.states[post.id],
        test=cut(post.test) if isinstance(post, Idea) else '',
        rules_out=cut(post.rules_out) if isinstance(post, Idea) else '',
        tries=tuple(
            TryLine(
                post=one.post.id,
                thread=one.post.thread,
                kind='result' if isinstance(one.post, Result) else 'plan',
                author=one.post.author,
                text=cut(one.post.text),
                at=one.at,
                standing=standing(board, one.post.id),
            )
            for one in tries
        ),
        challenges=tuple(
            ChallengeLine(
                post=check.post.id,
                thread=check.post.thread,
                result=result.post.id,
                author=check.post.author,
                text=cut(check.post.text),
                outcome=check.post.outcome if isinstance(check.post, Check) else 'holds',
            )
            for check, result in challenges
        ),
        ruled_out_by=tuple(ruling.post.id for ruling in found.rulings.get(post.id, ())),
        sealed=_sealed(post),
    )


def _sealed(post: Post) -> bool:
    # A view of an idea that is sealed for its reader has no parent, and the record holds no idea without one.
    return isinstance(post, Idea) and post.parent is None


def _hours(span: timedelta) -> float:
    return round(max(span.total_seconds(), 0) / 3_600, 1)


def check_ideas(board: Board, event: Posted) -> None:
    """
    Check a post against the rules of the map, at the time of its event.

    Raises:
        RejectedEvent: A reading adds a branch with an ID that the lab had, or with the title of a branch in force,
            retires a branch that is not in force, or leaves more than `MAX_BRANCHES` in force. An idea hangs on
            no branch in force and on no idea, or is in a thread for talk. A post names in `idea` a post that is no
            idea, or an idea that is sealed. The message says which.

    """
    post = event.post
    if isinstance(post, Reading) and (post.branches or post.retires):
        _check_branches(board, post)
    if isinstance(post, Idea):
        _check_idea(board, post, event.at)
    target = idea_of(post)
    if target is not None:
        named = board.post(target)
        if named is None or not isinstance(named.post, Idea):
            raise RejectedEvent(f'Post {target} is no idea, so `idea` cannot name it.')
        check_unsealed(board, target, event.at, 'post that names it in `idea`')


def _check_branches(board: Board, reading: Reading) -> None:
    held = branches(board)
    known = {item.branch.id for item in held}
    standing_now = {item.branch.id: item.branch.title for item in held if item.retired is None}
    for branch_id in reading.retires:
        if branch_id not in standing_now:
            raise RejectedEvent(f'Branch {branch_id} is not in force, so no reading retires it.')
    titles = {title.casefold(): branch_id for branch_id, title in standing_now.items()}
    for branch in reading.branches:
        if branch.id in known:
            raise RejectedEvent(f'The lab had branch {branch.id} already.')
        same = titles.get(branch.title.casefold())
        if same and same not in reading.retires:
            raise RejectedEvent(
                f'Branch {same} has the title "{branch.title}" and is in force. It stays in force until a reading '
                'retires it.'
            )
        titles[branch.title.casefold()] = branch.id
    left = len(standing_now) - len(set(reading.retires)) + len(reading.branches)
    if left > MAX_BRANCHES:
        raise RejectedEvent(
            f'A lab has at most {MAX_BRANCHES} branches in force, and this reading would leave {left}. `retires` '
            'ends branches.'
        )


def _check_idea(board: Board, idea: Idea, at: datetime) -> None:
    # `society.rounds` checks an idea that replies to a post as an entry of a round.
    talk = (board.conversation, board.desk_chat)
    if idea.thread in talk or board.holds_offers(idea.thread):
        raise RejectedEvent(
            'An idea is for the whole lab, so it is in no conversation, no desk chat, and no thread of offers.'
        )
    parent = idea.parent or ''
    if parent.startswith('p-'):
        check_unsealed(board, parent, at, 'idea that hangs on it')
        found = board.post(parent)
        if found is None or not isinstance(found.post, Idea):
            raise RejectedEvent(f'Post {parent} is no idea, so no idea hangs on it.')
        parent = ideas_of(board).branch.get(parent) or ''
    held = next((item for item in branches(board) if item.branch.id == parent), None)
    if held is None:
        raise RejectedEvent(
            f'The lab has no branch {idea.parent}. An idea hangs on a branch that a reading added, or on another idea.'
        )
    if held.retired is not None:
        raise RejectedEvent(
            f'Branch {held.branch.id} was retired by reading {held.retired.post.id}, so no new idea hangs on it.'
        )


CHALLENGED_FROM = 2
"""The fewest agents that do the work in a lab whose new proposals rest only on challenged results."""


def working_agents(board: Board) -> tuple[AgentId, ...]:
    """
    Return the agents that do the lab's work: the agents of the lab that are known to be in it and have not left.

    The desk is no part of the lab's work, and a blind checker of an older record is no agent of the lab.
    """
    return tuple(
        joined.agent.id
        for joined in board.agents
        if not joined.agent.checks and not board.is_desk(joined.agent.id) and board.here(joined)
    )


def unchallenged(board: Board, proposal: Post) -> tuple[PostId, ...]:
    """Return the results in a post's `builds_on` that have no challenge from another agent, each once, in its order."""
    results = (found for post_id in dict.fromkeys(proposal.builds_on) if (found := board.post(post_id)))
    return tuple(entry.post.id for entry in results if isinstance(entry.post, Result) and not _challenges(board, entry))


def check_rests_on(board: Board, post: Post) -> None:
    """
    Check that a new proposal rests only on challenged results, in a lab with two or more agents that do the work.

    A record from before the rule holds proposals that rest on results without a challenge, so the board checks this
    for a new post only, and not as a rule of the record. A lab with one agent that does the work has nobody to
    challenge its results, and the rule does not hold it.

    Raises:
        RejectedEvent: The post is a proposal, the lab has two or more agents that do the work, and a result that it
            builds on has no challenge from another agent. The message lists those results.

    """
    if not isinstance(post, Proposal) or post.author == PERSON or len(working_agents(board)) < CHALLENGED_FROM:
        return
    missing = unchallenged(board, post)
    if missing:
        raise RejectedEvent(
            'In a lab with two or more agents that do the work, a proposal rests only on results that another agent '
            f'challenged, with a check of the method `challenge`. These results that it builds on have none yet: '
            f'{", ".join(missing)}.'
        )
