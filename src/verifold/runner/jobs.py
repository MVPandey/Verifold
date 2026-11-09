"""
The processes that agents start on their own, such as a script that runs in the background.

A harness can start a command in a new process group or session, and a command in the background outlives the shell
that started it. Stopping the harness's process group misses such a process. So every harness gets the lab's marks in
its environment (`harness_environment`), the processes that it starts inherit them, and a sweep stops the lab's
processes when the lab stops and when it starts again.

A process whose environment shows nothing also counts as the lab's when it runs in an agent's folder without a
terminal. macOS hides the environment of its own programs, such as `sleep` and `zsh`, and a program can clear its
environment. A shell that the person opens in an agent's folder has a terminal, so it keeps running.

A sweep doesn't find a process outside the agents' folders whose environment shows nothing, either because it cleared
its environment or because it is one of macOS's own programs. Nor does it find a process that something outside the
lab starts for an agent, such as Docker.
"""

import asyncio
import os
import time
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path

import psutil

from verifold.protocol.record import Record
from verifold.protocol.settings import AtTimeLimit
from verifold.runner.environment import AGENT_VARIABLE, LAB_VARIABLE
from verifold.runner.folders import agents_folder
from verifold.server.lab import Lab

JOB_GRACE = 5.0
"""Seconds that the lab's processes get to exit after SIGTERM, before a sweep kills them."""

KILL_WAIT = 1.0
"""Seconds that a sweep waits for the processes that it killed to end."""

SWEEP_PASSES = 3
"""How often a sweep looks again, for processes that the stopped ones started while they stopped."""

COMMAND_LENGTH = 120
"""The longest command line that a `Job` keeps, in characters."""


class Job(Record):
    """A process that a sweep found, as the person sees it."""

    pid: int
    agent: str | None
    """The agent that the process belongs to, from its mark or from the agent folder that it runs in."""
    command: str


class Sweep(Record):
    """What a sweep stopped or paused, what survived it, and the processes in agents' folders that it left alone."""

    stopped: tuple[Job, ...] = ()
    paused: tuple[Job, ...] = ()
    """Jobs that the lab's time limit paused. They run again when the person gives the lab more time."""
    survived: tuple[Job, ...] = ()
    unmarked: tuple[Job, ...] = ()
    """Processes in an agent's folder that may not be the lab's, such as a shell that the person opened there."""
    earlier_run: bool = False
    """Whether the sweep ran at the start, so its processes came from an earlier run, such as one that crashed."""


def sweep(
    lab: Path, grace: float = JOB_GRACE, *, spare_harnesses: bool = False, still: Callable[[], bool] = lambda: True
) -> Sweep:
    """
    Stop every process of the lab, and list the processes in agents' folders that may not be the lab's.

    With `spare_harnesses`, it stops only the jobs that agents started, and the harnesses keep running. A pass after
    the first runs only while `still()` holds, so a stop at the time limit leaves alone what agents start once the lab
    has more time.

    Each process gets SIGTERM and then SIGCONT, so that a paused process can exit too. The ones that still run after
    the grace period get SIGKILL. A stopping process can start new ones, so the sweep looks again, up to
    `SWEEP_PASSES` times in all. The passes share one grace period of `grace` seconds, so a sweep takes at most `grace`
    seconds plus `KILL_WAIT` for each pass. Call it only while this process holds the lab's record, so that no other
    server's agents can carry the same mark. It blocks, so async code calls it in a thread.
    """
    deadline = time.monotonic() + grace
    stopped: list[Job] = []
    survived: dict[int, Job] = {}
    unmarked: list[Job] = []
    for number in range(SWEEP_PASSES):
        if number and not still():
            break
        found, left = _lab_processes(lab, _harness_groups() if spare_harnesses else frozenset())
        unmarked = [job for _, job in left]
        new = [(process, job) for process, job in found if job.pid not in survived]
        if not new:
            break
        alive = _stop([process for process, _ in new], max(deadline - time.monotonic(), 0.0))
        for process, job in new:
            if process in alive:
                survived[job.pid] = job
            else:
                stopped.append(job)
    return Sweep(stopped=tuple(stopped), survived=tuple(survived.values()), unmarked=tuple(unmarked))


def pause_jobs(lab: Path) -> Sweep:
    """Pause the jobs that the lab's agents started, and return them. The harnesses keep running."""
    found, _ = _lab_processes(lab, _harness_groups())
    paused: list[Job] = []
    for process, job in found:
        with suppress(psutil.Error):
            process.suspend()
            paused.append(job)
    return Sweep(paused=tuple(paused))


def resume_jobs(lab: Path) -> None:
    """Resume the jobs that the lab's agents started. A job that runs already doesn't notice."""
    found, _ = _lab_processes(lab, _harness_groups())
    for process, _ in found:
        with suppress(psutil.Error):
            process.resume()


