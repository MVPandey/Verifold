"""
Votes and badges on posts: which stand, who can cast them, and how a view shows them.

A vote is one voter's word on one post, up or down, with a reason. A voter has one vote on a post: a new one
replaces it, and `none` takes it back. Every vote counts the same. A badge is a mark on a post with who gave it and
why: `promising`, `confirmed`, or `breakthrough`. A `breakthrough` stands only after a second from the agent that
holds the coordinator seat or from the person.

The code counts votes for a post and for nothing else: no function here adds up votes or badges for an agent, and
none orders posts, threads, or agents by them. A vote and a badge wake nobody and change no standing, no seat, no
list of a brief, and no answer. The only reader of a badge outside these views is the person's app, which draws a
post with a `breakthrough` differently.

The rules here hold for every event, so no tool goes around them: nobody votes on its own post or gives it a badge,
a vote up or down and a badge have a reason, and only the coordinator or the person seconds a `breakthrough`.
"""

from collections.abc import Iterable
from dataclasses import dataclass, replace

from verifold.protocol.events import BadgeSet, Posted, Voted
from verifold.protocol.ids import PERSON, AgentId, PostId, ThreadId
from verifold.protocol.posts import Check, Result
from verifold.protocol.votes import (
    BADGES,
    MAX_NOTES,
    MAX_VOTE_LINES,
    Badge,
    BadgeLine,
    BadgeNote,
    Given,
    ProposalLine,
    VoteLine,
    VoteNote,
)
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent

_KEPT = 8
"""How many lists of events keep their index: the votes and the badges of the boards that were read last."""


class _ByPost[E: (Voted, BadgeSet)]:
    """
    The events of one kind by the post that they are about.

    A view asks for the votes of every post, and a scan of all votes for each one costs time that grows with the
    square of the record. A board never changes, so the index of its tuple holds for as long as the tuple lives.
    """

    def __init__(self) -> None:
        self._kept: list[tuple[tuple[E, ...], dict[PostId, tuple[E, ...]]]] = []

    def of(self, entries: tuple[E, ...]) -> dict[PostId, tuple[E, ...]]:
        for kept, index in self._kept:
            if kept is entries:
                return index
        grouped: dict[PostId, list[E]] = {}
        for entry in entries:
            grouped.setdefault(entry.post, []).append(entry)
        index = {post: tuple(found) for post, found in grouped.items()}
        self._kept.append((entries, index))
        del self._kept[:-_KEPT]
        return index


_votes: _ByPost[Voted] = _ByPost()
_badges: _ByPost[BadgeSet] = _ByPost()


@dataclass(frozen=True, slots=True)
class Held:
    """A badge that one giver holds on a post: the event that gave it and, for a `breakthrough`, its second."""

    given: BadgeSet
    second: BadgeSet | None = None

    @property
    def stands(self) -> bool:
        """Whether the badge is in effect. A `breakthrough` is only after its second."""
        return self.given.badge != 'breakthrough' or self.second is not None


def _standing(votes: Iterable[Voted]) -> dict[AgentId, Voted]:
    # The votes of one post that stand: the latest of each voter, without the ones taken back, in the order cast.
    latest: dict[AgentId, Voted] = {}
    for vote in votes:
        latest.pop(vote.by, None)
        if vote.direction != 'none':
            latest[vote.by] = vote
    return latest


def _held(changes: Iterable[BadgeSet]) -> dict[tuple[Badge, AgentId], Held]:
    # The badges of one post that givers hold, by badge and giver, in the order given.
    held: dict[tuple[Badge, AgentId], Held] = {}
    for change in changes:
        key = (change.badge, change.giver or change.by)
        if change.action == 'give':
            held[key] = Held(change)
        elif change.action == 'take_back':
            held.pop(key, None)
        elif key in held:
            held[key] = replace(held[key], second=change)
    return held


