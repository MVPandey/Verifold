"""The service that owns one lab: its record, its board, and the callers that wait for new events."""

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Final, Self, assert_never

from verifold.protocol.agents import Agent, Picture, Power, one_line
from verifold.protocol.events import (
    AgentJoined,
    AgentLeft,
    AgentNamed,
    AlarmSet,
    BadgeSet,
    CoordinatorSet,
    Event,
    LabOpened,
    OnCallSet,
    PermissionGranted,
    Posted,
    PowerSet,
    ProfileSet,
    QuestionRevised,
    RequestAnswered,
    RerunRequested,
    RerunTaken,
    ReviewerSet,
    SettingsSet,
    ThreadOpened,
    TimeRanOut,
    TimeSet,
    TurnEnded,
    TurnStarted,
    TurnSummary,
    Voted,
    WatchSet,
)
from verifold.protocol.ids import PERSON, AgentId, PostId, ThreadId
from verifold.protocol.join import PostRequest
from verifold.protocol.moves import (
    AddMove,
    AddSeat,
    Move,
    PermissionMove,
    QuestionMove,
    RemoveMove,
    SettingMove,
    TimeMove,
)
from verifold.protocol.posts import (
    MAX_HEADLINE,
    Answer,
    Ask,
    Check,
    FileEvidence,
    Mark,
    MoveRequest,
    PermissionShown,
    QuestionShown,
)
from verifold.protocol.settings import Settings
from verifold.protocol.threads import CONVERSATION_TITLE, QUESTION_TITLE, Carries, Thread
from verifold.protocol.votes import Badge, BadgeAction, Direction
from verifold.server.changes import wait_until
from verifold.server.errors import LabExists, SetupRejected
from verifold.society.board import Board
from verifold.society.coordinator import check_asks, permission_choice, power_covers, time_given
from verifold.society.errors import RejectedEvent
from verifold.society.fold import apply, fold
from verifold.society.labels import awaits_model, is_numbered, label, plain
from verifold.society.lines import question_thread
from verifold.society.names import check_name
from verifold.society.reruns import open_take, open_to, wanted_reruns
from verifold.society.reviewers import check_review, seats_line
from verifold.society.votes import proposal, vote_of
from verifold.store.record_file import RecordFile

type Clock = Callable[[], datetime]
type Build = Callable[[Board, int, datetime], Event]
type Adds = Callable[[AddSeat, tuple[Build, ...], AgentId], Awaitable[None]]
"""
Adds one agent to the lab in the seat that a move describes, and starts it. The record takes the given events
first, in the same step as the agent, so that it says where the agent came from. The agent is the coordinator
that asked for the seat: a role of the seat is recorded as given by it.
"""


def utc_now() -> datetime:
    """Return the current time in UTC."""
    return datetime.now(UTC)


