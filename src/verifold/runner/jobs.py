"""
The processes that agents start on their own, such as a script that runs in the background.

A harness can start a command in a new process group or session, and a command in the background outlives the shell
that started it. Stopping the harness's process group misses such a process. So every harness gets the lab's marks in
its environment (`harness_environment`), every process that it starts inherits them, and a sweep finds and stops the
marked processes when the lab stops and when it starts again.
"""

import os
from contextlib import suppress
from pathlib import Path

import psutil

from verifold.protocol.record import Record
from verifold.runner.environment import AGENT_VARIABLE, LAB_VARIABLE
from verifold.runner.folders import agents_folder

JOB_GRACE = 5.0
"""Seconds that a process gets to exit after SIGTERM, before a sweep kills it."""

COMMAND_LENGTH = 120
"""The longest command line that a `Job` keeps, in characters."""


class Job(Record):
    """A process that a sweep found, as the person sees it."""

    pid: int
    agent: str | None
    """The agent that the process belongs to, from its mark or from the agent folder that it runs in."""
    command: str


class Sweep(Record):
    """What a sweep stopped, what survived it, and the unmarked processes in agents' folders that it left alone."""

    stopped: tuple[Job, ...] = ()
    survived: tuple[Job, ...] = ()
    unmarked: tuple[Job, ...] = ()
    """Processes that run in an agent's folder without the lab's mark, such as a shell that the person opened there."""
    earlier_run: bool = False
    """Whether the sweep ran at the start, so its processes came from an earlier run, such as one that crashed."""


def sweep(lab: Path, grace: float = JOB_GRACE) -> Sweep:
    """
    Stop every process that carries the lab's mark, and list the unmarked processes that run in an agent's folder.

    Each marked process gets SIGTERM and then SIGCONT, so that a paused process can exit too. The ones that still run
    after `grace` seconds get SIGKILL. Call it only while this process holds the lab's record, so that no other
    server's agents can carry the same mark. It blocks, so async code calls it in a thread.
    """
    marked, unmarked = _lab_processes(lab)
    for process, _ in marked:
        with suppress(psutil.Error):
            process.terminate()
            process.resume()
    running = _running_after([process for process, _ in marked], grace)
    for process in running:
        with suppress(psutil.Error):
            process.kill()
    survived = set(_running_after(running, grace))
    return Sweep(
        stopped=tuple(job for process, job in marked if process not in survived),
        survived=tuple(job for process, job in marked if process in survived),
        unmarked=tuple(job for _, job in unmarked),
    )


def _lab_processes(lab: Path) -> tuple[list[tuple[psutil.Process, Job]], list[tuple[psutil.Process, Job]]]:
    # A process reports its working folder with symbolic links resolved.
    agents = agents_folder(lab).resolve()
    marked: list[tuple[psutil.Process, Job]] = []
    unmarked: list[tuple[psutil.Process, Job]] = []
    for process in psutil.process_iter():
        if process.pid == os.getpid():
            continue
        # Other people's processes refuse to show their environment, and a process can end while the sweep looks.
        with suppress(psutil.Error):
            environment = process.environ()
            if environment.get(LAB_VARIABLE) == str(lab):
                marked.append((process, _job(process, environment.get(AGENT_VARIABLE))))
            elif (folder := Path(process.cwd())).is_relative_to(agents) and folder != agents:
                unmarked.append((process, _job(process, folder.relative_to(agents).parts[0])))
    return marked, unmarked


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
