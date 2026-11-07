"""Keeps the lab's time: when the lab reaches its end, the record says so, and the agents' turns stop."""

from contextlib import suppress

from verifold.server.lab import Lab
from verifold.society.errors import RejectedEvent

IDLE_WAIT = 3_600.0
"""Seconds of each wait while the lab has no time limit, or is out of time already."""


async def keep_time(lab: Lab) -> None:
    """Record that the lab ran out of time each time that it reaches its end. Run it for as long as the lab runs."""
    while True:
        board = lab.board
        ends_at = None if board.out_of_time else board.ends_at
        left = (ends_at - lab.now()).total_seconds() if ends_at else IDLE_WAIT
        if left > 0:
            await lab.wait_for_change(board.seq, left)
            continue
        # The person can set a new end while this waits for the lab's lock. The lab then refuses the event.
        with suppress(RejectedEvent):
            await lab.run_out_of_time()