class Lab:
    """
    One lab's record and board.

    Every change goes through one lock: the lab checks the event against the board, writes it to the record, and then
    wakes the callers that wait for new events. An event that breaks a rule never reaches the record.
    """

    def __init__(self, record: RecordFile, events: tuple[Event, ...], clock: Clock = utc_now) -> None:
        """
        Serve an open record, given the events that it holds.

        Raises:
            RejectedEvent: The events do not add up to a board.

        """
        self._record = record
        self._clock = clock
        self._board = fold(events)
        self._changed = asyncio.Condition()

    @classmethod
    def load(cls, record: RecordFile, clock: Clock = utc_now) -> Self:
        """Serve a record that holds a lab already."""
        return cls(record, record.read(), clock)

    @classmethod
    def create(
        cls,
        record: RecordFile,
        question: str,
        *,
        auto_mode: bool = True,
        time_left: timedelta | None = None,
        clock: Clock = utc_now,
    ) -> Self:
        """
        Open a new lab on `question` in an empty record. With `time_left`, the lab ends that long after it opens.

        Raises:
            LabExists: The record holds a lab already.

        """
        if record.read():
            raise LabExists('This record holds a lab already. Load it instead.')
        at = clock()
        ends_at = at + time_left if time_left is not None else None
        opened = LabOpened(seq=1, at=at, question=question, auto_mode=auto_mode, ends_at=ends_at)
        record.append(opened)
        return cls(record, (opened,), clock)

    @property
    def board(self) -> Board:
        """The board after every event so far."""
        return self._board

    async def join(  # noqa: PLR0913
        self,
        agent: Agent,
        *,
        on_call: bool = False,
        coordinator: bool = False,
        powers: tuple[Power, ...] = (),
        first: tuple[Build, ...] = (),
        given: tuple[str, AgentId] | None = None,
    ) -> AgentJoined:
        """
        Add an agent to the lab.

        With `on_call`, the person put its seat on call. With `coordinator`, the person made it the lab's
        coordinator, and `powers` are the powers that the person switched on for it. The record takes all of them
        in the same step as the agent. `first` are events that come before the agent in that step, such as the
        yes to the request that asked for it. `given` is a role for the seat and the coordinator that gives it:
        the record keeps it as the coordinator's word, in the same step.

        Raises:
            RejectedEvent: The agent is a checker for one post. Only a record from before agents took reruns holds
                such agents.

        """
        if agent.checks:
            raise RejectedEvent('No agent joins a lab as the checker of one post. An agent of the lab takes a rerun.')
        builds: list[Build] = [*first, lambda _, seq, at: AgentJoined(seq=seq, at=at, agent=agent)]
        if on_call:
            builds.append(lambda _, seq, at: OnCallSet(seq=seq, at=at, agent=agent.id, on_call=True))
        if coordinator:
            builds.append(lambda _, seq, at: CoordinatorSet(seq=seq, at=at, agent=agent.id, by=PERSON))
            builds += [_power(power, agent.id) for power in powers]
        if given:
            role, by = given
            builds.append(lambda _, seq, at: ProfileSet(seq=seq, at=at, agent=agent.id, given_role=role, by=by))
        board = await self._commit(*builds)
        return next(entry for entry in reversed(board.agents) if entry.agent.id == agent.id)

    async def name_by_model(self, agent_id: AgentId, title: str, model: str) -> str:
        """
        Record the name of the model that an agent's harness reported, and return the agent's name after it.

        Only a name that Verifold built before the harness named the model changes: one that says "default model",
        or one that holds the ID of the model that the person chose. Only this agent's name changes. The new name
        keeps clear of every name that an agent of the lab has or had, so a name in an older post never becomes
        the name of another agent. A number, once given, stays with its agent, so numbers can be out of the order
        that the agents joined.
        """
        joined = self._board.agent(agent_id)
        if joined is None or not one_line(model):
            return joined.agent.name if joined else agent_id
        agent, base = joined.agent, plain(title, model)
        now = self._board.label(agent_id)
        if is_numbered(now, base) or not awaits_model(now, title, agent.model.name):
            return agent.name

        def build(board: Board, seq: int, at: datetime) -> AgentNamed:
            taken = (text for other, text in board.names() if other != agent_id)
            return AgentNamed(seq=seq, at=at, agent=agent_id, name=label(title, model, taken))

        board = await self._commit(build)
        named = board.agent(agent_id)
        return named.agent.name if named else agent_id

    async def set_on_call(self, agent_id: AgentId, *, on_call: bool) -> None:
        """
        Record that the person put an agent's seat on call, or took it off. The same answer again records nothing.

        Raises:
            RejectedEvent: The agent is not in the lab, left it, or is a blind checker.

        """
        if self._board.agent(agent_id) and self._board.on_call(agent_id) == on_call:
            return
        await self._commit(lambda _, seq, at: OnCallSet(seq=seq, at=at, agent=agent_id, on_call=on_call))

    async def set_coordinator(self, agent_id: AgentId | None, by: AgentId, *, free: bool = False) -> AgentId | None:
        """
        Record who holds the lab's coordinator seat, and return the holder after the change.

        `by` is the person, who can give the seat to any agent or clear it with `None`, or an agent, which can take
        the seat for itself when nobody holds it and the person did not close it, and give up the seat that it
        holds. When the person clears the seat, `free` says whether an agent may take it by itself. A change that
        leaves the seat as it is records nothing.

        Raises:
            RejectedEvent: The change breaks one of these rules.

        """
        known = agent_id is None or self._board.agent(agent_id)
        same = self._board.coordinator == agent_id and (agent_id is not None or self._board.coordinator_open == free)
        if known and same and by in (PERSON, agent_id):
            return agent_id
        opens = free and agent_id is None and by == PERSON
        board = await self._commit(lambda _, seq, at: CoordinatorSet(seq=seq, at=at, agent=agent_id, by=by, open=opens))
        return board.coordinator

    async def leave(self, agent_id: AgentId, by: AgentId, reason: str = '') -> AgentLeft:
        """
        Record that an agent left the lab. `by` is the agent itself, or the person when the person removed it.

        Raises:
            RejectedEvent: The agent is not in the lab, left already, or is a blind checker.

        """
        board = await self._commit(lambda _, seq, at: AgentLeft(seq=seq, at=at, agent=agent_id, by=by, reason=reason))
        return board.left[-1]

    async def post(  # noqa: PLR0913
        self,
        request: PostRequest,
        author: AgentId,
        evidence: tuple[FileEvidence, ...] = (),
        question_seen: int | None = None,
        mark: Mark | None = None,
        *,
        take: int | None = None,
    ) -> Posted:
        """
        Add a post with the next free post ID. With `new_thread`, open its thread in the same step.

        With `between` too, that thread is a side thread between the author and the agents that `between` names.
        `question_seen` is how many revisions of the question the author had been shown, which a proposal keeps.
        `mark` marks an ask that carries a request of the author's harness, or the answer with which Verifold ends
        such a request. Only the runner gives it. A post from an agent's tool or from the person has none.
        `take` is the event with which the author took the rerun that a check answers. Only the author's seat
        gives it.

        Raises:
            RejectedEvent: The post breaks a rule of the record.
            pydantic.ValidationError: The request does not describe a valid post of its kind.

        """
        # A thread that opens with an ask of the runner is the agent's thread for that kind of request.
        carries = mark.type if mark and mark != 'ends_request' else None
        opens: tuple[Build, ...] = ()
        if request.new_thread:
            opens = (_open_thread(request.new_thread, author, request.between, carries, for_person=request.for_person),)
        elif request.conversation and not self._board.conversation:
            opens = (_open_thread(CONVERSATION_TITLE, author, conversation=True),)
        board = await self._commit(*opens, _add_post(request, author, evidence, question_seen, mark, take=take))
        return board.posts[-1]

    async def open_question_thread(self) -> Posted:
        """
        Open the thread that holds the person's question, with the question as its first post.

        A new lab opens it before its agents join. The agents post their plans and the lab's answer there, and every
        agent watches it. The question's first line with text is the headline, and a longer question is also the
        body.
        """
        question = self._board.opened.question
        headline = _headline(question)
        body = '' if headline == question else question
        return await self.post(PostRequest(kind='message', text=headline, body=body, new_thread=QUESTION_TITLE), PERSON)

    async def revise_question(self, question: str, note: str = '') -> QuestionRevised | None:
        """
        Record that the person revised the question, and return the revision, or `None` when the text is the same.

        The revision comes with a post of the person in the question's thread, which names nobody. So it reaches
        the agents and opens a closed lab again as the person's other words to the lab do, and the thread shows
        each version in order. A lab from before the question had a thread gets one thread for these posts.
        """
        # The event strips the text, so the same text with spaces around it is no revision.
        question = question.strip()
        if question == self._board.question:
            return None
        board = await self._commit(*_revision(self._board, question, note, PERSON))
        return board.revisions[-1]

    async def set_alarm(self, agent_id: AgentId, minutes: float, *, quiet: bool) -> AlarmSet:
        """Record that an agent wants to be woken. The alarm replaces the agent's last one, and zero minutes cancels it."""
        board = await self._commit(
            lambda _, seq, at: AlarmSet(seq=seq, at=at, agent=agent_id, minutes=minutes, quiet=quiet, stays=True)
        )
        return board.alarms[-1]

    async def set_profile(  # noqa: PLR0913
        self,
        agent_id: AgentId,
        role: str | None = None,
        status: str | None = None,
        *,
        name: str | None = None,
        about: str | None = None,
        picture: Picture | None = None,
        coordinator: bool | None = None,
        reviewer: bool | None = None,
    ) -> tuple[str, str]:
        """
        Record what an agent says that it is and does, and return its role and status after the change.

        With `coordinator` or `reviewer`, the agent takes that seat or gives it up in the same step. The record
        takes the whole call or nothing: when the board refuses one part, such as a seat that is not free, no part
        is recorded. A part that changes nothing records nothing, so an agent can read its own profile with no
        arguments, and one that repeats its status does not fill the record.

        Raises:
            RejectedEvent: The name is taken, reserved, or the name of a harness or a model, or a seat is not free.

        """
        board = self._board
        now_role, now_status = board.profile(agent_id)
        fresh = {
            'role': None if role == now_role else role,
            'status': None if status == now_status else status,
            'name': None if name == board.chosen_name(agent_id) else name,
            'about': None if about == board.about(agent_id) else about,
            'picture': None if picture == board.picture(agent_id) else picture,
        }
        builds: list[Build] = []

        def profile(board: Board, seq: int, at: datetime) -> ProfileSet:
            # The name's rules are here and not in the record's rules, so a record keeps every name that it holds.
            if fresh['name'] and board.agent(agent_id):
                check_name(board, agent_id, str(fresh['name']))
            return ProfileSet.model_validate({'seq': seq, 'at': at, 'agent': agent_id} | fresh)

        if not board.agent(agent_id) or any(value is not None for value in fresh.values()):
            builds.append(profile)
        holder = agent_id if coordinator else None
        # An agent that gives up a seat that it does not hold gets the reason.
        if coordinator is not None and not (coordinator and board.coordinator == agent_id):
            builds.append(lambda _, seq, at: CoordinatorSet(seq=seq, at=at, agent=holder, by=agent_id))
        if reviewer is not None and not (reviewer and board.reviewer(agent_id)):
            builds.append(
                lambda _, seq, at: ReviewerSet(seq=seq, at=at, agent=agent_id, reviewer=bool(reviewer), by=agent_id)
            )
        if builds:
            board = await self._commit(*builds)
        return board.profile(agent_id)

    async def change_profile(  # noqa: PLR0913
        self,
        agent_id: AgentId,
        by: AgentId,
        *,
        reset_name: bool = False,
        about: str | None = None,
        reset_picture: bool = False,
        given_role: str | None = None,
        flag: str | None = None,
    ) -> None:
        """
        Record a change that the person or the lab's coordinator makes to an agent's profile.

        `by` is the person or the coordinator. The record keeps every earlier text, and the agent's next news says
        what changed. A call that changes nothing records nothing.

        Raises:
            RejectedEvent: The change is not one that `by` can make.

        """
        board = self._board
        standing_flag = board.flag(agent_id)
        fresh = {
            'name': '' if reset_name and board.chosen_name(agent_id) else None,
            'about': None if about == board.about(agent_id) else about,
            'no_picture': reset_picture and board.picture(agent_id) is not None,
            'given_role': None if given_role == board.given_role(agent_id)[0] else given_role,
            'flag': None if flag == (standing_flag.flag if standing_flag else '') else flag,
        }
        if board.agent(agent_id) and not any(value not in (None, False) for value in fresh.values()):
            return
        await self._commit(
            lambda _, seq, at: ProfileSet.model_validate({'seq': seq, 'at': at, 'agent': agent_id, 'by': by} | fresh)
        )

    async def set_reviewer(self, agent_id: AgentId, by: AgentId, *, reviewer: bool) -> None:
        """
        Record that an agent holds a reviewer seat from now on, or holds one no longer.

        `by` is the person, who can give a seat to any agent and take it, or the agent itself, which can take a
        free seat and give up the seat that it holds. A change that leaves the seat as it is records nothing.

        Raises:
            RejectedEvent: The change breaks one of these rules.

        """
        same = self._board.agent(agent_id) and self._board.reviewer(agent_id) == reviewer
        # An agent that gives up a seat that it does not hold gets the reason.
        if same and (reviewer or by == PERSON) and by in (PERSON, agent_id):
            return
        await self._commit(lambda _, seq, at: ReviewerSet(seq=seq, at=at, agent=agent_id, reviewer=reviewer, by=by))

    async def watch(self, agent_id: AgentId, thread_id: ThreadId, *, watching: bool) -> WatchSet:
        """Record that an agent starts or stops watching a thread."""
        board = await self._commit(
            lambda _, seq, at: WatchSet(seq=seq, at=at, agent=agent_id, thread=thread_id, watching=watching)
        )
        return board.watches[-1]

    async def request_rerun(self, by: AgentId, post_id: PostId) -> RerunRequested:
        """
        Record a request for an independent rerun of a post. The request starts nothing: an agent of the lab takes it.

        Raises:
            RejectedEvent: The post cannot get a rerun, or the same member has an open request for it already.

        """

        def build(board: Board, seq: int, at: datetime) -> RerunRequested:
            # A record from before this rule can hold such a pair, so the rule is here and not in the record's rules.
            if any(entry.by == by for entry in wanted_reruns(board, post_id)):
                raise RejectedEvent(
                    f'You asked for an independent rerun of {post_id} already. Its check comes to you as a post.'
                )
            # An older record holds requests from before the reviewer seats, so this rule is here too.
            if board.post(post_id):
                check_review(board, by, post_id, 'A request for an independent rerun of')
            return RerunRequested(seq=seq, at=at, by=by, post=post_id)

        board = await self._commit(build)
        return board.reruns[-1]

    async def take_rerun(self, agent_id: AgentId, post_id: PostId, manifest: str | None = None) -> RerunTaken:
        """
        Record that an agent takes the rerun of a post, and return the take.

        `manifest` is the SHA-256 of the clean copy's manifest that the agent got. A second call returns the first
        take, also when it comes while the first one is being recorded.

        Raises:
            RejectedEvent: The agent cannot take the rerun, as `check_take` says.

        """
        if taken := self._board.take(agent_id, post_id):
            return taken
        try:
            board = await self._commit(_take(agent_id, post_id, manifest))
        except RejectedEvent:
            # Two calls of one agent at the same time are one take.
            if taken := self._board.take(agent_id, post_id):
                return taken
            raise
        return board.takes[-1]

    async def vote(self, by: AgentId, post_id: PostId, direction: Direction, reason: str = '') -> Voted | None:
        """
        Record a vote of an agent or the person on a post, and return the voter's vote as it stands, or `None`.

        A voter has one vote on a post: a new one replaces it, and `none` takes it back. The same vote again
        records nothing. A vote wakes nobody and changes nothing else on the board.

        Raises:
            RejectedEvent: The vote breaks a rule of the record, as `check_vote` says.

        """
        now = vote_of(self._board, by, post_id)
        if now and (now.direction, now.reason) == (direction, one_line(reason)):
            return now
        board = await self._commit(
            lambda _, seq, at: Voted(seq=seq, at=at, by=by, post=post_id, direction=direction, reason=reason)
        )
        return vote_of(board, by, post_id)

    async def badge(  # noqa: PLR0913
        self,
        by: AgentId,
        post_id: PostId,
        badge: Badge,
        action: BadgeAction = 'give',
        reason: str = '',
        *,
        proof: PostId | None = None,
        giver: AgentId | None = None,
    ) -> BadgeSet:
        """
        Record a change to a badge on a post: `by` gives it, seconds it, or takes it back.

        A second is for the one proposal of a `breakthrough` that waits on the post. `giver` names whose badge the
        person takes back. A badge wakes nobody and changes nothing else on the board.

        Raises:
            RejectedEvent: The change breaks a rule of the record, as `check_badge` says.

        """

        def build(board: Board, seq: int, at: datetime) -> BadgeSet:
            waiting = proposal(board, post_id) if action == 'second' else None
            return BadgeSet(
                seq=seq,
                at=at,
                by=by,
                post=post_id,
                badge=badge,
                action=action,
                reason=reason,
                proof=proof,
                giver=waiting.by if waiting else giver,
            )

        board = await self._commit(build)
        return board.badges[-1]

    def check_take(self, agent_id: AgentId, post_id: PostId) -> None:
        """
        Check that an agent can take the rerun of a post now, and record nothing.

        The clean copy is made between this check and the take, so a copy that fails leaves no take in the record.

        Raises:
            RejectedEvent: No rerun of the post is wanted, the post is the agent's own, or the rerun is for an
                agent in a reviewer seat and the agent holds none.

        """
        board = self._board
        apply(board, _take(agent_id, post_id)(board, board.seq + 1, self._clock()))

    async def start_turn(  # noqa: PLR0913
        self,
        agent_id: AgentId,
        session: str,
        seen: int,
        rang: int | None = None,
        *,
        model: str | None = None,
        model_name: str | None = None,
    ) -> TurnStarted:
        """
        Record that a turn of an agent starts, in the harness's conversation `session`, with what it had seen.

        `rang` is the sequence number of the agent's alarm that rang with the turn's message. `model` and
        `model_name` are the model that the harness reported for the session, when it reported one.
        """
        board = await self._commit(
            lambda _, seq, at: TurnStarted(
                seq=seq,
                at=at,
                agent=agent_id,
                session=session,
                seen=seen,
                rang=rang,
                model=model,
                model_name=model_name,
            )
        )
        return board.starts[-1]

    async def end_turn(self, turn: TurnSummary) -> TurnEnded:
        """Record that an agent's harness ended a turn, with what the turn cost and the snapshot after it."""
        board = await self._commit(
            lambda _, seq, at: TurnEnded.model_validate(turn.model_dump() | {'seq': seq, 'at': at})
        )
        return board.turns[-1]

    def now(self) -> datetime:
        """Return the time on the clock that dates the lab's events."""
        return self._clock()

    async def set_time_left(self, left: timedelta) -> None:
        """Record that the lab ends `left` from now. A `left` of zero stops the agents now."""
        await self._commit(lambda _, seq, at: TimeSet(seq=seq, at=at, ends_at=at + left))

    async def set_settings(self, settings: Settings) -> None:
        """Record the person's settings for the lab. The lab follows the latest ones."""
        await self._commit(lambda _, seq, at: SettingsSet(seq=seq, at=at, settings=settings))

    async def grant(self, prefix: str) -> None:
        """Record that the person lets every agent run the commands that start with `prefix`."""
        await self._commit(lambda _, seq, at: PermissionGranted(seq=seq, at=at, prefix=prefix))

    async def run_out_of_time(self) -> None:
        """
        Record that the lab reached its end.

        Raises:
            RejectedEvent: The lab has time left, has no time limit, or ran out of time already.

        """
        await self._commit(lambda _, seq, at: TimeRanOut(seq=seq, at=at))

    async def set_power(self, power: Power, *, on: bool) -> None:
        """
        Record that the person switched a power of the coordinator on or off. The same answer again records nothing.

        Raises:
            RejectedEvent: Nobody holds the coordinator seat.

        """
        holder = self._board.coordinator
        if holder is None:
            raise RejectedEvent('A power is for the agent that holds the coordinator seat, and nobody holds it now.')
        if (power in self._board.powers) != on:
            await self._commit(_power(power, holder, on=on))

    async def request(self, move: Move, text: str, body: str, author: AgentId, adds: Adds | None = None) -> Posted:
        """
        Post the coordinator's request for a move in the conversation with the person, and return the post.

        The request opens the conversation when the lab has none. While the person's power covers the move, the
        same step records the coordinator's yes and makes the move. Otherwise the request waits for the person's
        answer, and nothing else changes: so it does when the lab's time ran out or the person stopped the lab.

        Raises:
            RejectedEvent: The author does not hold the coordinator seat, or the move cannot be made.
            SetupRejected: The move adds an agent at once, and this lab cannot start one from here.
            pydantic.ValidationError: The text is no headline, or the body is too long.

        """
        board = self._board
        # The record's rules refuse the request of any other agent. This says so before a thread opens for it.
        check_asks(board, author)
        opens = () if board.conversation else (_open_thread(CONVERSATION_TITLE, author, conversation=True),)

        def post(board: Board, seq: int, at: datetime) -> Posted:
            request = MoveRequest(
                id=f'p-{len(board.posts) + 1}',
                thread=board.conversation or board.threads[-1].thread.id,
                author=author,
                text=text,
                body=body,
                move=move,
            )
            return Posted(seq=seq, at=at, post=request)

        builds: tuple[Build, ...] = (*opens, post)
        if power_covers(board, move, self._clock()):
            builds = (*builds, _answered(None, author, yes=True))
            if isinstance(move, AddMove):
                await _add(adds, move, builds, author)
                board = self._board
            else:
                board = await self._commit(*builds, *_effects(board, move, author))
        else:
            board = await self._commit(*builds)
        return next(
            entry
            for entry in reversed(board.posts)
            if isinstance(entry.post, MoveRequest) and entry.post.author == author
        )

    async def answer_request(
        self,
        request_id: PostId,
        *,
        yes: bool,
        minutes: int | None = None,
        adds: Adds | None = None,
    ) -> RequestAnswered:
        """
        Record the person's answer to a request of the coordinator for a move, and with a yes make the move.

        The person's answer is also a post of the person that replies to the request, so the coordinator hears it
        as it hears the person's other words in the conversation. With a yes, the events of the move follow the
        answer in the same step, so that either all of it is in the record or none of it is. `minutes` gives
        another amount than the request names, for a request for more time.

        Raises:
            RejectedEvent: The post is no request that can take this answer, or the move cannot be made any more.
            SetupRejected: The move adds an agent, and this lab cannot start one from here.

        """
        board = self._board
        entry = board.post(request_id)
        request = entry.post if entry and isinstance(entry.post, MoveRequest) else None
        builds: tuple[Build, ...] = (_answered(request_id, PERSON, yes=yes, minutes=minutes),)
        if request:
            said = PostRequest(kind='answer', text=YES if yes else NO, thread=request.thread, reply_to=request_id)
            builds = (_add_post(said, PERSON, ()), *builds)
        if not yes or request is None:
            await self._commit(*builds)
        elif isinstance(request.move, AddMove):
            await _add(adds, request.move, builds, request.author)
        else:
            await self._commit(*builds, *_effects(board, request.move, PERSON, minutes))
        return self._board.answers[-1]

    async def take_minutes_back(self, request_id: PostId) -> None:
        """
        Record that the person takes back the minutes that a request for more time gave the lab.

        Raises:
            RejectedEvent: The request gave no minutes, the lab's time changed since, or the lab would end now.

        """

        def build(board: Board, seq: int, at: datetime) -> TimeSet:
            answered = board.answer_to(request_id)
            given = time_given(board, answered) if answered else None
            entry = board.post(request_id)
            move = entry.post.move if entry and isinstance(entry.post, MoveRequest) else None
            if not answered or given is None or board.times[-1] is not given or not isinstance(move, TimeMove):
                raise RejectedEvent(
                    f"The request {request_id} gave the lab no minutes, or the lab's time changed since. Set the "
                    "lab's time yourself."
                )
            ends_at = given.ends_at - timedelta(minutes=answered.minutes or move.minutes)
            if ends_at <= at:
                raise RejectedEvent('Without these minutes the lab ends now. To stop the lab, set its time to zero.')
            return TimeSet(seq=seq, at=at, ends_at=ends_at)

        await self._commit(build)

    async def wait_for_change(self, after: int, timeout: float | None = None) -> None:
        """Return once the board has an event after `after`, or after `timeout` seconds when given."""
        await wait_until(self._changed, lambda: self._board.seq > after, timeout)

    async def _commit(self, *builds: Build) -> Board:
        # The condition's lock serializes changes. Each event comes from the board that it joins, so IDs and sequence
        # numbers never collide, and `apply` rejects a bad event before anything reaches the record.
        async with self._changed:
            board, events, at = self._board, [], self._clock()
            for build in builds:
                event = build(board, board.seq + 1, at)
                board = apply(board, event)
                events.append(event)
            self._record.append(*events)
            self._board = board
            self._changed.notify_all()
            return board


