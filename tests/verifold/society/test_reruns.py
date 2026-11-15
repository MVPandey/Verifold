from datetime import timedelta

import pytest
from builders import START, RecordBuilder, lab

from verifold.protocol.posts import Check, FileEvidence, Message, Objection, Result
from verifold.society.attention import news, update
from verifold.society.errors import RejectedEvent
from verifold.society.reruns import MAX_RERUNS, can_take, rerun_checks, rerun_line, reruns_wanted, wanted_reruns
from verifold.society.standing import standing

EVIDENCE = (FileEvidence(path='bench.json', commit='c' * 40),)
RESULT = Result(id='p-1', thread='t-1', author='ada', text='sorted() is 11.8x faster.', evidence=EVIDENCE)
RERUN_FILES = (FileEvidence(path='rerun.json', commit='d' * 40),)


def rerun_check(author: str, outcome: str = 'holds', method: str = 'rerun', take: int | None = None) -> Check:
    return Check.model_validate(
        {
            'id': 'p-2',
            'thread': 't-1',
            'author': author,
            'text': 'Reran it.',
            'reply_to': 'p-1',
            'outcome': outcome,
            'method': method,
            'take': take,
            'evidence': RERUN_FILES if take else (),
        }
    )


def wanted() -> RecordBuilder:
    """The lab with ada's result and bo's request for a rerun of it. The lab has three agents and no reviewer seats."""
    return lab().reviewer_seats(0).post(RESULT).rerun('bo', 'p-1')


def taken_by(agent: str = 'cy', outcome: str = 'holds') -> RecordBuilder:
    """The same lab after `agent` took the rerun and posted its check from the clean copy."""
    record = wanted().take(agent, 'p-1')
    return record.post(rerun_check(agent, outcome, take=len(record.events)))


def test_a_request_starts_nothing_and_stays_wanted_until_a_check_from_a_clean_copy_answers_it() -> None:
    record = wanted()
    board = record.board()

    # The request adds one event, and no agent joins for it.
    assert [agent.agent.id for agent in board.agents] == ['ada', 'bo', 'cy']
    line = rerun_line(board, 'p-1')
    assert line is not None
    assert (line.thread, line.asked_by, line.asked_at, line.taken_by) == ('t-1', ('bo',), record.at(8), ())
    assert reruns_wanted(board) == (line,)

    # A check by a code read, and a rerun that is not from a clean copy, answer no request.
    record.post(rerun_check('cy'))
    assert [entry.by for entry in wanted_reruns(record.board(), 'p-1')] == ['bo']
    assert standing(record.board(), 'p-1') == 'checked'


def test_an_agent_takes_a_wanted_rerun_and_its_check_from_the_clean_copy_answers_every_request() -> None:
    record = wanted().rerun('person', 'p-1').take('cy', 'p-1')
    line = rerun_line(record.board(), 'p-1')
    assert line is not None
    assert (line.asked_by, line.taken_by) == (('bo', 'person'), ('cy',))

    record.post(rerun_check('cy', take=len(record.events)))

    board = record.board()
    assert wanted_reruns(board, 'p-1') == ()
    assert reruns_wanted(board) == ()
    assert [entry.post.author for entry in rerun_checks(board, 'p-1')] == ['cy']
    assert standing(board, 'p-1') == 'held_up'


def test_the_author_cannot_take_the_rerun_of_its_own_post() -> None:
    with pytest.raises(RejectedEvent, match=r'p-1 is your own\. Another agent takes its rerun'):
        wanted().take('ada', 'p-1').board()
    assert not can_take(wanted().board(), 'ada', 'p-1')


def test_a_take_needs_a_wanted_rerun_an_agent_of_the_lab_and_the_commit_that_the_post_pins() -> None:
    with pytest.raises(RejectedEvent, match='No rerun of post p-1 is wanted now'):
        lab().post(RESULT).take('cy', 'p-1').board()
    with pytest.raises(RejectedEvent, match='No rerun of post p-1 is wanted now'):
        taken_by('cy').take('bo', 'p-1').board()
    with pytest.raises(RejectedEvent, match='p-9 does not exist'):
        wanted().take('cy', 'p-9').board()
    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        wanted().take('zed', 'p-1').board()
    with pytest.raises(RejectedEvent, match='cy left this lab'):
        wanted().leave('cy').take('cy', 'p-1').board()
    with pytest.raises(RejectedEvent, match='cy took the rerun of post p-1 already'):
        wanted().take('cy', 'p-1').take('cy', 'p-1').board()
    with pytest.raises(RejectedEvent, match='pins no file to the commit'):
        wanted().take('cy', 'p-1', commit='e' * 40).board()