def standing_votes(board: Board, post_id: PostId) -> tuple[Voted, ...]:
    """Return the votes on a post that stand: one for each voter, in the order that they were cast."""
    return tuple(_standing(_votes.of(board.votes).get(post_id, ())).values())


def vote_of(board: Board, by: AgentId, post_id: PostId) -> Voted | None:
    """Return a voter's standing vote on a post, or `None`."""
    # The fold asks this for each new vote, and each of its boards has other votes, so no index pays here.
    latest = next((vote for vote in reversed(board.votes) if vote.by == by and vote.post == post_id), None)
    return latest if latest and latest.direction != 'none' else None


def held_badges(board: Board, post_id: PostId) -> tuple[Held, ...]:
    """Return the badges that givers hold on a post, a proposed `breakthrough` among them, in the order given."""
    return tuple(_held(_badges.of(board.badges).get(post_id, ())).values())


def proposal(board: Board, post_id: PostId) -> BadgeSet | None:
    """Return the proposal of a `breakthrough` for a post that waits for its second, or `None`."""
    held = _held(change for change in board.badges if change.post == post_id)
    return next((entry.given for entry in held.values() if not entry.stands), None)


def marks(board: Board, post_id: PostId) -> tuple[int, int, tuple[Badge, ...]]:
    """Return what a post's line holds: its votes up, its votes down, and the badges that stand on it, each once."""
    votes = standing_votes(board, post_id)
    up = sum(vote.direction == 'up' for vote in votes)
    standing = {entry.given.badge for entry in held_badges(board, post_id) if entry.stands}
    return up, len(votes) - up, tuple(badge for badge in BADGES if badge in standing)


def vote_lines(board: Board, post_id: PostId) -> tuple[VoteLine, ...]:
    """Return the newest standing votes on a post with their reasons, oldest first, at most `MAX_VOTE_LINES`."""
    return tuple(
        VoteLine(by=vote.by, direction=vote.direction, reason=vote.reason, at=vote.at)
        for vote in standing_votes(board, post_id)[-MAX_VOTE_LINES:]
        if vote.direction != 'none'
    )


def badge_lines(board: Board, post_id: PostId) -> tuple[BadgeLine, ...]:
    """Return each badge on a post once, with every giver. A `breakthrough` without a second says that it waits."""
    held = held_badges(board, post_id)
    lines = (
        (badge, tuple(entry for entry in held if entry.given.badge == badge))
        for badge in BADGES
        if any(entry.given.badge == badge for entry in held)
    )
    return tuple(
        BadgeLine(
            badge=badge,
            given=tuple(_given(entry.given) for entry in entries),
            second=_given(entries[0].second) if entries[0].second else None,
            waits=not entries[0].stands,
        )
        for badge, entries in lines
    )


def _given(change: BadgeSet) -> Given:
    return Given(by=change.by, reason=change.reason, at=change.at, proof=change.proof)


def breakthrough_threads(board: Board) -> tuple[ThreadId, ...]:
    """Return the threads that hold a post with a `breakthrough` that stands, each once, in the record's order."""
    posts = _badges.of(board.badges)
    stood = (
        post
        for post in posts
        if any(entry.given.badge == 'breakthrough' and entry.stands for entry in _held(posts[post]).values())
    )
    return tuple(dict.fromkeys(entry.post.thread for post in stood if (entry := board.post(post))))


def proposals(board: Board) -> tuple[ProposalLine, ...]:
    """Return each `breakthrough` that waits for its second, oldest first."""
    posts = _badges.of(board.badges)
    waiting = sorted(
        (entry.given for changes in posts.values() for entry in _held(changes).values() if not entry.stands),
        key=lambda change: change.seq,
    )
    return tuple(
        ProposalLine(post=change.post, thread=target.post.thread, by=change.by, reason=change.reason, at=change.at)
        for change in waiting
        if (target := board.post(change.post))
    )