REVISED: Final = 'The person revised the question: '
"""How the post that tells the lab of a revision starts. The new question follows it."""

REVISED_TITLE: Final = 'The question, revised'
"""The title of the thread that holds the revisions in a lab from before the question had a thread."""

REVISED_FOR_PERSON: Final = 'The coordinator revised the question for the person: '
"""How that post starts when the coordinator revised the question with the person's power."""

YES: Final = 'Yes'
NO: Final = 'Not now'
"""The person's answer to a request for a move, as the conversation shows it."""


def _revision(board: Board, question: str, note: str, by: AgentId, *, requested: bool = False) -> tuple[Build, ...]:
    # The post that tells the lab of a revision, in the question's thread, and the revision after it. A lab from
    # before the question had a thread gets one thread for these posts, whoever revised the question first. With
    # `requested`, the revision is the move of the request that just got its yes.
    earlier = {told.post.thread for revision in board.revisions if (told := board.post(revision.post))}
    whole = f'{REVISED if by == PERSON else REVISED_FOR_PERSON}{question}'
    text = _headline(whole)
    # A question that fits in the headline is not repeated in the body.
    parts = ('' if text == whole else question, f'Why: {note}' if note else '')
    body = '\n\n'.join(part for part in parts if part)
    thread = question_thread(board) or next(
        (
            opened.thread.id
            for opened in board.threads
            if opened.thread.title == REVISED_TITLE
            and (opened.thread.opened_by == PERSON or opened.thread.id in earlier)
        ),
        None,
    )
    request = PostRequest(
        kind='message',
        text=text,
        body=body,
        thread=thread,
        new_thread=None if thread else REVISED_TITLE,
        for_person=by != PERSON,
    )
    opens = (_open_thread(REVISED_TITLE, by),) if thread is None else ()
    return (
        *opens,
        _add_post(request, by, ()),
        lambda board, seq, at: QuestionRevised(
            seq=seq,
            at=at,
            question=question,
            note=note,
            post=board.posts[-1].post.id,
            by=by,
            request=board.answers[-1].request if requested else None,
        ),
    )


