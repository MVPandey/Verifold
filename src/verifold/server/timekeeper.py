"""
Keeps the lab's time: its end, and the end of each round.

When the lab reaches its end, the record says so, and the agents' turns stop. When a round's time comes, the record
says that it closed.
"""

from contextlib import suppress

from verifold.server.lab import Lab
from verifold.society.errors import RejectedEvent
from verifold.society.rounds import close_due, closes_at, open_round


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


async def keep_rounds(lab: Lab) -> None:
    """
    Record the close of a round when its time comes, also while the lab is out of time. Run it while the lab runs.

    A round whose time passed while Verifold was stopped closes at the first look. A round that closes for another
    reason closes in the step of the event that ends it.
    """
    while True:
        board, now = lab.board, lab.now()
        if close_due(board, now):
            await lab.close_rounds()
            continue
        opened = open_round(board, now)
        await lab.wait_for_change(board.seq, (closes_at(opened) - now).total_seconds() if opened else None)
