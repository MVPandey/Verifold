"""Where posts stand after the objections, checks, and answers to them."""

from verifold.protocol.agents import GUEST, UNKNOWN_FAMILY, Agent, same_family
from verifold.protocol.events import Posted
from verifold.protocol.ids import PERSON, AgentId, PostId
from verifold.protocol.join import Standing
from verifold.protocol.posts import Answer, Check, Close, Objection, Plan, Proposal, RuledOut
from verifold.society.board import Board


def standing(board: Board, post_id: PostId) -> Standing:
    """
    Return where a post stands. The first state that applies wins.

    - `conceded`: the post's author accepted an objection to it.
    - `disputed`: a check of the post failed, or an objection stands. A later check that holds overrules an
      objection, unless the objector wrote that check.
    - `held_up`: an independent rerun by another model held. That is a check with the method `rerun` that holds,
      from another agent that took the rerun and so was given the clean copy of the post's pinned files, and
      from another model than the post's. It does not say how the checker made the files of its check. `another_model` says when the models differ. In a record from before
      agents took reruns, it is the check of a checker that Verifold started from another model family.
    - `checked`: another agent's check holds.
    - `open`: none of the above.

    Checks and objections that their own authors conceded don't count.
    """
    replies = tuple(entry for entry in board.replies(post_id) if standing(board, entry.post.id) != 'conceded')
    objections = tuple((entry.seq, entry.post) for entry in replies if isinstance(entry.post, Objection))
    checks = tuple((entry.seq, entry.post) for entry in replies if isinstance(entry.post, Check))
    if any(_conceded(board, objection) for _, objection in objections):
        return 'conceded'
    if any(check.outcome == 'fails' for _, check in checks):
        return 'disputed'
    if any(not _overruled(seq, objection, checks) for seq, objection in objections):
        return 'disputed'
    if any(_independent_rerun(board, post_id, seq, check) for seq, check in checks):
        return 'held_up'
    return 'checked' if checks else 'open'


def waits_for_person(board: Board, post_id: PostId) -> bool:
    """
    Return whether an ask still waits for the person: the person gave no answer, and Verifold did not end it.

    Verifold ends an ask that carries a request of a harness when the request ends without the person, as when the
    agent's turn ends. An agent's own answer ends nothing, because no agent can mark it so. The answer that
    carries out a coordinator's request for a move ends the wait: the person said yes to that request, or switched
    on the coordinator's power to answer permission requests.
    """
    replies = [entry.post for entry in board.replies(post_id) if isinstance(entry.post, Answer)]
    # An answer that carries out a request of the coordinator decides the ask, with the person's yes or power.
    return not any(reply.author == PERSON or reply.ends_request or reply.for_request for reply in replies)


def is_answered(board: Board, post_id: PostId, by: AgentId | None = None) -> bool:
    """Return whether an answer replies to a post: any answer, or with `by`, an answer from that author."""
    return any(
        isinstance(entry.post, Answer) and (by is None or entry.post.author == by) for entry in board.replies(post_id)
    )


def takers(board: Board, call_id: PostId) -> tuple[AgentId, ...]:
    """
    Return the agents that took a call, each once, in the order that they took it.

    An agent of the lab takes a call with a plan that replies to it. The caller's own plan takes nothing. Nor does
    the plan of an agent that left the lab since, so a call that only such agents took needs an agent again.
    """
    call = board.post(call_id)
    workers = {
        joined.agent.id for joined in board.agents if not joined.agent.checks and not board.gone(joined.agent.id)
    }
    return tuple(
        dict.fromkeys(
            entry.post.author
            for entry in board.replies(call_id)
            if isinstance(entry.post, Plan)
            and call
            and entry.post.author != call.post.author
            and entry.post.author in workers
        )
    )


