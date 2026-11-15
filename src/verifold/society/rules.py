"""
The integrity rules of the record.

These rules keep the record consistent: references point at things that exist, nobody checks their own work, and
only the author of a post can concede an objection to it. How agents should work is a norm for the agents, not a rule
here.

A blind checker in these rules is an agent of a record from before agents took reruns. Verifold started it for one
rerun request, and it read nothing but its claim. No such agent joins a lab now, and the rules keep the record of an
old one as it was.
"""

from verifold.protocol.agents import Agent
from verifold.protocol.events import (
    AgentLeft,
    AgentNamed,
    AlarmSet,
    CoordinatorSet,
    OnCallSet,
    ProfileSet,
    QuestionRevised,
    RerunRequested,
    RerunTaken,
    ReviewerSet,
    TimeRanOut,
    TimeSet,
    TurnEnded,
    TurnStarted,
    WatchSet,
)
from verifold.protocol.ids import PERSON, AgentId
from verifold.protocol.posts import Answer, Check, Close, Objection, Post, Proposal
from verifold.protocol.threads import Thread
from verifold.society.board import Board
from verifold.society.coordinator import check_marked_thread, check_marks, check_removal, check_reviser
from verifold.society.errors import RejectedEvent
from verifold.society.lifecycle import lab_state
from verifold.society.reruns import MAX_RERUNS, open_take, rerun_checks, wanted_reruns
from verifold.society.reviewers import free_seats, seats, seats_line
from verifold.society.standing import closing


def check_agent(board: Board, agent: Agent) -> None:
    """
    Check that an agent can join the board.

    Raises:
        RejectedEvent: The ID is taken or reserved, or the recruiter is not in the lab.

    """
    if agent.id == PERSON or board.agent(agent.id):
        raise RejectedEvent(f'The agent ID {agent.id} is taken. Choose another ID.')
    if agent.recruited_by:
        _check_member(board, agent.recruited_by)
    if agent.checks and not board.post(agent.checks):
        raise RejectedEvent(f'Post {agent.checks} does not exist.')


def check_named(board: Board, named: AgentNamed) -> None:
    """
    Check that an agent's seat can get a new label.

    A name that an agent has or had is never another agent's name, so that a name in an older post means the
    same agent for ever.

    Raises:
        RejectedEvent: The agent is not in the lab, or another agent has or had the name.

    """
    if not board.agent(named.agent):
        raise RejectedEvent(f'{named.agent} is not an agent in this lab.')
    if _held_by_another(board, named.agent, named.name):
        raise RejectedEvent(f'Another agent has or had the name {named.name}.')


def _held_by_another(board: Board, agent_id: AgentId, name: str) -> bool:
    folded = name.casefold()
    return any(agent != agent_id and text.casefold() == folded for agent, text in board.names())


def check_on_call(board: Board, event: OnCallSet) -> None:
    """
    Check that a seat can go on call or come off it.

    Raises:
        RejectedEvent: The agent is not in the lab, left it, or is a blind checker.

    """
    _check_seat(board, event.agent)


def check_coordinator(board: Board, event: CoordinatorSet) -> None:
    """
    Check that the lab's coordinator can change.

    The person can give the seat to any agent of the lab and can clear it. An agent can take the seat for itself
    when nobody holds it and the person did not close it, and give up the seat that it holds.

    Raises:
        RejectedEvent: The agent is not in the lab, left it, or is a blind checker, an agent names another agent,
            an agent takes a seat that somebody holds or that the person closed, or an agent gives up a seat that
            it does not hold.

    """
    if event.agent:
        _check_seat(board, event.agent)
    if event.by == PERSON:
        return
    _check_seat(board, event.by)
    holder = board.coordinator
    if event.agent is None:
        if holder != event.by:
            raise RejectedEvent('You are not the coordinator of this lab, so you have no seat to give up.')
        return
    if event.agent != event.by:
        raise RejectedEvent('An agent takes the coordinator seat for itself. Only the person gives it to another.')
    if holder and holder != event.by:
        raise RejectedEvent(
            f'{holder} is the coordinator of this lab. The seat is free when {holder} gives it up or the person '
            'gives it to another agent.'
        )
    if not holder and not board.coordinator_open:
        raise RejectedEvent(
            'The person closed the coordinator seat, so no agent takes it by itself. The person can give it to an '
            'agent or open it.'
        )