def _power(power: Power, agent: AgentId, *, on: bool = True) -> Build:
    return lambda _, seq, at: PowerSet(seq=seq, at=at, power=power, on=on, agent=agent)


def _answered(request_id: PostId | None, by: AgentId, *, yes: bool, minutes: int | None = None) -> Build:
    # Without an ID, the request is the board's newest post: the request that the same step posted.
    def build(board: Board, seq: int, at: datetime) -> RequestAnswered:
        request = request_id or board.posts[-1].post.id
        return RequestAnswered(seq=seq, at=at, request=request, yes=yes, by=by, minutes=minutes)

    return build


async def _add(adds: Adds | None, move: AddMove, first: tuple[Build, ...], asked_by: AgentId) -> None:
    if adds is None:
        raise SetupRejected('This lab cannot start an agent from here.')
    await adds(move.seat, first, asked_by)


type RecordedMove = TimeMove | PermissionMove | RemoveMove | SettingMove | QuestionMove
"""A move that the record alone makes. A move that adds an agent is not one, because the host starts the agent."""


def _effects(board: Board, move: RecordedMove, by: AgentId, minutes: int | None = None) -> tuple[Build, ...]:
    """
    Return the events that make a move after the yes to its request. `by` is who said yes.

    They are the events that the person's own move records, and each names the request where its record can.
    `minutes` is the amount that the person gave in place of the request's. No event holds the coordinator's
    words as the person's: the reason stays in the request.
    """
    match move:
        case TimeMove():
            return (_more_time(minutes or move.minutes),)
        case PermissionMove():
            return (_permission_answer(move, by),)
        case RemoveMove():
            return (_removal(move, by),)
        case SettingMove():
            return (_setting(move),)
        case QuestionMove():
            if move.question == board.question:
                raise RejectedEvent('The question has this text already.')
            # The note is the coordinator's word. The person's revision carries none of it.
            return _revision(board, move.question, '' if by == PERSON else move.note, by, requested=True)
        case _:
            assert_never(move)