def is_open_call(board: Board, call_id: PostId) -> bool:
    """Return whether a call still needs an agent: nobody took it, and the caller did not withdraw it."""
    call = board.post(call_id)
    withdrawn = any(
        isinstance(entry.post, RuledOut) and call and entry.post.author == call.post.author
        for entry in board.replies(call_id)
    )
    return not withdrawn and not takers(board, call_id)


def _independent_rerun(board: Board, post_id: PostId, seq: int, check: Check) -> bool:
    checker = board.agent(check.author)
    target = board.post(post_id)
    author = board.agent(target.post.author) if target else None
    if check.outcome != 'holds' or check.method != 'rerun' or checker is None or target is None or author is None:
        return False
    if checker.agent.checks == post_id:
        # A checker that Verifold started, in a record from before agents took reruns. It read nothing but its
        # claim, and the families of the two seats decide, as they did then.
        return other_family(author.agent, checker.agent)
    # Any other check counts when it is the check of its author's take.
    return check.take is not None and another_model(board, target, seq, check.author)


def another_model(board: Board, post: Posted, seq: int, checker_id: AgentId) -> bool:
    """
    Return whether an agent's check at event `seq` comes from another model than the post that it checks.

    The two seats have different model families, as the person stated them or as their harnesses' entries have
    them. Nobody knows the model of an invited agent whose family the person did not state, so such an agent's
    model is never known to differ.

    The record also holds the model that a harness reported for each turn, as that harness's own ID. Two seats of
    one harness can state two families and still run one model. So when both seats have the same harness, and the
    record has the model of the turn that wrote the post and of the turn that wrote the check, those two models
    differ too. The IDs of two harnesses do not compare, and a record from before Verifold kept the model of a
    turn has none, so there the families decide.
    """
    author, checker = board.agent(post.post.author), board.agent(checker_id)
    if author is None or checker is None or author is checker or not other_family(author.agent, checker.agent):
        return False
    wrote, checked = _model_at(board, author.agent.id, post.seq), _model_at(board, checker_id, seq)
    one_harness = author.agent.harness == checker.agent.harness
    return not (one_harness and wrote and checked and wrote.casefold() == checked.casefold())


def other_family(author: Agent, checker: Agent) -> bool:
    """Return whether two seats have different model families. A family that nobody knows differs from none."""
    unknown = (GUEST, UNKNOWN_FAMILY)
    if unknown in ((author.harness, author.model.family), (checker.harness, checker.model.family)):
        return False
    return not same_family(checker.model.family, author.model.family)


def _model_at(board: Board, agent_id: AgentId, seq: int) -> str | None:
    # The model that the agent's harness reported for the turn that ran at event `seq`, or `None`.
    turn = next((start for start in reversed(board.starts) if start.agent == agent_id and start.seq < seq), None)
    return turn.model if turn else None


def _conceded(board: Board, objection: Objection) -> bool:
    return any(isinstance(entry.post, Answer) and entry.post.accepts for entry in board.replies(objection.id))


def _overruled(objection_seq: int, objection: Objection, checks: tuple[tuple[int, Check], ...]) -> bool:
    return any(
        seq > objection_seq and check.outcome == 'holds' and check.author != objection.author for seq, check in checks
    )


def candidates(board: Board) -> tuple[Posted, ...]:
    """
    Return the candidate answers that stand, oldest first: the newest proposal of each author, unless its author conceded it.

    A side thread takes no proposal, and a proposal there in a record from before that rule is no candidate.
    `society.candidates` says what a candidate is. This function is here because a close stands only while the
    candidate that it names stands.
    """
    newest = {
        entry.post.author: entry
        for entry in board.posts
        if isinstance(entry.post, Proposal) and not board.is_side(entry.post.thread)
    }
    return tuple(
        entry
        for entry in sorted(newest.values(), key=lambda entry: entry.seq)
        if standing(board, entry.post.id) != 'conceded'
    )


