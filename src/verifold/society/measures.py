"""
The measures of a lab and its headline number.

A measure is a post that reports one number with the script that produced it and that script's output. Another agent
reruns a measure as it reruns any post with files: it takes the wanted rerun, gets the clean copy, and posts the
check of its take. A measure then carries who reran it, and whether that check holds. The mark says who reran the
number and what the rerun found. It never says whether the number is good.

The person names the label of the lab's headline number, and so does the lab's coordinator, with one line of why,
while no label that the person named stands. The newest measure with that label is the headline number's value,
unless its author conceded an objection to it. The board picks no label by itself.
"""

from datetime import datetime

from verifold.protocol.events import Posted
from verifold.protocol.ids import PERSON, AgentId, PostId
from verifold.protocol.join import HeadlineNumberLine, MeasureLine
from verifold.protocol.measures import same_label
from verifold.protocol.posts import Check, HeadlineNumber, Measure
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.reruns import rerun_checks
from verifold.society.standing import standing


def reruns_of(board: Board, post_id: PostId) -> tuple[tuple[AgentId, ...], tuple[AgentId, ...]]:
    """
    Return the agents whose check of an independent rerun of a post holds, and the agents whose check of one fails.

    Such a check is the check of its author's take: the author took the rerun and so was given the clean copy of
    the post's pinned files. A check whose own author conceded an objection to it counts for neither.
    """
    checks = tuple(
        entry.post
        for entry in rerun_checks(board, post_id)
        if isinstance(entry.post, Check) and standing(board, entry.post.id) != 'conceded'
    )
    held = tuple(check.author for check in checks if check.outcome == 'holds')
    failed = tuple(check.author for check in checks if check.outcome == 'fails')
    return held, failed


def measure_line(board: Board, entry: Posted, now: datetime) -> MeasureLine:
    """Return a measure as one line: its number, the time that it holds for and its age at `now`, and who reran it."""
    post = entry.post
    if not isinstance(post, Measure):
        raise TypeError(f'Post {post.id} is no measure.')
    held, failed = reruns_of(board, post.id)
    return MeasureLine(
        post=post.id,
        thread=post.thread,
        by=post.author,
        label=post.label,
        value=post.value,
        unit=post.unit,
        as_of=post.as_of,
        minutes_ago=max(int((now - post.as_of).total_seconds() // 60), 0),
        rerun_by=held,
        rerun_failed_by=failed,
        standing=standing(board, post.id),
    )


def naming(board: Board) -> Posted | None:
    """Return the newest post that names the lab's headline number, or `None` while nobody named one."""
    return next((entry for entry in reversed(board.posts) if isinstance(entry.post, HeadlineNumber)), None)


def headline_label(board: Board) -> str:
    """Return the label of the lab's headline number, or an empty text while the lab has none."""
    named = naming(board)
    return named.post.label if named and isinstance(named.post, HeadlineNumber) else ''


def newest_measure(board: Board, label: str) -> Posted | None:
    """Return the newest measure with a label, unless its author conceded it, or `None` while none has the label."""
    return next(
        (
            entry
            for entry in reversed(board.posts)
            if isinstance(entry.post, Measure)
            and same_label(entry.post.label, label)
            and standing(board, entry.post.id) != 'conceded'
        ),
        None,
    )


def headline_line(board: Board, now: datetime) -> HeadlineNumberLine | None:
    """Return the lab's headline number with who named its label and its newest measure, or `None` while it has none."""
    named = naming(board)
    if named is None or not isinstance(named.post, HeadlineNumber) or not named.post.label:
        return None
    newest = newest_measure(board, named.post.label)
    return HeadlineNumberLine(
        label=named.post.label,
        named_by=named.post.author,
        measure=measure_line(board, newest, now) if newest else None,
    )


def check_measure_post(board: Board, event: Posted) -> None:
    """
    Check a measure and a post that names the headline number. Any other post passes.

    An agent of the lab posts a measure, with a time that is not after its post. The person names a headline
    number, and so does the agent that holds the coordinator seat, with one line of why, while no label that the
    person named stands. Such a post is in a thread for the whole lab and names nobody.

    Raises:
        RejectedEvent: The post breaks one of these rules.

    """
    post = event.post
    if isinstance(post, Measure):
        if post.author == PERSON:
            raise RejectedEvent('A measure is the number of an agent, from a script in its folder.')
        if post.as_of > event.at:
            raise RejectedEvent(
                f'`as_of` is {post.as_of.isoformat()}, after the time of the post. A measure holds for a time that '
                'has come. Without `as_of`, it holds for the time of its post.'
            )
        return
    if not isinstance(post, HeadlineNumber):
        return
    if board.is_side(post.thread) or post.thread in (board.conversation, board.desk_chat) or post.mentions:
        raise RejectedEvent('The headline number is for the whole lab, so its post is in a thread for the whole lab.')
    if post.author == PERSON:
        return
    if post.author != board.coordinator:
        raise RejectedEvent("Only the person and the lab's coordinator name the lab's headline number.")
    if not post.why:
        raise RejectedEvent("The coordinator's naming of the headline number needs `why`: one line.")
    named = naming(board)
    if named and named.post.author == PERSON and headline_label(board):
        raise RejectedEvent(
            f'The person named "{headline_label(board)}" as the headline number, and only the person changes it.'
        )
