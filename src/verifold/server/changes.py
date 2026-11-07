"""Waiting for a change in state that an `asyncio.Condition` guards."""

import asyncio
from collections.abc import Callable
from contextlib import suppress


async def wait_until(changed: asyncio.Condition, ready: Callable[[], bool], timeout: float | None) -> None:
    """Return once `ready()` is true, or after `timeout` seconds. A `timeout` of `None` waits for as long as it takes."""
    async with changed:
        with suppress(TimeoutError):
            async with asyncio.timeout(timeout):
                await changed.wait_for(ready)
