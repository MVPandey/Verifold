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
a vote up or down and a badge have a reason, a `confirmed` from an agent names a check of the post that holds, and
only the person, or the coordinator that the person seated before the proposal, seconds a `breakthrough`. A badge
is about an agent's work, so no post of the person takes one. A request of a harness, a request for a move, and
the person's decision about an offer are no work to judge, so they take no vote and no badge.

For an agent, the votes on a post are sealed while the post is younger than the lab's reveal time and the agent
neither wrote it nor voted on it. A sealed post's views show no count, no voter, and no reason, as for a post that
has no vote, so an agent's vote is its own and not the tally's. The post's author and the person see every vote at
once. A badge is never sealed.

The board keeps the latest vote of each voter and the badge changes of each post, so a rule and a view read one
post's and never scan the record.
"""

from bisect import bisect_right
from dataclasses import dataclass, replace
from datetime import datetime, timedelta

from verifold.protocol.events import BadgeSet, Posted, Voted
from verifold.protocol.ids import PERSON, AgentId, PostId, ThreadId
from verifold.protocol.posts import Ask, Check, MoveRequest
from verifold.protocol.votes import (
    BADGES,
    MAX_GIVES,
    MAX_NOTES,
    MAX_VOTE_LINES,
    Badge,
    BadgeLine,
    BadgeNote,
    Given,
    Lapsed,
    ProposalLine,
    VoteLine,
    VoteNote,
)
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.lifecycle import latest_time
from verifold.society.rounds import check_unsealed
from verifold.society.standing import standing


@dataclass(frozen=True, slots=True)
class Held:
    """A badge that one giver holds on a post: the event that gave it and, for a `breakthrough`, its second."""

    given: BadgeSet
    second: BadgeSet | None = None

    @property
    def stands(self) -> bool:
        """Whether the badge has what it needs from its givers. A `breakthrough` has only after its second."""
        return self.given.badge != 'breakthrough' or self.second is not None


def with_vote(board: Board, vote: Voted) -> Board:
    """Return the board after a vote: the record has one more vote, and the post has the voter's latest vote."""
    latest = dict(board.votes_on.get(vote.post, {}))
    # The vote goes to the end, so the votes stay in the order that they were cast.
    latest.pop(vote.by, None)
    latest[vote.by] = vote
    votes_on = {**board.votes_on, vote.post: latest}
    return replace(board, seq=vote.seq, votes=(*board.votes, vote), votes_on=votes_on)


def with_badge(board: Board, change: BadgeSet) -> Board:
    """Return the board after a change to a badge: the record and the post each have one more change."""
    badges_on = {**board.badges_on, change.post: (*board.badges_on.get(change.post, ()), change)}
    return replace(board, seq=change.seq, badges=(*board.badges, change), badges_on=badges_on)


def _held(changes: tuple[BadgeSet, ...]) -> dict[tuple[Badge, AgentId], Held]:
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
    return tuple(vote for vote in board.votes_on.get(post_id, {}).values() if vote.direction != 'none')


def vote_of(board: Board, by: AgentId, post_id: PostId) -> Voted | None:
    """Return a voter's standing vote on a post, or `None`."""
    vote = board.votes_on.get(post_id, {}).get(by)
    return vote if vote and vote.direction != 'none' else None


def sealed(board: Board, reader: AgentId, entry: Posted, now: datetime | None = None) -> bool:
    """
    Return whether the votes on a post are sealed for a reader at `now`, so that no view for it shows them.

    They are for an agent that did not write the post and never voted on it, until the post is `revealed`. A vote
    that the agent took back, in a record from before the board refused that, still counts as its vote. The person
    sees every vote at once. Without `now`, time counts from the board's newest post, which is never later than
    the lab's clock, so a view without a clock shows no vote that the lab's clock would seal.
    """
    if reader in (PERSON, entry.post.author) or reader in board.votes_on.get(entry.post.id, {}):
        return False
    return (now or latest_time(board)) < revealed(board, entry)


def revealed(board: Board, entry: Posted) -> datetime:
    """
    Return when the votes on a post show to every agent.

    That is the reveal time of the settings that the lab followed when the post was written, after the post's time.
    A later change of the setting leaves the post as it was.
    """
    return entry.at + timedelta(minutes=board.settings_at(entry.seq).votes.reveal_minutes)


def held_badges(board: Board, post_id: PostId) -> tuple[Held, ...]:
    """Return the badges that givers hold on a post, a proposed `breakthrough` among them, in the order given."""
    return tuple(_held(board.badges_on.get(post_id, ())).values())