def test_several_agents_can_take_one_rerun_and_a_taker_that_left_shows_no_longer() -> None:
    record = wanted().take('cy', 'p-1').take('bo', 'p-1')
    line = rerun_line(record.board(), 'p-1')
    assert line is not None
    assert line.taken_by == ('cy', 'bo')

    gone = rerun_line(record.leave('cy').board(), 'p-1')
    assert gone is not None
    assert gone.taken_by == ('bo',)


def test_only_verifold_marks_a_check_as_one_from_a_clean_copy() -> None:
    # The mark names the author's own take of the same post, on a rerun with files.
    for check in (
        rerun_check('cy', take=3),
        rerun_check('bo', take=9),
        rerun_check('cy', method='code_read', take=9),
        rerun_check('cy', take=9).model_copy(update={'evidence': ()}),
    ):
        with pytest.raises(RejectedEvent, match='is not the take with which'):
            wanted().take('cy', 'p-1').post(check).board()


@pytest.mark.parametrize(
    ('checker', 'outcome', 'expected'),
    [('cy', 'holds', 'held_up'), ('bo', 'holds', 'checked'), ('cy', 'fails', 'disputed')],
)
def test_a_rerun_from_a_clean_copy_holds_a_post_up_only_from_another_family(
    checker: str, outcome: str, expected: str
) -> None:
    # ada and bo have one model family, and cy has another.
    assert standing(taken_by(checker, outcome).board(), 'p-1') == expected


def test_another_model_goes_by_the_model_that_a_harness_reported_for_each_turn() -> None:
    def checked(wrote: str | None, checks: str | None, checker_harness: str = 'fake') -> str:
        # ada's seat states one family and dee's another. Each turn records the model that its harness reported.
        record = lab().reviewer_seats(0).join('dee', family='openai', harness=checker_harness)
        record.start('ada', seen=0, model='older').turn('ada')
        record.start('ada', seen=0, model=wrote).post(RESULT).rerun('bo', 'p-1')
        record.start('dee', seen=0, model=checks).take('dee', 'p-1')
        return standing(record.post(rerun_check('dee', take=len(record.events))).board(), 'p-1')

    assert checked('opus-5', 'gpt-6') == 'held_up'
    # Two seats of one harness that ran one model are one model, whatever families the seats state.
    assert checked('opus-5', 'Opus-5') == 'checked'
    # The turn in which the post was written counts, and not an earlier turn of its author.
    assert checked('opus-5', 'older') == 'held_up'
    # The IDs of two harnesses do not compare: each can call its own model "default".
    assert checked('default', 'default', checker_harness='other') == 'held_up'
    # A record without the model of a turn has only the seats' families.
    assert checked(None, 'gpt-6') == 'held_up'
    assert checked('opus-5', None) == 'held_up'


def test_a_rerun_by_or_of_an_invited_agent_counts_only_with_a_stated_family() -> None:
    def checked(author_family: str, checker_family: str) -> str:
        record = RecordBuilder().join('ada', family=author_family, harness='guest')
        record.join('cy', family=checker_family, harness='guest').thread('t-1', opened_by='ada')
        record.post(RESULT).rerun('ada', 'p-1').take('cy', 'p-1')
        return standing(record.post(rerun_check('cy', take=len(record.events))).board(), 'p-1')

    assert checked('anthropic', 'openai') == 'held_up'
    assert checked('unknown', 'openai') == 'checked'
    assert checked('anthropic', 'unknown') == 'checked'


def test_a_request_reaches_the_agents_that_can_take_it() -> None:
    def hears(record: RecordBuilder, agent: str) -> bool:
        board = record.board()
        heard = news(board, agent, 0).reruns
        assert update(board, agent, 0).reruns == heard
        return [line.post for line in heard] == ['p-1']

    # Without reviewer seats, every agent hears it but the post's author and the agent that asked.
    assert [hears(wanted(), agent) for agent in ('ada', 'bo', 'cy')] == [False, False, True]
    # The person's request reaches every agent but the author.
    by_person = lab().reviewer_seats(0).post(RESULT).rerun('person', 'p-1')
    assert [hears(by_person, agent) for agent in ('ada', 'bo', 'cy')] == [False, True, True]
    # With reviewer seats, it reaches their holders.
    seated = lab().reviewer_seats(1).reviewer('bo', 'person').post(RESULT).rerun('ada', 'p-1')
    assert [hears(seated, agent) for agent in ('ada', 'bo', 'cy')] == [False, True, False]
    assert can_take(seated.board(), 'bo', 'p-1')
    assert not can_take(seated.board(), 'cy', 'p-1')
    # An on-call agent hears no request, as it hears no call that names nobody. It can still take the rerun.
    on_call = wanted().on_call('cy')
    assert not hears(on_call, 'cy')
    assert can_take(on_call.board(), 'cy', 'p-1')
    # A request that an agent has read, a rerun that it took, and one that a check answered are no news.
    assert news(wanted().board(), 'cy', 8).reruns == ()
    assert not hears(wanted().take('cy', 'p-1'), 'cy')
    assert not hears(taken_by('cy'), 'bo')


