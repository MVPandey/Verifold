"""
The processes that agents start on their own, such as a script that runs in the background.

A harness can start a command in a new process group or session, and a command in the background outlives the shell
that started it. Stopping the harness's process group misses such a process. So every harness gets the lab's marks in
its environment (`harness_environment`), the processes that it starts inherit them, and a sweep stops the lab's
processes when the lab stops and when it starts again.

A process whose environment shows nothing also counts as the lab's when it runs in an agent's folder without a
terminal. macOS hides the environment of its own programs, such as `sleep` and `zsh`, and a program can clear its
environment. A shell that the person opens in an agent's folder has a terminal, so it keeps running.

A sweep doesn't find a process that clears its environment and works outside the agents' folders. Nor does it find a
process that something outside the lab starts for an agent, such as Docker.
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
    """What a sweep stopped, what survived it, and the processes in agents' folders that it left alone."""

    stopped: tuple[Job, ...] = ()
    survived: tuple[Job, ...] = ()
    unmarked: tuple[Job, ...] = ()
    """Processes in an agent's folder that may not be the lab's, such as a shell that the person opened there."""
    earlier_run: bool = False
    """Whether the sweep ran at the start, so its processes came from an earlier run, such as one that crashed."""


def sweep(lab: Path, grace: float = JOB_GRACE) -> Sweep:
    """
    Stop every process of the lab, and list the processes in agents' folders that may not be the lab's.

    Each process gets SIGTERM and then SIGCONT, so that a paused process can exit too. The ones that still run after
    `grace` seconds get SIGKILL. A stopping process can start new ones, so the sweep looks again, up to `SWEEP_PASSES`
    times in all. Call it only while this process holds the lab's record, so that no other server's agents can carry
    the same mark. It blocks, so async code calls it in a thread.
    """
    stopped: list[Job] = []
    survived: dict[int, Job] = {}
    unmarked: list[Job] = []
    for _ in range(SWEEP_PASSES):
        found, left = _lab_processes(lab)
        unmarked = [job for _, job in left]
        new = [(process, job) for process, job in found if job.pid not in survived]
        if not new:
            break
        alive = _stop([process for process, _ in new], grace)
        for process, job in new:
            if process in alive:
                survived[job.pid] = job
            else:
                stopped.append(job)
    return Sweep(stopped=tuple(stopped), survived=tuple(survived.values()), unmarked=tuple(unmarked))


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
    return set(_running_after(running, grace))


def _lab_processes(lab: Path) -> tuple[list[tuple[psutil.Process, Job]], list[tuple[psutil.Process, Job]]]:
    # A process reports its working folder with symbolic links resolved.
    agents = agents_folder(lab).resolve()
    found: list[tuple[psutil.Process, Job]] = []
    unmarked: list[tuple[psutil.Process, Job]] = []
    for process in psutil.process_iter():
        if process.pid == os.getpid():
            continue
        # Other people's processes refuse to show their environment, and a process can end while the sweep looks.
        with suppress(psutil.Error):
            environment = process.environ()
            if environment.get(LAB_VARIABLE) == str(lab):
                found.append((process, _job(process, environment.get(AGENT_VARIABLE))))
            elif agent := _agent_of_folder(process, agents):
                hidden = not environment and process.terminal() is None
                (found if hidden else unmarked).append((process, _job(process, agent)))
    return found, unmarked


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