def proposal(board: Board, post_id: PostId) -> BadgeSet | None:
    """Return the proposal of a `breakthrough` for a post that waits for its second, or `None`."""
    return next((entry.given for entry in held_badges(board, post_id) if not entry.stands), None)


def lapsed(board: Board, given: BadgeSet) -> Lapsed | None:
    """
    Return why a giver's `confirmed` confirms its post no longer, or `None` while it does.

    It does while no check of the post failed after the check that the giver named, and the author of that check
    did not concede an objection to it. For the person's word without a check, a failed check after that word
    ends it. A failed check that its own author conceded counts for nothing.
    """
    named = board.post(given.proof) if given.proof else None
    if named and standing(board, named.post.id) == 'conceded':
        return 'check_conceded'
    since = named.seq if named else given.seq
    failed = any(
        isinstance(entry.post, Check)
        and entry.post.outcome == 'fails'
        and entry.seq > since
        and standing(board, entry.post.id) != 'conceded'
        for entry in board.replies(given.post)
    )
    return 'later_check_failed' if failed else None


def _in_effect(board: Board, entry: Held) -> bool:
    # Whether a held badge is a badge of its post now: seconded for a breakthrough, and not lapsed for a confirmed.
    if entry.given.badge == 'confirmed':
        return lapsed(board, entry.given) is None
    return entry.stands


def marks(board: Board, post_id: PostId) -> tuple[int, int, tuple[Badge, ...]]:
    """Return what a post's line holds: its votes up, its votes down, and the badges that stand on it, each once."""
    votes = standing_votes(board, post_id)
    up = sum(vote.direction == 'up' for vote in votes)
    standing_badges = {entry.given.badge for entry in held_badges(board, post_id) if _in_effect(board, entry)}
    return up, len(votes) - up, tuple(badge for badge in BADGES if badge in standing_badges)


def vote_lines(board: Board, post_id: PostId, most: int = MAX_VOTE_LINES) -> tuple[VoteLine, ...]:
    """Return the newest standing votes on a post with their reasons, oldest first, at most `most`."""
    return tuple(
        VoteLine(by=vote.by, direction='up' if vote.direction == 'up' else 'down', reason=vote.reason, at=vote.at)
        for vote in standing_votes(board, post_id)[-most:]
    )


def badge_lines(board: Board, post_id: PostId) -> tuple[BadgeLine, ...]:
    """
    Return each badge on a post once, with every giver.

    A `breakthrough` without a second says that it waits, and who but the person can second it. A `confirmed`
    says for each giver whether its word still confirms the post.
    """
    held = held_badges(board, post_id)
    target = board.post(post_id)
    lines = (
        (badge, tuple(entry for entry in held if entry.given.badge == badge))
        for badge in BADGES
        if any(entry.given.badge == badge for entry in held)
    )
    return tuple(
        BadgeLine(
            badge=badge,
            given=tuple(_given(board, entry.given) for entry in entries),
            second=_given(board, entries[0].second) if entries[0].second else None,
            waits=not entries[0].stands,
            seconder=_seconder(board, entries[0].given, target) if target and not entries[0].stands else None,
            lapsed=badge == 'confirmed' and not any(_in_effect(board, entry) for entry in entries),
        )
        for badge, entries in lines
    )


def _given(board: Board, change: BadgeSet) -> Given:
    gone = lapsed(board, change) if change.badge == 'confirmed' and change.action == 'give' else None
    return Given(by=change.by, reason=change.reason, at=change.at, proof=change.proof, lapsed=gone)


def breakthrough_threads(board: Board) -> tuple[ThreadId, ...]:
    """Return the threads that hold a post with a `breakthrough` that stands, each once, in the record's order."""
    stood = (
        post
        for post, changes in board.badges_on.items()
        if any(entry.given.badge == 'breakthrough' and entry.stands for entry in _held(changes).values())
    )
    return tuple(dict.fromkeys(entry.post.thread for post in stood if (entry := board.post(post))))


def proposals(board: Board) -> tuple[ProposalLine, ...]:
    """Return each `breakthrough` that waits for its second, oldest first."""
    waiting = sorted(
        (entry.given for changes in board.badges_on.values() for entry in _held(changes).values() if not entry.stands),
        key=lambda change: change.seq,
    )
    return tuple(
        ProposalLine(post=change.post, thread=target.post.thread, by=change.by, reason=change.reason, at=change.at)
        for change in waiting
        if (target := board.post(change.post))
    )


def _between[E: (Voted, BadgeSet)](entries: tuple[E, ...], after: int, reach: int) -> tuple[E, ...]:
    # The events after `after`, up to `reach`. They are in the record's order, so two searches find them.
    return entries[
        bisect_right(entries, after, key=lambda entry: entry.seq) : bisect_right(
            entries, reach, key=lambda entry: entry.seq
        )
    ]