def _more_time(minutes: int) -> Build:
    def build(board: Board, seq: int, at: datetime) -> TimeSet:
        # The minutes count from the lab's end, or from now when the end has passed. So no move ends a lab earlier.
        ends_at = max(board.ends_at or at, at) + timedelta(minutes=minutes)
        return TimeSet(seq=seq, at=at, ends_at=ends_at, request=board.answers[-1].request)

    return build


def _permission_answer(move: PermissionMove, by: AgentId) -> Build:
    def build(board: Board, seq: int, at: datetime) -> Posted:
        # The record's rules check the answer against the request and its author once more.
        ask, label = permission_choice(board, move, by)
        answer = Answer(
            id=f'p-{len(board.posts) + 1}',
            thread=ask.thread,
            author=by,
            text=label,
            reply_to=ask.id,
            choice=label,
            for_request=board.answers[-1].request,
        )
        return Posted(seq=seq, at=at, post=answer)

    return build


def _removal(move: RemoveMove, by: AgentId) -> Build:
    # The removal is the person's. With the coordinator's power, it names the coordinator too. The reason is the
    # coordinator's, so it stays in the request, which the removal names.
    through = None if by == PERSON else by
    return lambda board, seq, at: AgentLeft(
        seq=seq, at=at, agent=move.agent, by=PERSON, through=through, request=board.answers[-1].request
    )