def _check_seat(board: Board, agent_id: AgentId) -> None:
    joined = board.agent(agent_id)
    if not joined:
        raise RejectedEvent(f'{agent_id} is not an agent in this lab.')
    _check_here(board, agent_id)
    if joined.agent.checks:
        raise RejectedEvent('A blind checker has no seat in the lab: it posts one check and is gone.')


def check_revision(board: Board, revision: QuestionRevised) -> None:
    """
    Check that a revision of the question comes with the post that tells the lab, from the one who revised it.

    The person revises the question. The lab's coordinator does with its own request, while the person switched on
    the power to revise the question.

    Raises:
        RejectedEvent: The post is not the board's newest, or the one who revised the question did not write it,
            or an agent revised the question without that power.

    """
    told = board.posts[-1] if board.posts else None
    if told is None or told.post.id != revision.post or told.post.author != revision.by or told.seq != board.seq:
        raise RejectedEvent(f'Post {revision.post} is not the post of the person that tells the lab of this revision.')
    if revision.by != PERSON or revision.request:
        check_reviser(board, revision)


def check_left(board: Board, left: AgentLeft) -> None:
    """
    Check that an agent can leave the lab, by its own choice or the person's.

    Raises:
        RejectedEvent: The agent is not in the lab, left already, or is a blind checker, or somebody other than the
            agent itself and the person caused it.

    """
    joined = board.agent(left.agent)
    if not joined:
        raise RejectedEvent(f'{left.agent} is not an agent in this lab.')
    _check_here(board, left.agent)
    if joined.agent.checks:
        raise RejectedEvent('A blind checker is gone after its one check, so it does not leave and nobody removes it.')
    if left.by not in (left.agent, PERSON):
        raise RejectedEvent(f'Only {left.agent} itself or the person can remove {left.agent} from the lab.')
    if left.through or left.request:
        check_removal(board, left)


def check_thread(board: Board, thread: Thread) -> None:
    """
    Check that a thread can open on the board.

    Raises:
        RejectedEvent: The ID is taken, the author is not in the lab, or a side thread names somebody that it cannot.

    """
    if board.thread(thread.id):
        raise RejectedEvent(f'Thread {thread.id} exists already.')
    _check_member(board, thread.opened_by)
    _check_here(board, thread.opened_by)
    if thread.between:
        _check_between(board, thread)
    if thread.conversation or thread.for_person:
        check_marked_thread(board, thread)


def check_post(board: Board, post: Post) -> None:
    """
    Check that a post can go on the board.

    Raises:
        RejectedEvent: The post breaks a rule of the record. The message says what to change.

    """
    if board.post(post.id):
        raise RejectedEvent(f'Post {post.id} exists already.')
    _check_member(board, post.author)
    _check_here(board, post.author)
    _check_blind(board, post)
    for mention in post.mentions:
        _check_member(board, mention)
    opened = board.thread(post.thread)
    if not opened:
        raise RejectedEvent(f'Thread {post.thread} does not exist. Open a thread first.')
    for built_on in post.builds_on:
        if not board.post(built_on):
            raise RejectedEvent(f'Post {built_on} does not exist, so no post can build on it.')
    _check_for_lab(board, post)
    check_marks(board, post, opened.thread)
    if post.reply_to is None:
        return
    target = board.post(post.reply_to)
    if target is None:
        raise RejectedEvent(f'Post {post.reply_to} does not exist.')
    if target.post.thread != post.thread:
        raise RejectedEvent(f'Post {post.reply_to} is in thread {target.post.thread}. Reply in that thread.')
    match post:
        case Objection() | Check() if target.post.author == post.author:
            raise RejectedEvent(f'Post {post.reply_to} is your own. Another agent must object to it or check it.')
        case Check(take=int()):
            _check_from_take(board, post)
        case Answer(accepts=True):
            _check_concession(board, post, target.post)