def closing(board: Board) -> Posted | None:
    """
    Return the post that says that the lab is done, when one stands: the newest close.

    It stands until an objection to it stands, its author concedes one, its author withdraws it with a ruled-out
    lead that replies to it, the person posts to the lab after it, or the person asks for changes to an offer of
    files for a deliverable after it. A close that names a candidate also stands only while that candidate stands,
    so a newer proposal of the candidate's author, or its author's concession, ends the close too. A close from
    before closes named a candidate names none, and this rule leaves it as it was. An older close does not come back.
    """
    entry = next((entry for entry in reversed(board.posts) if isinstance(entry.post, Close)), None)
    if entry is None or standing(board, entry.post.id) in {'disputed', 'conceded'}:
        return None
    named = entry.post.candidate if isinstance(entry.post, Close) else None
    if named and all(candidate.post.id != named for candidate in candidates(board)):
        return None
    withdrawn = any(
        isinstance(reply.post, RuledOut) and reply.post.author == entry.post.author
        for reply in board.replies(entry.post.id)
    )
    # The person's new words to the lab open it again: the agents have something to do. Words in a side thread
    # reach only its members, words in the conversation reach the coordinator, and words in the desk chat reach
    # the desk, so they are not words to the lab.
    steered = any(
        later.post.author == PERSON
        and later.post.reply_to is None
        and later.seq > entry.seq
        and not board.is_side(later.post.thread)
        and later.post.thread not in (board.conversation, board.desk_chat)
        and not _for_listeners(board, later)
        for later in board.posts
    )
    # The person's request for changes to an offer of files asks its author for more work.
    asked = any(decided.decision == 'changes_asked' and decided.seq > entry.seq for decided in board.decisions)
    return None if withdrawn or steered or asked else entry


def _for_listeners(board: Board, said: Posted) -> bool:
    # The person's words in the thread of a deliverable's offers are words to the lab only when they reach the
    # whole lab: they name nobody, and no agent that offered files there or watches the thread was in the lab.
    if not board.holds_offers(said.post.thread):
        return False
    return bool(said.post.mentions or board.offer_listeners(said.post.thread, said.seq))


def disputes(board: Board, post_id: PostId) -> tuple[Posted, ...]:
    """
    Return the replies that dispute a post now, oldest first: each failed check and each objection that stands.

    A reply that its own author conceded disputes nothing, and neither does an objection that a later check
    overruled.
    """
    replies = tuple(entry for entry in board.replies(post_id) if standing(board, entry.post.id) != 'conceded')
    checks = tuple((entry.seq, entry.post) for entry in replies if isinstance(entry.post, Check))
    return tuple(
        entry
        for entry in replies
        if (isinstance(entry.post, Check) and entry.post.outcome == 'fails')
        or (isinstance(entry.post, Objection) and not _overruled(entry.seq, entry.post, checks))
    )


def conceded_to(board: Board, post_id: PostId) -> PostId | None:
    """Return the objection to a post that the post's author accepted, or `None`."""
    return next(
        (
            entry.post.id
            for entry in board.replies(post_id)
            if isinstance(entry.post, Objection)
            and standing(board, entry.post.id) != 'conceded'
            and _conceded(board, entry.post)
        ),
        None,
    )


def agreed(board: Board, close: Posted) -> tuple[AgentId, ...]:
    """
    Return the agents of the lab that agreed with a close, each once, in the order that they agreed.

    An agent that left the lab after it agreed is still among them: the word that it gave is kept.
    """
    workers = {joined.agent.id for joined in board.agents if not joined.agent.checks}
    return tuple(
        dict.fromkeys(
            reply.post.author
            for reply in board.replies(close.post.id)
            if isinstance(reply.post, Answer)
            and reply.post.accepts
            # An agent takes its agreement back when it concedes an objection to it.
            and standing(board, reply.post.id) not in {'conceded', 'disputed'}
            and reply.post.author in workers
            and reply.post.author != close.post.author
        )
    )