def _setting(move: SettingMove) -> Build:
    section, _, name = move.key.partition('.')

    def build(board: Board, seq: int, at: datetime) -> SettingsSet:
        # The section is validated again, so the setting holds a value of its own type.
        now = getattr(board.settings, section)
        changed = type(now).model_validate(now.model_dump() | {name: move.value})
        settings = board.settings.model_copy(update={section: changed})
        return SettingsSet(seq=seq, at=at, settings=settings, request=board.answers[-1].request)

    return build


def _take(agent_id: AgentId, post_id: PostId, manifest: str | None = None) -> Build:
    def build(board: Board, seq: int, at: datetime) -> RerunTaken:
        target = board.post(post_id)
        if target is None or not target.post.evidence:
            raise RejectedEvent(f'No rerun of post {post_id} is wanted now. `rerun` asks for one.')
        # A rerun is for the holders of the reviewer seats, and for any agent when no holder can take it. An older
        # record has no such rule, so it is here and not in the record's rules.
        seated = board.reviewer(agent_id) or target.post.author == agent_id
        if not seated and wanted_reruns(board, post_id) and open_to(board, post_id) == 'reviewer':
            raise RejectedEvent(
                f"The rerun of another agent's post takes a reviewer seat while an agent in such a seat can take "
                f'it. {seats_line(board)}'
            )
        commit = target.post.evidence[0].commit
        return RerunTaken(seq=seq, at=at, agent=agent_id, post=post_id, commit=commit, manifest=manifest)

    return build


