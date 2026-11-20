"""What the person's app shows of the lab's measures, its headline number, and its dashboard."""

from verifold.protocol.app import DashboardMeta, HeadlineView, MeasureView
from verifold.protocol.events import Posted
from verifold.protocol.posts import Dashboard, HeadlineNumber, Measure
from verifold.society.board import Board
from verifold.society.dashboards import standing_dashboard
from verifold.society.measures import naming, newest_measure, reruns_of
from verifold.society.standing import standing


def measure_view(board: Board, entry: Posted) -> MeasureView:
    """Return one measure as the person's app shows it, with who reran it."""
    post = entry.post
    if not isinstance(post, Measure):
        raise TypeError(f'Post {post.id} is no measure.')
    held, failed = reruns_of(board, post.id)
    return MeasureView(
        post=post.id,
        thread=post.thread,
        by=post.author,
        label=post.label,
        value=post.value,
        unit=post.unit,
        as_of=post.as_of,
        rerun_by=held,
        rerun_failed_by=failed,
        standing=standing(board, post.id),
    )


def headline_view(board: Board) -> HeadlineView | None:
    """Return the lab's headline number with its newest measure, or `None` while nobody named one."""
    named = naming(board)
    if named is None or not isinstance(named.post, HeadlineNumber) or not named.post.label:
        return None
    newest = newest_measure(board, named.post.label)
    return HeadlineView(
        label=named.post.label,
        post=named.post.id,
        named_by=named.post.author,
        named_at=named.at,
        why=named.post.why or '',
        measure=measure_view(board, newest) if newest else None,
    )


def dashboard_meta(board: Board) -> DashboardMeta | None:
    """Return the version of the dashboard that stands, or `None` while the lab has none."""
    entry = standing_dashboard(board)
    if entry is None or not isinstance(entry.post, Dashboard):
        return None
    return DashboardMeta(
        post=entry.post.id,
        thread=entry.post.thread,
        path=entry.post.evidence[0].path,
        by=entry.post.author,
        at=entry.at,
        size=entry.post.size,
        standing=standing(board, entry.post.id),
        versions=sum(isinstance(other.post, Dashboard) for other in board.thread_posts(entry.post.thread)),
    )


def measure_labels(board: Board) -> tuple[str, ...]:
    """Return the labels that the lab's measures have, each once by how it reads, in the order that they came."""
    labels: dict[str, str] = {}
    for entry in board.posts:
        if isinstance(entry.post, Measure):
            labels.setdefault(entry.post.label.casefold(), entry.post.label)
    return tuple(labels.values())