def test_a_rerun_that_nobody_takes_stays_wanted_and_nothing_else_happens() -> None:
    record = wanted()
    events = len(record.events)
    record.post(Message(id='p-2', thread='t-1', author='ada', text='Still here.'))

    line = rerun_line(record.board(), 'p-1')
    assert line is not None
    # The line keeps the time of the request, so a reader sees how long it has waited.
    assert line.asked_at == START + timedelta(minutes=events - 1)
    assert line.taken_by == ()
    assert len(record.events) == events + 1


def test_a_post_takes_requests_until_two_agents_posted_the_check_of_an_independent_rerun() -> None:
    record = taken_by('cy').rerun('ada', 'p-1').take('bo', 'p-1')
    record.post(rerun_check('bo', take=len(record.events)).model_copy(update={'id': 'p-3'}))

    assert len(rerun_checks(record.board(), 'p-1')) == MAX_RERUNS
    with pytest.raises(RejectedEvent, match='has the checks of 2 independent reruns already'):
        record.rerun('person', 'p-1').board()


def test_one_agent_is_one_rerun_however_many_checks_it_posts() -> None:
    record = taken_by('cy').rerun('ada', 'p-1')
    record.post(rerun_check('cy', take=9).model_copy(update={'id': 'p-3'}))

    # The second check of the same agent answers no new request.
    assert [entry.post.id for entry in rerun_checks(record.board(), 'p-1')] == ['p-2']
    assert [entry.by for entry in wanted_reruns(record.board(), 'p-1')] == ['ada']


def checked_by(family: str, outcome: str = 'holds', method: str = 'rerun') -> RecordBuilder:
    """A record from before agents took reruns: Verifold started the checker dee for bo's request."""
    return (
        lab()
        .post(RESULT)
        .rerun('bo', 'p-1')
        .join('dee', family=family, checks='p-1')
        .post(rerun_check('dee', outcome, method))
    )


def test_in_an_old_record_a_checkers_rerun_from_another_family_still_holds_the_post_up() -> None:
    assert standing(checked_by('openai').board(), 'p-1') == 'held_up'


@pytest.mark.parametrize(
    ('family', 'outcome', 'method', 'expected'),
    [
        ('anthropic', 'holds', 'rerun', 'checked'),
        ('openai', 'holds', 'code_read', 'checked'),
        ('openai', 'fails', 'rerun', 'disputed'),
    ],
)
def test_in_an_old_record_only_a_checkers_rerun_that_holds_counts(
    family: str, outcome: str, method: str, expected: str
) -> None:
    assert standing(checked_by(family, outcome, method).board(), 'p-1') == expected


def test_a_blind_rerun_never_holds_up_the_post_of_an_invited_agent_whose_model_nobody_knows() -> None:
    record = lab().join('guest', family='unknown', harness='guest')
    record.post(RESULT.model_copy(update={'author': 'guest'})).rerun('bo', 'p-1')
    record.join('dee', family='openai', checks='p-1').post(rerun_check('dee'))

    assert standing(record.board(), 'p-1') == 'checked'


def test_a_harness_of_the_person_whose_family_is_called_unknown_is_no_invited_agent() -> None:
    record = lab().join('own', family='unknown', harness='my-harness')
    record.post(RESULT.model_copy(update={'author': 'own'})).rerun('bo', 'p-1')
    record.join('dee', family='openai', checks='p-1').post(rerun_check('dee'))

    assert standing(record.board(), 'p-1') == 'held_up'


def test_a_standing_objection_outweighs_a_held_up_rerun() -> None:
    record = checked_by('openai').post(
        Objection(id='p-3', thread='t-1', author='cy', text='The data has ties.', reply_to='p-1')
    )

    assert standing(record.board(), 'p-1') == 'disputed'


