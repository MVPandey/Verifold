import asyncio
import os
import sys
from pathlib import Path

from verifold.runner.processes import start, stop

STUBBORN = (
    sys.executable,
    '-c',
    'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)',
)
"""A process that ignores both the end of its input and SIGTERM, so only SIGKILL stops it."""


async def test_a_cancelled_stop_still_kills_the_group(tmp_path: Path) -> None:
    with (tmp_path / 'errors.log').open('wb') as errors:
        process = await start(STUBBORN, tmp_path, errors, dict(os.environ))
    stopping = asyncio.create_task(stop(process))
    await asyncio.sleep(0.3)

    stopping.cancel()
    await asyncio.gather(stopping, return_exceptions=True)

    async with asyncio.timeout(5):
        # The killed process ends, and collecting it leaves no zombie for later tests to trip over.
        await process.wait()