async def keep_jobs(lab: Lab, project: Path, report: Callable[[Sweep], None]) -> None:
    """
    Apply the lab's job setting when the lab runs out of time, and resume paused jobs when it gets more time.

    The person's Stop also ends the lab's time. The harnesses keep running, so that the agents can be woken when the
    lab gets more time. A change to the setting while the lab is out of time applies at once. `report` gets what each
    pause or stop did. Run it for as long as the lab runs.
    """
    out_of_time: bool | None = None
    applied: AtTimeLimit | None = None
    """The setting that the lab's current time-out applied, or `None` while the lab has time."""
    while True:
        board = lab.board
        setting = board.settings.jobs.at_time_limit
        if board.out_of_time and (out_of_time is not True or setting != applied):
            await _time_out(lab, project, report, setting, applied)
            applied = setting
        elif not board.out_of_time and out_of_time is not False:
            # Only `pause` pauses, so only a pause resumes. A job that someone else paused stays paused. A new run
            # under `pause` resumes what an earlier run paused and kept.
            if applied is AtTimeLimit.PAUSE or (out_of_time is None and setting is AtTimeLimit.PAUSE):
                await asyncio.to_thread(resume_jobs, project)
            applied = None
        out_of_time = board.out_of_time
        await lab.wait_for_change(board.seq)


async def _time_out(
    lab: Lab, project: Path, report: Callable[[Sweep], None], setting: AtTimeLimit, applied: AtTimeLimit | None
) -> None:
    # Apply `setting` to the jobs of a lab that is out of time. `applied` is what the time-out applied before, if
    # the person changed the setting since.
    match setting:
        case AtTimeLimit.PAUSE:
            report(await asyncio.to_thread(pause_jobs, project))
        case AtTimeLimit.STOP:
            report(await asyncio.to_thread(sweep, project, spare_harnesses=True, still=lambda: lab.board.out_of_time))
        case AtTimeLimit.FINISH if applied is AtTimeLimit.PAUSE:
            # The jobs that this time-out paused run on until they end.
            await asyncio.to_thread(resume_jobs, project)


def _stop(processes: list[psutil.Process], grace: float) -> set[psutil.Process]:
    """Stop `processes`, and return the ones that still run."""
    for process in processes:
        with suppress(psutil.Error):
            process.terminate()
            process.resume()
    running = _running_after(processes, grace)
    for process in running:
        with suppress(psutil.Error):
            process.kill()
    return set(_running_after(running, KILL_WAIT))


def _lab_processes(
    lab: Path, spared: frozenset[int] = frozenset()
) -> tuple[list[tuple[psutil.Process, Job]], list[tuple[psutil.Process, Job]]]:
    # A process reports its working folder with symbolic links resolved.
    agents = agents_folder(lab).resolve()
    found: list[tuple[psutil.Process, Job]] = []
    unmarked: list[tuple[psutil.Process, Job]] = []
    for process in psutil.process_iter():
        if process.pid == os.getpid():
            continue
        # Other people's processes refuse to show their environment, and a process can end while the sweep looks.
        with suppress(psutil.Error, OSError):
            if os.getpgid(process.pid) in spared:
                continue
            environment = process.environ()
            if environment.get(LAB_VARIABLE) == str(lab):
                found.append((process, _job(process, environment.get(AGENT_VARIABLE))))
            elif agent := _agent_of_folder(process, agents):
                hidden = not environment and process.terminal() is None
                (found if hidden else unmarked).append((process, _job(process, agent)))
    return found, unmarked


def _harness_groups() -> frozenset[int]:
    # Each harness leads a process group of its own, which this server started. So the IDs of those groups are the
    # IDs of this server's children.
    return frozenset(child.pid for child in psutil.Process().children())


def _agent_of_folder(process: psutil.Process, agents: Path) -> str | None:
    folder = Path(process.cwd())
    if folder == agents or not folder.is_relative_to(agents):
        return None
    return folder.relative_to(agents).parts[0]


def _job(process: psutil.Process, agent: str | None) -> Job:
    command = ' '.join(process.cmdline()) or process.name()
    if len(command) > COMMAND_LENGTH:
        command = command[: COMMAND_LENGTH - 1] + '…'
    return Job(pid=process.pid, agent=agent, command=command)


def _running_after(processes: list[psutil.Process], seconds: float) -> list[psutil.Process]:
    _, running = psutil.wait_procs(processes, timeout=seconds)
    return [process for process in running if _alive(process)]


def _alive(process: psutil.Process) -> bool:
    # A zombie has ended. It stays in the process table only until its parent collects it.
    try:
        return process.status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        return False