def test_a_rerun_needs_a_post_with_files_and_a_member_of_the_lab() -> None:
    no_files = Result(id='p-1', thread='t-1', author='ada', text='Faster.')

    with pytest.raises(RejectedEvent, match='no files as evidence'):
        lab().post(no_files).rerun('bo', 'p-1').board()
    with pytest.raises(RejectedEvent, match='p-9 does not exist'):
        lab().rerun('bo', 'p-9').board()
    with pytest.raises(RejectedEvent, match='zed is not an agent'):
        lab().post(RESULT).rerun('zed', 'p-1').board()


def test_a_request_while_a_rerun_runs_joins_it_and_one_check_answers_both() -> None:
    record = lab().post(RESULT).rerun('bo', 'p-1').rerun('cy', 'p-1')

    assert [entry.by for entry in wanted_reruns(record.board(), 'p-1')] == ['bo', 'cy']
    # A record from before the lab refused double requests still loads.
    assert len(lab().post(RESULT).rerun('bo', 'p-1').rerun('bo', 'p-1').board().reruns) == 2

    record.join('dee', family='openai', checks='p-1').post(rerun_check('dee'))

    assert wanted_reruns(record.board(), 'p-1') == ()
    assert [entry.post.author for entry in rerun_checks(record.board(), 'p-1')] == ['dee']


def test_a_post_gets_at_most_two_blind_reruns_and_other_checks_do_not_count() -> None:
    record = lab().post(RESULT).rerun('bo', 'p-1').rerun('cy', 'p-1').rerun('person', 'p-1')
    record.join('dee', family='openai', checks='p-1').post(rerun_check('dee'))
    record.post(rerun_check('cy').model_copy(update={'id': 'p-3'}))
    # One blind rerun answered three requests, and cy's own check is not blind, so the post can get one more.
    record.rerun('bo', 'p-1').join('eve', family='openai', checks='p-1')
    record.post(rerun_check('eve').model_copy(update={'id': 'p-4'}))

    assert len(rerun_checks(record.board(), 'p-1')) == MAX_RERUNS
    with pytest.raises(RejectedEvent, match='has the checks of 2 independent reruns already'):
        record.rerun('cy', 'p-1').board()


def test_a_blind_checker_posts_only_its_check() -> None:
    record = lab().post(RESULT).join('dee', family='openai', checks='p-1')

    with pytest.raises(RejectedEvent, match='Post one check that replies to p-1'):
        record.post(Message(id='p-2', thread='t-1', author='dee', text='Hi.')).board()


def test_a_checker_needs_an_existing_post() -> None:
    with pytest.raises(RejectedEvent, match='p-9 does not exist'):
        lab().join('dee', checks='p-9').board()


def test_one_checker_is_one_blind_rerun_however_many_checks_it_posts() -> None:
    record = lab().post(RESULT).rerun('bo', 'p-1').join('dee', family='openai', checks='p-1')
    record.post(rerun_check('dee')).post(rerun_check('dee').model_copy(update={'id': 'p-3'}))

    assert [entry.post.id for entry in rerun_checks(record.board(), 'p-1')] == ['p-2']
    # The checker's second check uses up no rerun, so the post can get another one.
    assert len(record.rerun('cy', 'p-1').board().reruns) == 2


def test_a_failed_rerun_frees_the_requests_before_it() -> None:
    record = lab().post(RESULT).rerun('bo', 'p-1').join('dee', family='openai', checks='p-1')
    waiting = [entry.by for entry in wanted_reruns(record.board(), 'p-1')]
    record.turn('dee', error='The checker stopped without a check.', rerun_failed=True)

    assert waiting == ['bo']
    assert wanted_reruns(record.board(), 'p-1') == ()


def test_a_failed_turn_that_does_not_end_the_rerun_frees_no_request() -> None:
    record = lab().post(RESULT).rerun('bo', 'p-1').join('dee', family='openai', checks='p-1')
    # The time limit cancelled the checker's turn. The same checker goes on when the lab gets more time.
    record.turn('dee', error='The lab ran out of time, so Verifold cancelled the turn.')

    assert [entry.by for entry in wanted_reruns(record.board(), 'p-1')] == ['bo']


def test_only_a_blind_checkers_turn_can_end_a_rerun() -> None:
    with pytest.raises(RejectedEvent, match='ada is not a blind checker'):
        lab().post(RESULT).turn('ada', error='It crashed.', rerun_failed=True).board()
