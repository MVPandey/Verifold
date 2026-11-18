"""
Supervises one agent.

The agent's harness owns its work. Verifold keeps the agent's ACP session open, rings a doorbell when posts for the
agent arrive after it ended its turn, rings the alarm that the agent set for itself, and starts the harness again
when its process fails. The doorbell waits for a quiet moment on the board, so that a burst of posts wakes the agent
once. A post of the person rings at once.

After Verifold restarts, the loop goes on from the agent's turns in the record. An agent that ended its last turn by
its own choice waits again, with the same doorbell and the same alarm. So does every agent of a closed lab. Any
other agent that worked before gets a message at once, because its turn did not end or the record cannot tell.
"""

import asyncio
import time
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from datetime import datetime, timedelta
from itertools import takewhile
from pathlib import Path

from pydantic import Field, SecretStr

from verifold.harnesses.catalog import HarnessEntry
from verifold.protocol.agents import Agent
from verifold.protocol.app import AgentState, Retry, WaitsFor
from verifold.protocol.events import (
    ERROR_AT_LIMIT,
    ERROR_INTERRUPTED,
    ERROR_OUT_OF_TIME,
    ERROR_RAN_PAST,
    AlarmSet,
    Halt,
    TimeRanOut,
    TurnSummary,
)
from verifold.protocol.ids import PERSON
from verifold.protocol.record import Record
from verifold.protocol.settings import AtExit, AtTimeLimit
from verifold.protocol.usage import Usage
from verifold.runner.disk import DiskMeter
from verifold.runner.errors import RunnerError
from verifold.runner.messages import (
    AT_LIMIT,
    CLOSED,
    DEPARTURE,
    DOORBELL,
    HARNESS_FAILED,
    IN_TURN,
    OUT_OF_TIME,
    RERUN_WANTED,
    RESTARTED,
    ROUND_CLOSED,
    STARTED_AGAIN,
    alarm_message,
    back_message,
    cut_short_message,
    go_on_facts,
    go_on_message,
)
from verifold.runner.permissions import (
    Refusals,
    ask_the_person,
    ask_the_question,
    declines,
    named,
    refusal,
    settled,
)
from verifold.runner.retry import error_text, provider_limit, reset_at
from verifold.runner.session import (
    AgentSession,
    Answers,
    BoardAccess,
    PermissionRequest,
    Place,
    Question,
    SessionHooks,
    SessionOptions,
)
from verifold.runner.snapshots import snapshot
from verifold.server.activity import Activity
from verifold.server.member import Member
from verifold.society.attention import update, wakes
from verifold.society.board import Board
from verifold.society.budget import LIMIT_NAMES
from verifold.society.desk import interrupted, speaks_for_person
from verifold.society.grants import agent_waits
from verifold.society.lifecycle import lab_state, pending_alarm, rings_at
from verifold.society.reruns import RerunKey, kept_until, told_of
from verifold.society.turns import before


class LoopSettings(Record):
    """How Verifold supervises the lab's agents."""

    mcp_url: str
    turn_timeout: float = Field(default=2 * 3_600, gt=0)
    """Seconds that one turn may run before Verifold cancels it."""
    max_failures: int = Field(default=3, ge=1)
    """How many harness failures in a row stop the agent."""
    retry_after: float = Field(default=30, ge=0)
    """Seconds before the first restart of a failed harness. Each later restart waits twice as long."""
    max_retry_after: float = Field(default=3_600, ge=0)
    """
    The most seconds that a restart waits as the waits double. A reset time that the error of a provider's limit
    names can be later, and the restart waits for it.
    """
    quiet: float = Field(default=10, ge=0)
    """
    Seconds without a new event on the board before a doorbell rings, so that one doorbell covers a burst. A post
    of the person rings without this wait.
    """
    max_quiet: float = Field(default=45, ge=0)
    """The most seconds that a doorbell waits for the board to go quiet."""
    leave_grace: float = Field(default=5, ge=0)
    """Seconds that an agent that left the lab gets to end its turn by itself, before Verifold cancels the turn."""