def check_watch(board: Board, watch: WatchSet) -> None:
    """
    Check that an agent can watch a thread.

    Raises:
        RejectedEvent: The agent is not in the lab, or the thread does not exist.

    """
    if not board.agent(watch.agent):
        raise RejectedEvent(f'{watch.agent} is not an agent in this lab.')
    _check_here(board, watch.agent)
    if not board.thread(watch.thread):
        raise RejectedEvent(f'Thread {watch.thread} does not exist.')


def check_alarm(board: Board, alarm: AlarmSet) -> None:
    """
    Check that an agent can set an alarm.

    Raises:
        RejectedEvent: The agent is not in the lab, or is a blind checker.

    """
    joined = board.agent(alarm.agent)
    if not joined:
        raise RejectedEvent(f'{alarm.agent} is not an agent in this lab.')
    _check_here(board, alarm.agent)
    if joined.agent.checks:
        raise RejectedEvent('A blind checker posts one check and sets no alarm.')


def check_profile(board: Board, profile: ProfileSet) -> None:
    """
    Check that a profile can change: by its agent, by the person, or by the lab's coordinator.

    The agent sets its own role, status, name, about line, and picture. The person takes back a name, an about
    line, or a picture, and gives the seat a role. The coordinator takes back another agent's name, rewrites its
    about line, flags its profile, and gives it a role where the person gave none.

    Raises:
        RejectedEvent: The agent is not in the lab or is a blind checker, the change holds nothing, the name is
            taken or reserved, or the change is not one that its author can make.

    """
    joined = board.agent(profile.agent)
    if not joined:
        raise RejectedEvent(f'{profile.agent} is not an agent in this lab.')
    # The person can still take back what an agent that left chose: its posts keep showing it.
    resets = profile.by == PERSON and profile.given_role is None
    if not resets:
        _check_here(board, profile.agent)
    if joined.agent.checks:
        raise RejectedEvent('A blind checker has no role and no status.')
    own = (profile.role, profile.status, profile.name, profile.about, profile.picture)
    others = (profile.given_role, profile.flag)
    if all(part is None for part in (*own, *others)) and not profile.no_picture:
        raise RejectedEvent(
            'The call changes nothing. It can set a role, a status, a name, an about line, or a picture.'
        )
    if profile.picture and profile.no_picture:
        raise RejectedEvent('A change sets a picture or takes it back, not both.')
    if profile.by not in (None, profile.agent):
        _check_profile_by_another(board, profile, profile.by)
        return
    if any(part is not None for part in others) or profile.no_picture:
        raise RejectedEvent(
            'Only the person or the coordinator gives a role to a seat, flags a profile, or takes a picture back.'
        )


def _check_profile_by_another(board: Board, profile: ProfileSet, by: AgentId) -> None:
    if profile.role is not None or profile.status is not None or profile.picture or profile.name:
        raise RejectedEvent("An agent's role, status, name, and picture are its own. Another can take a name back.")
    if by == PERSON:
        if profile.about or profile.flag is not None:
            raise RejectedEvent('The person takes an about line back and flags no profile.')
        return
    if board.coordinator != by:
        raise RejectedEvent(f"Only the person and the lab's coordinator change the profile of {profile.agent}.")
    if profile.no_picture:
        raise RejectedEvent('Only the person takes a picture back.')
    given, giver = board.given_role(profile.agent)
    if profile.given_role is not None and given and giver == PERSON:
        raise RejectedEvent(f'The person gave {profile.agent} a role, and only the person changes it.')


def check_reviewer(board: Board, event: ReviewerSet) -> None:
    """
    Check that an agent can take, get, give up, or lose a reviewer seat.

    The person gives a seat to any agent of the lab and takes it. An agent takes a seat for itself while one is
    free, and gives up the seat that it holds.

    Raises:
        RejectedEvent: The agent is not in the lab, left it, or is a blind checker, an agent names another
            agent, no seat is free, or the agent gives up a seat that it does not hold.

    """
    _check_seat(board, event.agent)
    if event.by == PERSON:
        return
    if event.by != event.agent:
        raise RejectedEvent('An agent takes a reviewer seat for itself. Only the person gives one to another.')
    if not event.reviewer:
        if not board.reviewer(event.agent):
            raise RejectedEvent('You hold no reviewer seat, so you have none to give up.')
        return
    if seats(board) == 0:
        raise RejectedEvent('This lab has no reviewer seats, so any agent can check.')
    if free_seats(board) < 1:
        raise RejectedEvent(f'No reviewer seat is free. {seats_line(board)}')