def vote_notes(board: Board, agent_id: AgentId, after: int, reach: int) -> tuple[tuple[VoteNote, ...], int]:
    """
    Return the votes on an agent's own posts after event `after`, up to event `reach`, as news, and how many more.

    A voter that voted on one post more than once in that time is there once, with its latest vote. The newest
    `MAX_NOTES` are there, oldest first, and the number says how many older ones are left out. `thread` shows the
    votes that stand.
    """
    latest = {
        (vote.post, vote.by): vote
        for vote in _between(board.votes, after, reach)
        if vote.by != agent_id and (target := board.post(vote.post)) and target.post.author == agent_id
    }
    found = sorted(latest.values(), key=lambda vote: vote.seq)
    notes = tuple(
        VoteNote(post=vote.post, by=vote.by, direction=vote.direction, reason=vote.reason)
        for vote in found[-MAX_NOTES:]
    )
    return notes, max(len(found) - MAX_NOTES, 0)


def badge_notes(board: Board, agent_id: AgentId, after: int, reach: int) -> tuple[tuple[BadgeNote, ...], int]:
    """
    Return the changes to badges after event `after`, up to event `reach`, that are news for an agent, and how many more.

    A change by another is news for the author of the post, and for the agent whose badge or proposal it is about.
    A proposal of a `breakthrough` is news for the agent that holds the coordinator seat. The newest `MAX_NOTES`
    are there, oldest first, and the number says how many older ones are left out.
    """
    found = tuple(
        change
        for change in _between(board.badges, after, reach)
        if change.by != agent_id and _concerns(board, agent_id, change)
    )
    notes = tuple(
        BadgeNote(post=change.post, badge=change.badge, by=change.by, action=change.action, reason=change.reason)
        for change in found[-MAX_NOTES:]
    )
    return notes, max(len(found) - MAX_NOTES, 0)


def _concerns(board: Board, agent_id: AgentId, change: BadgeSet) -> bool:
    target = board.post(change.post)
    if target and agent_id in (target.post.author, change.giver):
        return True
    proposes = change.badge == 'breakthrough' and change.action == 'give'
    return proposes and board.coordinator == agent_id