class AgentSetup(Record):
    """One agent, its harness, its folder, its token, and the facts that it starts with."""

    agent: Agent
    harness: HarnessEntry
    lab: Path
    """
    The folder of the project that holds the lab. It marks every process of the agent's harness, and Verifold
    commits the agent's folder in the lab there after each turn.
    """
    folder: Path
    log: Path
    """The file that receives the harness's error output."""
    token: SecretStr
    options: SessionOptions = SessionOptions()
    start: str
    """The facts that an agent gets when it starts. An agent that comes back gets them with a new conversation only."""


@dataclass(frozen=True, slots=True)
class Shared:
    """What the agent loops of one lab share."""

    activity: Activity | None = None
    """Receives what each agent is doing now, for the person's view."""
    refusals: Refusals | None = None
    """Keeps the asks of the requests that Verifold refuses at once, when the person chose that no agent waits."""
    disk: DiskMeter | None = None
    """Measures the lab's files at the end of each turn, so that the lab knows its disk use."""


class AgentLoop:
    """
    Keeps one agent's ACP session open until the agent fails `max_failures` times in a row or the lab stops.

    A failure whose error says that the provider limits the harness does not stop the agent. Its restart waits for
    the reset time that the error names, or as long as a failure of another kind does.

    The record keeps the start and the end of each turn, with the harness's session ID and what the agent had seen.
    So a loop that starts after a restart of Verifold loads the agent's conversation again, when the harness can.

    The loop also ends when the agent leaves the lab. Verifold cancels the turn at once when the person removed
    the agent, and after `leave_grace` seconds when the agent left by itself and its turn runs on.
    """

    def __init__(
        self,
        member: Member,
        setup: AgentSetup,
        settings: LoopSettings,
        shared: Shared | None = None,
    ) -> None:
        """
        Prepare to supervise an agent that joined the lab.

        `member` is the same seat that serves the agent's tool calls, so a doorbell never repeats what the agent read
        with `wait`. `shared` holds what the lab's loops share.
        """
        shared = shared or Shared()
        self._refusals = shared.refusals
        self._disk = shared.disk
        self._turn_over = asyncio.Event()
        """Set while the agent has no turn. A request of the harness that waits for the person ends with the turn."""
        self._turn_over.set()
        self._asking = 0
        """How many requests of the harness wait for the person now."""
        self._activity = shared.activity
        self._member = member
        self._lab = member.lab
        self._setup = setup
        self._settings = settings
        board = self._lab.board
        self._before = before(board, setup.agent.id)
        """Where the agent was, from its turns in the record. A new agent has none."""
        was, rested = self._before, self._before.rested
        self._rests = was.worked and not was.stopped and (rested is not None or lab_state(board) == 'closed')
        """
        Whether the agent waits when its harness starts, and gets no message. An agent that ended its last turn by
        its own choice does, and so does every agent of a closed lab. An agent that the person starts again does not.
        """
        # An agent that waits again gets a doorbell for every post for it that it has not read. One of them can
        # have rung before Verifold stopped: a doorbell that rings twice is better than one that never rings.
        self._notified = member.seen if self._rests else board.seq
        self._rung: frozenset[RerunKey] = frozenset()
        """
        The wanted reruns that a doorbell of this loop rang for. With the reruns that the seat told the agent of,
        they ring no doorbell again. A loop starts with none, so after a restart a rerun can ring a second time.
        """
        self._seen_at_turn = member.seen
        """What the agent had seen when its turn started. A failed turn takes the agent back to it."""
        self._in_turn = False
        """Whether a turn of the agent runs: its start is in the record, and its end is not."""
        self._turn_ended = was.ended if rested else board.seq
        """The board's sequence number when the agent's last turn ended. A stop after it concerns the agent's jobs."""
        self._rang: int | None = None
        """The sequence number of the alarm that rings with the agent's next message, or `None`."""
        self._woke = ''
        """The message that carries that ring, until its turn ends. A harness that fails before gets it again."""
        self._cut_short = ''
        """Why the agent's last turn ended without the agent's choice, or empty when the agent ended it."""
        self._interrupted = False
        """Whether the desk ended the agent's last turn, so that the agent goes on also after a cut in a row."""

    async def run(self) -> None:
        """Run the agent until it fails too often, or until the caller cancels the loop."""
        try:
            await self._run()
        finally:
            await self._report('stopped')

    async def _run(self) -> None:
        setup = self._setup
        hooks = SessionHooks(permissions=self._permission, step=self._step, questions=self._question)
        board = BoardAccess(url=self._settings.mcp_url, token=setup.token)
        was = self._before
        resume = was.session
        message, failures, resumed = setup.start, 0, False
        # What the agent's next message says first, while the agent comes back from a restart or a stop.
        back = STARTED_AGAIN if was.stopped else RESTARTED if was.worked else None
        worked, rests = back is not None, self._rests
        # Under this setting, a stop of Verifold also stops the processes that the agents left running.
        jobs_stopped = back is RESTARTED and self._lab.board.settings.jobs.at_exit is AtExit.STOP
        # The person can remove the agent while a failed harness waits for its restart. No harness starts for an
        # agent that left.
        while not self._left():
            opened = loaded = False
            try:
                options = setup.options.model_copy(update={'resume': resume})
                place = Place(folder=setup.folder, log=setup.log, lab=setup.lab, agent=setup.agent.id)
                async with AgentSession.open(setup.harness, place, board, options, hooks) as session:
                    opened, loaded, resume = True, session.loaded, session.id
                    if back or (worked and not loaded):
                        message = back_message(
                            back or HARNESS_FAILED,
                            setup.start,
                            setup.folder,
                            kept=loaded,
                            cut_off=bool(back) and was.cut_off,
                            jobs_stopped=jobs_stopped,
                        )
                    if rests:
                        # The agent ended its last turn itself, so the restart starts no turn. What wakes the agent
                        # next carries the news of the restart. A harness that loads a session can report old steps.
                        await self._report('idle')
                        message, rests = f'{message}\n\n{await self._news()}', False
                    while True:
                        if (halt := await self._while_halted()) and back:
                            # The agent comes back to a lab that was out of time or at a limit, so it gets the lab's
                            # new end or limit. The message says already what a stop of Verifold did to the agent's
                            # processes.
                            jobs = AtTimeLimit.FINISH if jobs_stopped else self._lab.board.settings.jobs.at_time_limit
                            message = f'{message}\n\n{go_on_facts(halt, self._lab.board, jobs)}'
                        # An agent that left gets no other turn. Leaving this block ends its harness.
                        if self._left():
                            return
                        # From here the agent has a conversation, which a harness that fails can lose.
                        worked = True
                        stopped = await self._send(session, message)
                        failures, back = 0, None
                        message, resumed = await self._following(stopped=stopped, resumed=resumed)
            # Any failure of one harness restarts that harness. It must not stop the lab's other agents.
            except Exception as error:
                # While the lab stops, the harness's cleanup can fail too. That error ends the agent and restarts nothing.
                if (task := asyncio.current_task()) and task.cancelling():
                    raise asyncio.CancelledError from error
                if self._left() and not self._in_turn:
                    # The agent left the lab and its last turn has its end in the record. Its harness can fail on
                    # the way out, and that is no failure of a turn and starts nothing again.
                    return
                failures += 1
                said = error_text(error)
                limited = provider_limit(said)
                in_turn, ends = await self._failed(said, failures, limited=limited)
                if ends:
                    return
                await self._back_off(said, failures, limited=limited)
                if not limited and (
                    (in_turn and loaded) or (not opened and failures == self._settings.max_failures - 1)
                ):
                    # The conversation can be what makes the harness fail: a turn failed in one that the harness
                    # loaded, or the harness fails before its last start. The next start opens a new one.
                    resume = None
                message = DOORBELL if resume else setup.start
                # When the record says already that the agent's alarm rang, the agent must still hear it.
                woke = self._woke if resume else f'{message}\n\n{self._woke}'
                message = woke if self._woke else message

    async def _failed(self, error: str, failures: int, *, limited: bool) -> tuple[bool, bool]:
        # Record that the harness failed, for the `failures`-th time in a row. Return whether it failed in a turn,
        # and whether the loop ends: Verifold stops the agent, or the agent left. A provider's limit stops nobody.
        in_turn, self._in_turn = self._in_turn, False
        if in_turn:
            # The failed turn can have lost the tool results that carried its news.
            self._member.rewind(self._seen_at_turn)
        stops = failures >= self._settings.max_failures and not limited
        failed = TurnSummary(
            agent=self._setup.agent.id,
            seconds=0,
            usage=Usage(),
            error=error,
            seen=self._member.seen,
            stopped=stops,
            # A harness that fails when it starts ends no turn. So the agent's place in the record stays as it is.
            no_turn=not in_turn,
        )
        await self._lab.end_turn(failed)
        return in_turn, stops or self._left()

    async def _following(self, *, stopped: Halt | None, resumed: bool) -> tuple[str, bool]:
        # Wait for what starts the agent's next turn. Return its message, and whether that turn resumes one that
        # was cut short. `stopped` says that the turn stopped because the lab ran out of time or reached a limit.
        if stopped:
            await self._while_halted()
            current = self._lab.board
            return go_on_message(stopped, current, current.settings.jobs.at_time_limit), resumed
        if self._cut_short and (not resumed or self._interrupted):
            # The agent did not choose to stop, so no post may be on its way. It goes on once. A second cut in a
            # row waits for a post, so a turn that always fails does not repeat. A turn that the desk ended goes
            # on whatever came before, because the person's word wants the agent's next turn now.
            self._interrupted = False
            return cut_short_message(self._cut_short), True
        return await self._news(), False

    async def _send(self, session: AgentSession, message: str) -> Halt | None:
        # Return why the turn stopped when it stopped because the lab ran out of time or reached a limit.
        await self._report('working')
        started = time.monotonic()
        self._seen_at_turn = self._member.seen
        # The mark comes before the message. A turn with a mark and no end did not end.
        rang, self._rang = self._rang, None
        model = session.model
        if model:
            # A name that says "default model" names the model that the harness reported, from the first turn on.
            await self._lab.name_by_model(self._setup.agent.id, self._setup.harness.title, model.name)
        turn = await self._lab.start_turn(
            self._setup.agent.id,
            session.id,
            self._seen_at_turn,
            rang,
            model=model.value if model else None,
            model_name=model.name if model else None,
        )
        self._in_turn = True
        try:
            async with asyncio.timeout(self._settings.turn_timeout) as limit:
                stopper = asyncio.create_task(self._stop_when_halted(limit, turn.seq))
                self._turn_over.clear()
                try:
                    result = await session.send(message)
                finally:
                    stopper.cancel()
                    # However the turn ends, a request that still waits for the person ends with it.
                    self._turn_over.set()
        except TimeoutError:
            await session.cancel()
            if left := self._lab.board.gone(self._setup.agent.id):
                # The loop ends next, so nothing resumes this turn.
                remover = f'{left.through}, with a power from the person,' if left.through else 'The person'
                error = (
                    f'{remover} removed the agent, so Verifold cancelled the turn.'
                    if left.by == PERSON
                    else f'The agent left the lab and its turn ran on for {self._settings.leave_grace:g} seconds, '
                    'so Verifold cancelled the turn.'
                )
                await self._record(started, Usage(), session.turn_cost(), error)
                self._cut_short = ''
                return None
            halt = self._halt()
            cut = interrupted(self._lab.board, self._setup.agent.id, turn.seq)
            if halt == 'time':
                error = f'{ERROR_OUT_OF_TIME}, so Verifold cancelled the turn.'
            elif halt:
                error = f'{ERROR_AT_LIMIT} {LIMIT_NAMES[halt]}, so Verifold cancelled the turn.'
            elif cut:
                error = (
                    f'{ERROR_INTERRUPTED}, on post {cut.on} of the person in the desk chat, and Verifold cancelled it.'
                )
            else:
                error = f'{ERROR_RAN_PAST} {self._settings.turn_timeout:g} seconds and was cancelled.'
            await self._record(started, Usage(), session.turn_cost(), error)
            self._cut_short = '' if halt else error
            self._interrupted = bool(cut) and not halt
            if not halt:
                await self._report('idle')
            return halt
        stopped = None if result.stop_reason == 'end_turn' else f'The harness stopped: {result.stop_reason}.'
        self._cut_short = stopped or ''
        await self._record(started, result.usage, result.cost_usd, stopped)
        await self._report('idle')
        return None

    async def _stop_when_halted(self, limit: asyncio.Timeout, started: int) -> None:
        # An agent that leaves the lab stops in the same way. The board refuses it from then on, so its turn can
        # only spend tokens. After its own `leave` it gets a moment to end the turn by itself. A turn that the desk
        # ends for the person after its start, event `started`, stops in the same way too.
        lab, agent_id = self._lab, self._setup.agent.id
        while self._halt() is None and not self._left() and not interrupted(lab.board, agent_id, started):
            await lab.wait_for_change(lab.board.seq)
        left = lab.board.gone(self._setup.agent.id)
        if left and left.by != PERSON:
            await asyncio.sleep(self._settings.leave_grace)
        limit.reschedule(asyncio.get_running_loop().time())

    async def _back_off(self, error: str, failures: int, *, limited: bool) -> None:
        # Wait before a failed harness starts again, and show the wait. It doubles from `retry_after`, up to
        # `max_retry_after`, and a provider's limit waits for the reset time that its error names. The wait ends
        # early when the agent leaves the lab.
        settings, now = self._settings, self._lab.now()
        seconds = min(settings.retry_after * 2 ** min(failures - 1, 32), settings.max_retry_after)
        reset = reset_at(error, now) if limited else None
        seconds = (reset - now).total_seconds() if reset else seconds
        retry = Retry(failures=failures, at=now + timedelta(seconds=seconds), provider_limit=limited)
        await self._report('waiting', '', 'retry', retry)
        with suppress(TimeoutError):
            async with asyncio.timeout(seconds):
                while not self._left():
                    await self._lab.wait_for_change(self._lab.board.seq)
        if not self._left():
            await self._report('starting')

    def _left(self) -> bool:
        return self._lab.board.gone(self._setup.agent.id) is not None

    def _halt(self) -> Halt | None:
        # Why the lab rests this agent now: its time ran out, or it reached a limit. The halt rests no desk, because
        # only a post of the person in the desk chat starts a turn of the desk, and the person can ask the desk where
        # the lab stands or tell it to give the lab more. The desk's turns count toward what the lab spent.
        board = self._lab.board
        return None if board.is_desk(self._setup.agent.id) else board.halted

    async def _while_halted(self) -> Halt | None:
        # Wait while the lab is out of time or at a limit. Return why the lab was, or `None` when it was not.
        lab = self._lab
        halt = self._halt()
        if halt is None or self._left():
            return None
        if halt == 'time':
            await self._report('waiting', 'The lab is out of time. The person can give it more.', 'time')
        else:
            await self._report('waiting', f'The lab reached its {LIMIT_NAMES[halt]}. The person can raise it.', 'limit')
        while self._halt() is not None and not self._left():
            await lab.wait_for_change(lab.board.seq)
        return halt

    async def _record(self, started: float, usage: Usage, cost_usd: float | None, error: str | None) -> None:
        # Mark the end of the turn before the snapshot, which can take seconds in a large folder.
        self._turn_ended, self._in_turn, self._woke = self._lab.board.seq, False, ''
        agent_id = self._setup.agent.id
        try:
            commit = await snapshot(self._setup.lab, agent_id)
        except RunnerError:
            commit = None
        seconds = time.monotonic() - started
        await self._lab.end_turn(
            TurnSummary(
                agent=agent_id,
                seconds=seconds,
                usage=usage,
                cost_usd=cost_usd,
                error=error,
                snapshot=commit,
                seen=self._member.seen,
            )
        )
        if self._disk:
            # A folder that cannot be read counts as nothing, so a measure fails only when the lab's folder went.
            with suppress(OSError):
                await self._disk.measure(agent_id)

    def _jobs_stopped(self, board: Board) -> Halt | None:
        # Why the lab stopped the agent's processes after its last turn, when the time limit or another limit did.
        # The record shows a stop also when the lab went on before this look. A halt rests no desk, so the lab's
        # going on wakes no desk either.
        if board.settings.jobs.at_time_limit is not AtTimeLimit.STOP or board.is_desk(self._setup.agent.id):
            return None
        times = (entry.seq for entry in board.times if isinstance(entry, TimeRanOut) and entry.seq > self._turn_ended)
        limits = ((entry.seq, entry.limit) for entry in board.limits if entry.seq > self._turn_ended)
        stops: tuple[tuple[int, Halt], ...] = (*((seq, 'time') for seq in times), *limits)
        return max(stops)[1] if stops else None

    async def _news(self) -> str:
        """
        Wait for posts for the agent, and return the message that wakes it.

        Under `stop`, the time limit also ends the processes of an agent that waits here. That agent wakes when the
        lab gets more time, and its message says so, followed by the doorbell when posts came meanwhile.

        The agent's alarm rings here at its time. An alarm whose time came earlier, while a turn of the agent ran
        or while the lab was out of time or closed, rings at once, and its message says so. It rings once: a
        doorbell that rings when the alarm is due carries it.
        """
        agent_id = self._setup.agent.id
        # An agent that read one page of its posts in its turn gets a doorbell for the rest. An agent that read
        # nothing gets no second doorbell for the same posts.
        if self._member.seen > self._seen_at_turn:
            self._notified = min(self._notified, self._member.seen)
        settled, held, late = False, '', ''
        while True:
            board = self._lab.board
            # No message wakes an agent that left. The loop ends before it sends this one.
            if board.gone(agent_id):
                return ''
            stopped = self._jobs_stopped(board)
            now = self._lab.now()
            told = self._member.told | self._rung
            news = update(board, agent_id, max(self._notified, self._member.seen), now, told)
            # An agent that this agent wrote to and that left wakes it as a post does: no answer comes from it.
            # Like the alarm, that does not wake an agent in a closed lab, where agents leave because it is done.
            # A rerun that this agent can take wakes it once, as a call does. The close of a round that concerns the
            # agent wakes it as a post for it does. Like the alarm, neither does in a lab that is out of time or
            # closed: the next news carries them, and a rerun rings when the lab has time or is open again.
            resting = board.halted is not None or lab_state(board) == 'closed'
            reruns = () if resting else news.reruns
            rounds = () if resting else news.rounds
            posts = bool(news.posts or rounds or reruns or (news.left and lab_state(board) != 'closed'))
            # The agent's own alarm. It does not ring in a lab that is out of time or closed.
            alarm = pending_alarm(board, agent_id)
            left = None
            if alarm:
                rings, closed = rings_at(board, alarm), lab_state(board) == 'closed'
                ahead = (rings - now).total_seconds()
                if board.halted or closed:
                    held = CLOSED if closed else OUT_OF_TIME if board.halted == 'time' else AT_LIMIT
                else:
                    left = ahead
                    # An alarm that is due at the first look after the lab had no time or was closed is late for
                    # that reason.
                    held = held if left <= 0 else ''
                    late = IN_TURN if self._rings_in_turn(board, rings) else held
            due = alarm if alarm and left is not None and left <= 0 else None
            # A post during a stop waits for the wake after more time, so the doorbell rings then.
            if stopped and board.halted is None:
                if posts:
                    self._notified, self._rung = board.seq, self._rung | told_of(board, reruns)
                message = go_on_message(stopped, board, AtTimeLimit.STOP)
                return self._ring(f'{message} {DOORBELL}' if posts else message, due, late)
            if posts and not stopped:
                # The person does not wait for a quiet board, also when the post is for every agent.
                if not settled and not self._person_wrote():
                    await self._settle()
                    settled = True
                    continue
                self._notified, self._rung = board.seq, self._rung | told_of(board, reruns)
                bell = DOORBELL if news.posts else ROUND_CLOSED if rounds else RERUN_WANTED if reruns else DEPARTURE
                return self._ring(bell, due, late)
            if due:
                return self._ring('', due, late)
            # A rerun that only a lease keeps from the agent comes free at the lease's end, which is no event.
            free = None if resting else kept_until(board, agent_id, now, told)
            frees = None if free is None else (free - now).total_seconds()
            await self._lab.wait_for_change(
                board.seq, min((wait for wait in (left, frees) if wait is not None), default=None)
            )

    def _rings_in_turn(self, board: Board, rings: datetime) -> bool:
        # Whether the time of the agent's alarm came while the agent's last turn ran.
        agent_id = self._setup.agent.id
        started = next((turn for turn in reversed(board.starts) if turn.agent == agent_id), None)
        ended = next((turn for turn in reversed(board.turns) if turn.agent == agent_id and not turn.no_turn), None)
        return bool(started and ended and started.seq < ended.seq and started.at <= rings <= ended.at)

    def _ring(self, message: str, due: AlarmSet | None, late: str) -> str:
        # Add the alarm that is due to a message that wakes the agent, so that the alarm rings once. The start of
        # the agent's next turn records that it rang.
        if due is None:
            return message
        self._rang = due.seq
        self._woke = f'{message} {alarm_message(due, late)}'.strip()
        return self._woke

    async def _settle(self) -> None:
        # Wait until the board has no new event for `quiet` seconds, and for `max_quiet` seconds at most.
        lab, settings = self._lab, self._settings
        loop = asyncio.get_running_loop()
        deadline = loop.time() + settings.max_quiet
        while (left := deadline - loop.time()) > 0:
            seq = lab.board.seq
            await lab.wait_for_change(seq, min(settings.quiet, left))
            # An agent that left the lab waits for nothing: its harness ends now, not when the board is quiet.
            # A post of the person that comes during the wait ends it.
            if lab.board.seq == seq or self._left() or self._person_wrote():
                return

    def _person_wrote(self) -> bool:
        # Whether a post of the person that is for the agent waits for its doorbell. The desk's post for the person
        # carries the person's word, so it rings at once too.
        board, agent_id = self._lab.board, self._setup.agent.id
        rung = max(self._notified, self._member.seen)
        waiting = takewhile(lambda entry: entry.seq > rung, reversed(board.posts))
        return any(speaks_for_person(entry.post) and wakes(board, agent_id, entry) for entry in waiting)

    async def _permission(self, request: PermissionRequest) -> str | None:
        board = self._lab.board
        # The board takes no ask from an agent that left, so nobody can decide its request. It is refused.
        if self._left():
            return refusal(request)
        if allowed := settled(board, request):
            return allowed
        # The person's setting, or else their choice of auto mode, says whether the request waits for their answer.
        # A refusal that would stop the agent's turn is no way to let the agent go on, so that request waits too.
        if self._refusals and not agent_waits(board) and declines(request):
            return await self._refusals.decide(self._member, request)
        async with self._asks(named(request)):
            return await ask_the_person(self._member, request, self._turn_over)

    async def _question(self, question: Question) -> Answers | None:
        # Nobody can answer an agent that left.
        if self._left():
            return None
        async with self._asks('a question of its harness'):
            return await ask_the_question(self._member, question, self._turn_over)

    @asynccontextmanager
    async def _asks(self, what: str) -> AsyncGenerator[None]:
        """Show the agent as waiting for the person while the block runs, and while another request of it waits."""
        self._asking += 1
        await self._report('waiting', f'Asks you: {what}', 'person')
        try:
            yield
        finally:
            self._asking -= 1
            # An agent whose turn ended is not at work, and the end of the turn reports what it does next.
            if not self._asking and not self._turn_over.is_set():
                await self._report('working')

    async def _step(self, title: str) -> None:
        await self._report('working', title)

    async def _report(
        self, state: AgentState, detail: str = '', waits_for: WaitsFor | None = None, retry: Retry | None = None
    ) -> None:
        if self._activity:
            await self._activity.set(self._setup.agent.id, state, detail, waits_for, retry)