def vote_notes(board: Board, agent_id: AgentId, after: int, reach: int) -> tuple[VoteNote, ...]:
    """
    Return the votes on an agent's own posts after event `after`, up to event `reach`, as news.

    A voter that voted on one post more than once in that time is there once, with its latest vote. The newest
    `MAX_NOTES` are there, oldest first. `thread` shows every vote that stands.
    """
    fresh = (vote for vote in board.votes if after < vote.seq <= reach and vote.by != agent_id)
    latest = {
        (vote.post, vote.by): vote
        for vote in fresh
        if (target := board.post(vote.post)) and target.post.author == agent_id
    }
    notes = sorted(latest.values(), key=lambda vote: vote.seq)[-MAX_NOTES:]
    return tuple(VoteNote(post=vote.post, by=vote.by, direction=vote.direction, reason=vote.reason) for vote in notes)


def badge_notes(board: Board, agent_id: AgentId, after: int, reach: int) -> tuple[BadgeNote, ...]:
    """
    Return the changes to badges after event `after`, up to event `reach`, that are news for an agent.

    A change by another is news for the author of the post, and for the agent that proposed a `breakthrough` for
    the post. A proposal is news for the agent that holds the coordinator seat when it can second it. The newest
    `MAX_NOTES` are there, oldest first.
    """
    fresh = tuple(change for change in board.badges if after < change.seq <= reach and change.by != agent_id)
    notes = tuple(change for change in fresh if _concerns(board, agent_id, change))[-MAX_NOTES:]
    return tuple(
        BadgeNote(post=change.post, badge=change.badge, by=change.by, action=change.action, reason=change.reason)
        for change in notes
    )


def _concerns(board: Board, agent_id: AgentId, change: BadgeSet) -> bool:
    target = board.post(change.post)
    if target is None:
        return False
    if agent_id in (target.post.author, change.giver):
        return True
    proposes = change.badge == 'breakthrough' and change.action == 'give'
    return proposes and board.coordinator == agent_id


def check_vote(board: Board, vote: Voted) -> None:
    """
    Check that a vote can go in the record.

    Raises:
        RejectedEvent: The voter is not in the lab, left it, or is a blind checker, the post does not exist or is
            the voter's own, a vote up or down has no reason, or the voter takes back a vote that it does not have.

    """
    _check_can(board, vote.by, 'votes on no post')
    target = _target(board, vote.post)
    if target.post.author == vote.by:
        raise RejectedEvent(f'Post {vote.post} is your own. A vote on a post comes from another agent or the person.')
    if vote.direction == 'none':
        if vote_of(board, vote.by, vote.post) is None:
            raise RejectedEvent(f'You have no vote on post {vote.post}, so there is none to take back.')
    elif not vote.reason:
        raise RejectedEvent(f'A vote {vote.direction} has a reason of one line. `reason` holds it.')


def check_badge(board: Board, change: BadgeSet) -> None:
    """
    Check that a change to a badge can go in the record.

    Raises:
        RejectedEvent: The one who makes the change is not in the lab, left it, or is a blind checker, the post
            does not exist, or the change breaks a rule of its action, which the message names.

    """
    _check_can(board, change.by, 'gives no badge')
    target = _target(board, change.post)
    held = _held(entry for entry in board.badges if entry.post == change.post)
    if change.action == 'give':
        _check_give(board, change, target, held)
    elif change.action == 'second':
        _check_second(board, change, target, held)
    else:
        key = (change.badge, change.giver or change.by)
        if key not in held:
            raise RejectedEvent(f'{key[1]} holds no `{change.badge}` badge on post {change.post}.')
        if change.by not in (PERSON, key[1]):
            raise RejectedEvent('Only its giver and the person take a badge back.')


