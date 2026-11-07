"""Keeps the lab's time: when the lab reaches its end, the record says so, and the agents' turns stop."""

from contextlib import suppress

from verifold.server.lab import Lab
from verifold.society.errors import RejectedEvent


async def keep_time(lab: Lab) -> None:
    """Record that the lab ran out of time whenever it reaches its end. Run it for as long as the lab runs."""
    while True:
        board = lab.board
        ends_at = None if board.out_of_time else board.ends_at
        left = (ends_at - lab.now()).total_seconds() if ends_at else None
        if left is None or left > 0:
            await lab.wait_for_change(board.seq, left)
            continue
        # The person can set a new end while this waits for the lab's lock. The lab then refuses the event.
        with suppress(RejectedEvent):
            await lab.run_out_of_time()