def _headline(text: str) -> str:
    # The first line with text, cut to a headline. A question can start with a separator that `splitlines` breaks
    # on and the schema's strip keeps.
    first = next((line.strip() for line in text.splitlines() if line.strip()), QUESTION_TITLE)
    return first if len(first) <= MAX_HEADLINE else f'{first[: MAX_HEADLINE - 1]}…'


def _open_thread(  # noqa: PLR0913
    title: str,
    opened_by: AgentId,
    between: tuple[AgentId, ...] = (),
    carries: Carries | None = None,
    *,
    conversation: bool = False,
    for_person: bool = False,
) -> Build:
    # The author is always in its own side thread, and comes first. An agent that names itself changes nothing.
    members = tuple(dict.fromkeys((opened_by, *between))) if between else ()

    def build(board: Board, seq: int, at: datetime) -> ThreadOpened:
        thread = Thread(
            id=f't-{len(board.threads) + 1}',
            title=title,
            opened_by=opened_by,
            between=members,
            carries=carries,
            conversation=conversation,
            for_person=for_person,
        )
        return ThreadOpened(seq=seq, at=at, thread=thread)

    return build


def _add_post(  # noqa: PLR0913
    request: PostRequest,
    author: AgentId,
    evidence: tuple[FileEvidence, ...],
    question_seen: int | None = None,
    mark: Mark | None = None,
    *,
    take: int | None = None,
) -> Build:
    def build(board: Board, seq: int, at: datetime) -> Posted:
        # A new thread, and a conversation that this step opens, is the board's newest thread.
        talk = board.conversation if request.conversation else None
        thread_id = request.thread or talk or board.threads[-1].thread.id
        # No field of a request holds a take either, so only the seat that pinned the files can give one. A take
        # has one check: when another check of the same take came first, this one is a check like any other.
        still = take if request.reply_to and open_take(board, author, request.reply_to) else None
        post = request.to_post(f'p-{len(board.posts) + 1}', thread_id, author, evidence, question_seen, take=still)
        # No field of a request holds a mark, so no agent and no person's post can carry one.
        if isinstance(post, Answer) and mark == 'ends_request':
            post = post.model_copy(update={'ends_request': True})
        elif isinstance(post, Ask) and isinstance(mark, PermissionShown | QuestionShown):
            post = post.model_copy(update={'request': mark.type, 'shown': mark})
        # The coordinator's post for the person is for the whole lab where such a post can stand, so that it
        # reaches the agents as the person's own post does.
        aside = board.is_side(thread_id) or thread_id == board.conversation
        if post.for_person and author == board.coordinator and not (post.mentions or post.reply_to or aside):
            post = post.model_copy(update={'to_lab': True})
        # An older record holds checks from before the reviewer seats, so this rule is here and not in the record's
        # rules.
        # The one check of a rerun that its author took needs no seat of its own: the take was open to the author.
        if isinstance(post, Check) and post.take is None and board.post(post.reply_to):
            check_review(board, author, post.reply_to, 'A check on')
        return Posted(seq=seq, at=at, post=post)

    return build