def check_vote(board: Board, vote: Voted) -> None:
    """
    Check that a vote can go in the record.

    Raises:
        RejectedEvent: The voter is not in the lab, left it, or is a blind checker, the post does not exist, is
            the voter's own, is no work to judge, or is an entry of a round that is open, a vote up or down has no
            reason, or the voter takes back a vote that it does not have.

    """
    _check_can(board, vote.by, 'votes on no post')
    target = _target(board, vote.post)
    if target.post.author == vote.by:
        raise RejectedEvent(f'Post {vote.post} is your own. A vote on a post comes from another agent or the person.')
    _check_work(board, target, 'vote')
    check_unsealed(board, vote.post, vote.at, 'vote')
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
            does not exist or is an entry of a round that is open, or the change breaks a rule of its action, which
            the message names.

    """
    _check_can(board, change.by, 'gives no badge')
    target = _target(board, change.post)
    check_unsealed(board, change.post, change.at, 'badge')
    changes = board.badges_on.get(change.post, ())
    held = _held(changes)
    if change.action == 'give':
        _check_give(board, change, target, changes)
    elif change.action == 'second':
        _check_second(board, change, target, held)
    else:
        key = (change.badge, change.giver or change.by)
        if key not in held:
            raise RejectedEvent(f'{key[1]} holds no `{change.badge}` badge on post {change.post}.')
        if change.by not in (PERSON, key[1]):
            raise RejectedEvent('Only its giver and the person take a badge back.')


def _check_work(board: Board, target: Posted, what: str) -> None:
    # A vote and a badge are about work. These posts are requests and decisions, and nobody judges them so.
    post = target.post
    kind = None
    if isinstance(post, MoveRequest):
        kind = 'a request for a move of the person'
    elif isinstance(post, Ask) and post.request:
        kind = 'a request of a harness'
    elif any(decision.post == post.id for decision in board.decisions):
        kind = "the person's decision about an offer"
    if kind:
        raise RejectedEvent(f'Post {post.id} is {kind}, and the board takes no {what} on it.')


def _check_give(board: Board, change: BadgeSet, target: Posted, changes: tuple[BadgeSet, ...]) -> None:
    post, held = change.post, _held(changes)
    if change.giver is not None:
        raise RejectedEvent('`giver` says whose badge a `second` or a `take_back` is about. A `give` has none.')
    if target.post.author == change.by:
        raise RejectedEvent(f'Post {post} is your own. A badge on a post comes from another agent or the person.')
    if target.post.author == PERSON:
        raise RejectedEvent(f"Post {post} is the person's. A badge is about an agent's work, so it takes none.")
    _check_work(board, target, 'badge')
    if not change.reason:
        raise RejectedEvent('A badge has a reason of one line. `reason` holds it.')
    if (change.badge, change.by) in held:
        raise RejectedEvent(f'You gave post {post} the `{change.badge}` badge already. `take_back` removes it.')
    mine = tuple(one for one in changes if one.badge == change.badge and (one.giver or one.by) == change.by)
    if sum(one.action == 'give' for one in mine) >= MAX_GIVES:
        raise RejectedEvent(
            f'You gave post {post} the `{change.badge}` badge {MAX_GIVES} times and took it back each time. The '
            'board takes it from you for this post no more.'
        )
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
    if any(one.action == 'take_back' and one.by == PERSON for one in mine):
        raise RejectedEvent(
            f'The person took back your `breakthrough` badge for post {post}, so the board takes no other '
            'proposal for that post from you.'
        )


def _check_proof(board: Board, change: BadgeSet, target: Posted) -> None:
    # What confirmed a post is a check of it that holds, from another agent than its author. The reviewer seats
    # limit who posts such a check. The person names one or none. The rule reads no text of the check.
    if change.proof is None:
        if change.by == PERSON:
            return
        raise RejectedEvent(
            'A `confirmed` badge names in `proof` the post that confirmed it: a check of the post with the '
            'outcome `holds`.'
        )
    named = board.post(change.proof)
    if named is None:
        raise RejectedEvent(f'Post {change.proof} does not exist.')
    post = named.post
    if not (isinstance(post, Check) and post.reply_to == change.post and post.outcome == 'holds'):
        raise RejectedEvent(f'Post {change.proof} is no check of post {change.post} with the outcome `holds`.')
    if post.author == target.post.author:
        raise RejectedEvent(
            f'{post.author} wrote both post {change.post} and post {change.proof}. What confirms a post comes from '
            'another agent.'
        )
    if lapsed(board, change):
        raise RejectedEvent(
            f'A check of post {change.post} failed after post {change.proof}, or the author of {change.proof} '
            'conceded an objection to it. So it confirms the post no longer.'
        )


def second_refusal(board: Board, by: AgentId, proposed: BadgeSet, target: Posted) -> str | None:
    """
    Return why `by` cannot second a proposed `breakthrough`, or `None` when it can.

    The person can. An agent can when the person gave it the coordinator seat, it has held the seat since before
    the proposal, and it neither proposed the badge nor wrote the post. An agent that took the seat for itself
    cannot, so no agent seats itself to second, and no two agents pass a seat between them to second each other.
    """
    post = proposed.post
    if target.post.author == by:
        return f'Post {post} is your own. Nobody seconds a badge for its own post.'
    if by == PERSON:
        return None
    seated = board.coordinators[-1] if board.coordinators else None
    by_person = seated is not None and seated.by == PERSON and seated.seq < proposed.seq
    if by != board.coordinator or not by_person:
        return (
            'Only the person, and the agent to which the person gave the coordinator seat before the proposal, '
            'second a `breakthrough` badge. An agent that took the seat itself seconds none.'
        )
    if by == proposed.by:
        return f'You proposed the `breakthrough` badge for post {post}. Only the person seconds it.'
    return None


def _seconder(board: Board, proposed: BadgeSet, target: Posted) -> AgentId | None:
    holder = board.coordinator
    return holder if holder and second_refusal(board, holder, proposed, target) is None else None


def _check_second(board: Board, change: BadgeSet, target: Posted, held: dict[tuple[Badge, AgentId], Held]) -> None:
    post = change.post
    if change.badge != 'breakthrough':
        raise RejectedEvent('Only a `breakthrough` badge takes a second.')
    entry = held.get(('breakthrough', change.giver)) if change.giver else None
    if entry is None:
        raise RejectedEvent(f'No proposal of a `breakthrough` badge for post {post} waits for a second.')
    if entry.second is not None:
        raise RejectedEvent(f'The `breakthrough` badge on post {post} has its second already.')
    refusal = second_refusal(board, change.by, entry.given, target)
    if refusal:
        raise RejectedEvent(refusal)


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
    if board.is_desk(by):
        raise RejectedEvent(
            f"The desk is no part of the lab's work, so it {what}. The person's votes and badges are the person's own."
        )