def check_turn(board: Board, turn: TurnStarted | TurnEnded) -> None:
    """
    Check that a turn belongs to an agent in the lab, and that only a blind checker's turn ends a rerun.

    Raises:
        RejectedEvent: The agent is not in the lab, the turn starts with the ring of an alarm that the agent did
            not set, or the turn ends a rerun and the agent is not a blind checker.

    """
    joined = board.agent(turn.agent)
    if not joined:
        raise RejectedEvent(f'{turn.agent} is not an agent in this lab.')
    rang = turn.rang if isinstance(turn, TurnStarted) else None
    if rang is not None and not any(alarm.seq == rang and alarm.agent == turn.agent for alarm in board.alarms):
        raise RejectedEvent(f'Event {rang} is no alarm of {turn.agent}, so it cannot ring for this turn.')
    if isinstance(turn, TurnEnded) and turn.rerun_failed and not joined.agent.checks:
        raise RejectedEvent(f'{turn.agent} is not a blind checker, so its turn cannot end a rerun.')


def check_rerun(board: Board, rerun: RerunRequested) -> None:
    """
    Check that somebody can ask for an independent rerun of a post.

    Raises:
        RejectedEvent: The post does not exist, has no files as evidence, or has the checks of all the independent
            reruns that one post gets.

    """
    _check_member(board, rerun.by)
    _check_here(board, rerun.by)
    target = board.post(rerun.post)
    if target is None:
        raise RejectedEvent(f'Post {rerun.post} does not exist.')
    if not target.post.evidence:
        raise RejectedEvent(f'Post {rerun.post} has no files as evidence, so a rerun has nothing to run.')
    if len(rerun_checks(board, rerun.post)) >= MAX_RERUNS:
        raise RejectedEvent(f'Post {rerun.post} has the checks of {MAX_RERUNS} independent reruns already.')


def check_take(board: Board, take: RerunTaken) -> None:
    """
    Check that an agent can take the rerun of a post.

    Raises:
        RejectedEvent: The agent is not in the lab or left it, the post does not exist or is the agent's own, the
            agent took it already, no rerun of the post is wanted, or the commit is not the one that the post pins.

    """
    if not board.agent(take.agent):
        raise RejectedEvent(f'{take.agent} is not an agent in this lab.')
    _check_here(board, take.agent)
    target = board.post(take.post)
    if target is None:
        raise RejectedEvent(f'Post {take.post} does not exist.')
    if target.post.author == take.agent:
        raise RejectedEvent(f'Post {take.post} is your own. Another agent takes its rerun.')
    if board.take(take.agent, take.post):
        raise RejectedEvent(f'{take.agent} took the rerun of post {take.post} already.')
    if not wanted_reruns(board, take.post):
        raise RejectedEvent(f'No rerun of post {take.post} is wanted now. `rerun` asks for one.')
    if all(file.commit != take.commit for file in target.post.evidence):
        raise RejectedEvent(f'Post {take.post} pins no file to the commit {take.commit}.')


def check_time(time: TimeSet) -> None:
    """
    Check that a new end of the lab is not earlier than the moment that it was set.

    Raises:
        RejectedEvent: The end is in the past.

    """
    if time.ends_at < time.at:
        raise RejectedEvent('The lab cannot end before the moment that its end is set.')


def check_time_out(board: Board, event: TimeRanOut) -> None:
    """
    Check that the lab reached its end, and that the record does not say so already.

    Raises:
        RejectedEvent: The lab has no time limit, has time left, or ran out of time already.

    """
    ends_at = board.ends_at
    if ends_at is None or event.at < ends_at or board.out_of_time:
        raise RejectedEvent('The lab runs out of time once, at its end.')