def _check_give(board: Board, change: BadgeSet, target: Posted, held: dict[tuple[Badge, AgentId], Held]) -> None:
    post = change.post
    if change.giver is not None:
        raise RejectedEvent('`giver` says whose badge a `second` or a `take_back` is about. A `give` has none.')
    if target.post.author == change.by:
        raise RejectedEvent(f'Post {post} is your own. A badge on a post comes from another agent or the person.')
    if not change.reason:
        raise RejectedEvent('A badge has a reason of one line. `reason` holds it.')
    if (change.badge, change.by) in held:
        raise RejectedEvent(f'You gave post {post} the `{change.badge}` badge already. `take_back` removes it.')
    if change.badge == 'confirmed':
        _check_proof(board, change, target)
    elif change.proof is not None:
        raise RejectedEvent('Only a `confirmed` badge has `proof`.')
    if change.badge != 'breakthrough':
        return
    if change.by == PERSON:
        raise RejectedEvent('An agent proposes a `breakthrough` badge, and the person seconds it.')
    waiting = next((entry.given for (badge, _), entry in held.items() if badge == 'breakthrough'), None)
    if waiting:
        raise RejectedEvent(f'{waiting.by} proposed a `breakthrough` badge for post {post} already.')


def _check_proof(board: Board, change: BadgeSet, target: Posted) -> None:
    # What confirmed a post is a check of it that holds, or a result that builds on it, by another than its author.
    # The person names one or none. The rule reads no text: it does not judge whether the named post is right.
    if change.proof is None:
        if change.by == PERSON:
            return
        raise RejectedEvent(
            'A `confirmed` badge names in `proof` the post that confirmed it: a check of the post that holds, or '
            'a result that builds on the post.'
        )
    named = board.post(change.proof)
    if named is None:
        raise RejectedEvent(f'Post {change.proof} does not exist.')
    post = named.post
    checks = isinstance(post, Check) and post.reply_to == change.post and post.outcome == 'holds'
    builds = isinstance(post, Result) and change.post in post.builds_on
    if not (checks or builds):
        raise RejectedEvent(
            f'Post {change.proof} is no check of post {change.post} that holds, and no result that builds on it.'
        )
    if post.author == target.post.author:
        raise RejectedEvent(
            f'{post.author} wrote both post {change.post} and post {change.proof}. What confirms a post comes from '
            'another agent.'
        )


def _check_second(board: Board, change: BadgeSet, target: Posted, held: dict[tuple[Badge, AgentId], Held]) -> None:
    post = change.post
    if change.badge != 'breakthrough':
        raise RejectedEvent('Only a `breakthrough` badge takes a second.')
    entry = held.get(('breakthrough', change.giver)) if change.giver else None
    if entry is None:
        raise RejectedEvent(f'No proposal of a `breakthrough` badge for post {post} waits for a second.')
    if entry.second is not None:
        raise RejectedEvent(f'The `breakthrough` badge on post {post} has its second already.')
    if target.post.author == change.by:
        raise RejectedEvent(f'Post {post} is your own. Nobody seconds a badge for its own post.')
    if change.by == PERSON:
        return
    if change.by != board.coordinator:
        raise RejectedEvent(
            'Only the agent that holds the coordinator seat and the person second a `breakthrough` badge.'
        )
    if change.by == change.giver:
        raise RejectedEvent(f'You proposed the `breakthrough` badge for post {post}. Only the person seconds it.')


def _target(board: Board, post_id: PostId) -> Posted:
    target = board.post(post_id)
    if target is None:
        raise RejectedEvent(f'Post {post_id} does not exist.')
    return target


def _check_can(board: Board, by: AgentId, what: str) -> None:
    # The person, and each agent of the lab that is in it. A checker of a record from before agents took reruns
    # posted one check and did nothing else.
    if by == PERSON:
        return
    joined = board.agent(by)
    if joined is None:
        raise RejectedEvent(f'{by} is not an agent in this lab.')
    if board.gone(by):
        raise RejectedEvent(f'{by} left this lab, so the board takes no post and no other change from it.')
    if joined.agent.checks:
        raise RejectedEvent(f'A blind checker posts one check and {what}.')
