"""
Leases: how long one agent holds a thing of the board that only one agent at a time may hold.

A wanted rerun and a task each have a holder with a lease. The steps of one agent on such a thing, in the order of the
record, decide its lease. A step that starts a lease starts one at its time, also after an earlier lease ended. A step
that keeps a lease starts it again only while it stands, so it never starts one by itself. A step that ends a lease
ends it. Each lease lasts for the minutes that the lab's settings held at the event that started or kept it. So a later
change of the setting leaves a lease as it was.
"""

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

type Hold = Literal['start', 'keep', 'end']
"""What a step does to a lease: start one, start it again while it stands, or end it."""

type Step = tuple[int, datetime, Hold]
"""One step of an agent: the event's sequence number, its time, and what it does to the lease."""


@dataclass(frozen=True, slots=True)
class Span:
    """A lease that steps started and that no step ended: the event that started it, since when, and until when."""

    started: int
    since: datetime
    until: datetime

    def stands(self, now: datetime) -> bool:
        """Return whether the lease stands at `now`: its time has not come."""
        return now < self.until


def span(steps: Iterable[Step], now: datetime, minutes: Callable[[int], int]) -> Span | None:
    """
    Return the newest lease that `steps` started by `now` and that no later step ended, or `None`.

    The lease can have ended at its time already: `Span.stands` says whether it stands. `minutes` gives the length of
    a lease from the event that starts or keeps it. A step dated after `now`, as from a clock that jumped, counts for
    nothing.
    """
    started: int | None = None
    since = until = None
    for seq, at, hold in steps:
        if at > now:
            continue
        if hold == 'end':
            started = since = until = None
            continue
        standing = since is not None and until is not None and at < until
        if hold == 'keep' and not standing:
            continue
        if not standing:
            started, since = seq, at
        until = at + timedelta(minutes=minutes(seq))
    return Span(started=started, since=since, until=until) if started and since and until else None