def _check_for_lab(board: Board, post: Post) -> None:
    # The posts that are for the whole lab: a proposal, a close, and a post that its author marks so.
    side = board.is_side(post.thread)
    if isinstance(post, Proposal | Close) and side:
        raise RejectedEvent(
            f'Thread {post.thread} is a side thread, and a {post.kind} is for the whole lab. Post it in a thread '
            'that is not a side thread.'
        )
    if isinstance(post, Close):
        _check_close(board, post)
    if not post.to_lab:
        return
    if post.author not in (PERSON, board.coordinator):
        raise RejectedEvent("Only the lab's coordinator and the person mark a post as one for the whole lab.")
    if side or post.mentions or post.reply_to:
        raise RejectedEvent(
            'A post for the whole lab is in a thread for the whole lab, names nobody in `mentions`, and replies to '
            'no post.'
        )


def _check_from_take(board: Board, check: Check) -> None:
    # Only Verifold marks a check as the check of a take. The mark names the author's own take of the same post,
    # and one take has one such check.
    taken = open_take(board, check.author, check.reply_to)
    if check.method != 'rerun' or taken is None or taken.seq != check.take or not check.evidence:
        raise RejectedEvent(
            f'Event {check.take} is not a take of {check.author} for {check.reply_to} that has no check yet, or '
            'the check is no rerun with files.'
        )


def _check_blind(board: Board, post: Post) -> None:
    joined = board.agent(post.author)
    target = joined.agent.checks if joined else None
    if target and not (isinstance(post, Check) and post.reply_to == target):
        raise RejectedEvent(f'You rerun {target} blind. Post one check that replies to {target}.')


def _check_member(board: Board, author: AgentId) -> None:
    if author != PERSON and not board.agent(author):
        raise RejectedEvent(f'{author} is not an agent in this lab.')


def _check_here(board: Board, agent_id: AgentId) -> None:
    # The record takes nothing more from an agent that left. Other agents can still name it, reply to its posts,
    # and check them, and the turn that it was in still ends.
    if board.gone(agent_id):
        raise RejectedEvent(f'{agent_id} left this lab, so the board takes no post and no other change from it.')


def _check_between(board: Board, thread: Thread) -> None:
    # A side thread is between agents of the lab that can hear it. The person can post in any thread already.
    others = tuple(agent for agent in thread.between if agent != thread.opened_by)
    if thread.opened_by == PERSON or thread.between[0] != thread.opened_by or not others:
        raise RejectedEvent('A side thread is between the agent that opens it and at least one other agent.')
    for agent in others:
        joined = board.agent(agent)
        if not joined:
            raise RejectedEvent(f'{agent} is not an agent in this lab, so no side thread is between you and it.')
        if joined.agent.checks:
            raise RejectedEvent(f'{agent} is a blind checker, which reads nothing but its claim.')
        if board.gone(agent):
            raise RejectedEvent(f'{agent} left this lab, so no post reaches it.')
        if not board.came(joined):
            raise RejectedEvent(f'{agent} has an invitation and has not posted yet, so nobody knows whether it came.')


def _check_close(board: Board, close: Close) -> None:
    if close.author == PERSON:
        raise RejectedEvent("A close is the agents' word that the lab is done. You can stop the lab at any time.")
    standing_close = closing(board)
    if standing_close is None or standing_close.post.author == close.author:
        return
    # Nobody can ask the author of a close to withdraw it once that author left. So another agent's close replaces
    # it, unless the lab is closed already: the agents that stood behind the old close keep their word.
    if board.gone(standing_close.post.author):
        if lab_state(board) == 'closed':
            raise RejectedEvent(
                f'The lab is closed already: more than half of its agents stood behind {standing_close.post.id}. '
                'It takes no other close.'
            )
        return
    raise RejectedEvent(
        f'{standing_close.post.author} says in {standing_close.post.id} that the lab is done. Agree with an '
        f'answer to it that has `accepts: true`, or object to it.'
    )


def _check_concession(board: Board, answer: Answer, target: Post) -> None:
    if isinstance(target, Close):
        if target.author == answer.author:
            raise RejectedEvent(f'Post {target.id} is your own. Another agent agrees with it.')
        return
    objected = board.post(target.reply_to) if isinstance(target, Objection) else None
    if objected is None:
        raise RejectedEvent('Only an answer to an objection or to a close can accept it.')
    if objected.post.author != answer.author:
        raise RejectedEvent(f'Only {objected.post.author}, who wrote {objected.post.id}, can accept this objection.')
