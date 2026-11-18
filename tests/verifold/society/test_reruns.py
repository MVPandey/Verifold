from datetime import timedelta

import pytest
from builders import START, RecordBuilder, lab

from verifold.protocol.events import RerunTaken
from verifold.protocol.join import LeaseLine, News
from verifold.protocol.posts import Answer, Check, Close, FileEvidence, Message, Objection, Result
from verifold.protocol.settings import RerunSettings, ReviewerSettings, Settings
from verifold.society.attention import news, update
from verifold.society.errors import RejectedEvent
from verifold.society.reruns import (
    COPY_MINUTES,
    MAX_RERUNS,
    can_take,
    copy_kept_until,
    kept_until,
    lease_of,
    lease_refusal,
    leases,
    open_to,
    rerun_checks,
    rerun_line,
    reruns_wanted,
    told_of,
    wanted_reruns,
)
from verifold.society.standing import standing
from verifold.society.views import brief

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


def test_a_record_from_before_the_leases_with_two_takes_of_one_rerun_loads_and_each_take_holds_its_own_lease() -> None:
    # The record's rules leave the lease to the server, so such a record folds as it was written.
    record = wanted().take('cy', 'p-1').take('bo', 'p-1')
    board = record.board()
    line = rerun_line(board, 'p-1', record.at(10))
    assert line is not None
    assert line.taken_by == ('cy', 'bo')
    assert line.held_by == (
        LeaseLine(agent='cy', since=record.at(9), until=record.at(19)),
        LeaseLine(agent='bo', since=record.at(10), until=record.at(20)),
    )
    # Each lease ends ten minutes after its take, so a lab that resumes later has no holder.
    assert [lease.agent for lease in leases(board, 'p-1', record.at(19))] == ['bo']
    assert leases(board, 'p-1', record.at(20)) == ()

    gone = rerun_line(record.leave('cy').board(), 'p-1', record.at(10))
    assert gone is not None
    assert (gone.taken_by, [lease.agent for lease in gone.held_by]) == (('bo',), ['bo'])


def minutes_pass(record: RecordBuilder, minutes: int) -> RecordBuilder:
    # The builder dates one event a minute, so a watch of ada's moves the time and nothing else for a rerun.
    for _ in range(minutes):
        record.watch('ada', 't-1')
    return record


def test_a_take_holds_a_lease_that_a_renewal_moves_and_that_ends_at_its_time_its_give_up_its_check_and_a_leave() -> (
    None
):
    record = wanted().take('bo', 'p-1')
    taken = record.at(9)
    board = record.board()

    assert lease_of(board, 'bo', 'p-1', taken) == LeaseLine(
        agent='bo', since=taken, until=taken + timedelta(minutes=10)
    )
    assert lease_of(board, 'bo', 'p-1', taken + timedelta(minutes=10)) is None
    # A renewal while the lease stands keeps when it began and moves its end.
    renewed = record.copy().lease('bo', 'p-1').board()
    assert lease_of(renewed, 'bo', 'p-1', record.at(10)) == LeaseLine(
        agent='bo', since=taken, until=record.at(10) + timedelta(minutes=10)
    )
    # A give-up ends it at once.
    given = record.copy().lease('bo', 'p-1', held=False)
    assert lease_of(given.board(), 'bo', 'p-1', record.at(10)) is None
    # A renewal after a give-up, or after the lease ran out, starts a new lease.
    again = given.copy().lease('bo', 'p-1')
    assert lease_of(again.board(), 'bo', 'p-1', again.at(11)) == LeaseLine(
        agent='bo', since=again.at(11), until=again.at(21)
    )
    late = minutes_pass(record.copy(), 10).lease('bo', 'p-1')
    assert lease_of(late.board(), 'bo', 'p-1', late.at(20)) == LeaseLine(
        agent='bo', since=late.at(20), until=late.at(30)
    )
    # The check of the take ends it, and so does a leave.
    checked = record.copy().post(rerun_check('bo', take=9)).board()
    assert lease_of(checked, 'bo', 'p-1', taken) is None
    assert lease_of(record.copy().leave('bo').board(), 'bo', 'p-1', taken) is None
    # A lab whose lease is zero minutes gives no lease.
    none = wanted().settings(Settings(reviewers=ReviewerSettings(seats=0), reruns=RerunSettings(lease_minutes=0)))
    assert lease_of(none.take('bo', 'p-1').board(), 'bo', 'p-1', none.at(10)) is None
    # A record from before the setting has the default of ten minutes.
    assert board.settings.reruns.lease_minutes == 10


def test_the_record_takes_a_renewal_and_a_give_up_only_from_a_taker_whose_take_waits_for_its_check() -> None:
    with pytest.raises(RejectedEvent, match='You did not take the rerun of post p-1, or you posted the check'):
        wanted().lease('cy', 'p-1').board()
    with pytest.raises(RejectedEvent, match='You did not take the rerun of post p-1, or you posted the check'):
        wanted().take('bo', 'p-1').post(rerun_check('bo', take=9)).lease('bo', 'p-1').board()
    with pytest.raises(RejectedEvent, match='bo left this lab'):
        wanted().take('bo', 'p-1').leave('bo').lease('bo', 'p-1', held=False).board()
    with pytest.raises(RejectedEvent, match='You hold no lease on the rerun of post p-1, so there is none to give up'):
        wanted().take('bo', 'p-1').lease('bo', 'p-1', held=False).lease('bo', 'p-1', held=False).board()
    with pytest.raises(RejectedEvent, match='You hold no lease on the rerun of post p-1'):
        minutes_pass(wanted().take('bo', 'p-1'), 10).lease('bo', 'p-1', held=False).board()
    with pytest.raises(RejectedEvent, match='dan is not an agent in this lab'):
        wanted().lease('dan', 'p-1').board()


def test_a_lease_keeps_every_other_agent_out_but_one_of_another_family_while_no_holder_is_of_another_family() -> None:
    # ada, bo, and dee have one model family, and cy and eve have another. gus is invited, and nobody knows its family.
    record = wanted().join('dee').join('eve', family='openai').join('gus', family='unknown', harness='guest')
    bo_holds = record.copy().take('bo', 'p-1')
    now = bo_holds.at(12)
    board = bo_holds.board()

    assert lease_refusal(board, 'dee', 'p-1', now) == (
        'bo holds the rerun of post p-1 since 2026-11-06 12:11 UTC, until 2026-11-06 12:21 UTC. The board takes no '
        'take of the rerun from you while that lease stands.'
    )
    assert lease_refusal(board, 'gus', 'p-1', now) is not None
    # bo's check cannot make the post stand as held up, so an agent of another family can take the rerun too.
    assert lease_refusal(board, 'cy', 'p-1', now) is None
    assert lease_refusal(board, 'bo', 'p-1', now) is None
    both = bo_holds.copy().take('cy', 'p-1')
    board = both.board()
    later = both.at(13)
    assert [lease.agent for lease in leases(board, 'p-1', later)] == ['bo', 'cy']
    # Then cy's lease keeps eve out, and both leases keep dee out.
    eve = lease_refusal(board, 'eve', 'p-1', later)
    assert eve is not None
    assert eve.startswith('cy holds')
    assert 'bo holds' not in eve
    dee = lease_refusal(board, 'dee', 'p-1', later)
    assert dee is not None
    assert (dee.startswith('bo holds'), 'cy holds' in dee, dee.endswith('while one of those leases stands.')) == (
        True,
        True,
        True,
    )
    # A holder of another family keeps out every other agent.
    cy_holds = record.copy().take('cy', 'p-1').board()
    assert all(lease_refusal(cy_holds, agent, 'p-1', now) for agent in ('bo', 'dee', 'eve', 'gus'))
    # An invited holder whose family nobody knows keeps out every agent but one of a known other family.
    gus_holds = record.copy().take('gus', 'p-1').board()
    assert (lease_refusal(gus_holds, 'cy', 'p-1', now), bool(lease_refusal(gus_holds, 'bo', 'p-1', now))) == (
        None,
        True,
    )
    # Without a lease, nothing keeps an agent out.
    assert lease_refusal(record.board(), 'dee', 'p-1', now) is None


def test_a_lease_keeps_the_minutes_of_its_moment_and_a_lease_that_ended_stays_ended() -> None:
    record = wanted().take('bo', 'p-1')
    taken = record.at(9)
    # The person sets a lease of ten hours after bo's lease ended at its time.
    later = minutes_pass(record.copy(), 15).settings(
        Settings(reviewers=ReviewerSettings(seats=0), reruns=RerunSettings(lease_minutes=600))
    )
    board = later.board()

    assert lease_of(board, 'bo', 'p-1', later.at(26)) is None
    # A renewal after the change holds the new minutes. A lease from before keeps its own.
    renewed = later.copy().lease('bo', 'p-1')
    assert lease_of(renewed.board(), 'bo', 'p-1', renewed.at(26)) == LeaseLine(
        agent='bo', since=renewed.at(26), until=renewed.at(26) + timedelta(minutes=600)
    )
    early = record.copy().settings(
        Settings(reviewers=ReviewerSettings(seats=0), reruns=RerunSettings(lease_minutes=600))
    )
    assert lease_of(early.board(), 'bo', 'p-1', early.at(11)) == LeaseLine(
        agent='bo', since=taken, until=taken + timedelta(minutes=10)
    )


def test_a_settled_rerun_has_no_lease_and_a_take_before_its_check_starts_none_after_it() -> None:
    # cy's check settles the rerun while bo holds a lease on it too.
    record = wanted().take('bo', 'p-1').take('cy', 'p-1')
    record.post(rerun_check('cy', take=10))
    board = record.board()

    assert (lease_of(board, 'bo', 'p-1', record.at(11)), leases(board, 'p-1', record.at(11))) == (None, ())
    # A new request makes the rerun wanted again. bo's take from before the check holds no lease, and its renewal
    # starts one.
    again = record.copy().rerun('person', 'p-1')
    assert lease_of(again.board(), 'bo', 'p-1', again.at(12)) is None
    renewed = again.copy().lease('bo', 'p-1')
    assert lease_of(renewed.board(), 'bo', 'p-1', renewed.at(13)) == LeaseLine(
        agent='bo', since=renewed.at(13), until=renewed.at(23)
    )


def test_an_event_dated_after_now_starts_no_lease() -> None:
    record = wanted()
    # A take that an edit dated an hour ahead, as from a clock that jumped.
    record.events.append(
        RerunTaken(seq=9, at=record.at(9) + timedelta(hours=1), agent='bo', post='p-1', commit='c' * 40)
    )
    board = record.board()

    assert leases(board, 'p-1', record.at(10)) == ()
    assert lease_refusal(board, 'dee', 'p-1', record.at(10)) is None
    assert lease_of(board, 'bo', 'p-1', record.at(9) + timedelta(hours=1)) is not None


def test_the_record_refuses_a_renewal_that_another_agents_lease_keeps_out() -> None:
    # bo's lease ran out, and dee took the rerun. bo's take stands, and its renewal is refused while dee holds it.
    record = minutes_pass(wanted().join('dee').take('bo', 'p-1'), 10).take('dee', 'p-1')

    with pytest.raises(RejectedEvent, match=r'dee holds the rerun of post p-1 .* renews no lease of yours'):
        record.copy().lease('bo', 'p-1').board()
    # cy is of another family, so dee's lease does not keep cy out.
    assert record.copy().take('cy', 'p-1').lease('cy', 'p-1').board().leases[-1].agent == 'cy'


def test_a_rerun_that_a_lease_keeps_from_an_agent_is_no_news_for_it_until_the_lease_ends() -> None:
    # One reviewer seat, held by bo. ada, bo, and dee have the post's family, and cy has another.
    record = lab().join('dee').reviewer('bo').post(RESULT).rerun('ada', 'p-1')
    asked = len(record.events)
    record.take('bo', 'p-1')
    board = record.board()
    now = record.at(len(record.events))

    # bo's take opens the rerun to every agent, and bo's lease keeps dee out. dee hears nothing, and cy hears it.
    assert open_to(board, 'p-1', now) == 'any'
    assert news(board, 'dee', asked, now).reruns == ()
    assert [line.post for line in news(board, 'cy', asked, now).reruns] == ['p-1']
    assert (can_take(board, 'dee', 'p-1', now), can_take(board, 'cy', 'p-1', now)) == (False, True)
    assert kept_until(board, 'dee', now) == record.at(asked + 1) + timedelta(minutes=10)
    assert kept_until(board, 'cy', now) is None
    # The lease ends at its time without a check: then dee hears of the rerun, once.
    ended = record.at(asked + 1) + timedelta(minutes=10)
    freed = update(board, 'dee', board.seq, ended)
    assert [line.post for line in freed.reruns] == ['p-1']
    assert update(board, 'dee', board.seq, ended, told=told_of(board, freed.reruns)).reruns == ()
    # A give-up ends it at once, and so does bo's leave.
    for gone in (record.copy().lease('bo', 'p-1', held=False), record.copy().leave('bo')):
        after = gone.board()
        assert [line.post for line in news(after, 'dee', board.seq, gone.at(len(gone.events))).reruns] == ['p-1']
    # dee was told of the rerun. cy takes it after bo's lease ended, and the end of cy's lease tells dee nothing,
    # and sets dee no time to wake.
    dee_told = told_of(board, freed.reruns)
    later = minutes_pass(record.copy(), 10).take('cy', 'p-1')
    taken = later.at(len(later.events))
    assert kept_until(later.board(), 'dee', taken, dee_told) is None
    assert kept_until(later.board(), 'dee', taken) == taken + timedelta(minutes=10)
    lapsed = taken + timedelta(minutes=10)
    assert news(later.board(), 'dee', board.seq, lapsed, told=dee_told).reruns == ()
    # A seat that starts without the memory, as after a restart, tells it once more, and never not.
    assert [line.post for line in news(later.board(), 'dee', board.seq, lapsed).reruns] == ['p-1']


def test_a_reviewer_that_a_lease_keeps_out_leaves_the_rerun_open_to_another_family() -> None:
    # Two reviewer seats, held by bo and dee, both of the post's family. cy has another family and no seat.
    record = lab().reviewer_seats(2).join('dee').reviewer('bo').reviewer('dee').post(RESULT).rerun('ada', 'p-1')
    before_take = record.board()
    now = record.at(len(record.events))
    assert open_to(before_take, 'p-1', now) == 'reviewer'
    record.take('bo', 'p-1')
    board = record.board()
    now = record.at(len(record.events))

    # bo's lease keeps dee out, so no agent in a reviewer seat can take the rerun, and cy can.
    assert open_to(board, 'p-1', now) == 'any'
    assert (can_take(board, 'dee', 'p-1', now), can_take(board, 'cy', 'p-1', now)) == (False, True)


def test_the_brief_shows_who_holds_each_wanted_rerun_and_until_when() -> None:
    record = wanted().take('bo', 'p-1')
    board = record.board()

    (line,) = brief(board, 'cy', News(seq=0), now=record.at(10)).reruns_wanted
    assert (line.taken_by, line.held_by) == (('bo',), (LeaseLine(agent='bo', since=record.at(9), until=record.at(19)),))
    # After the lease, the take still shows and no lease does.
    (after,) = brief(board, 'cy', News(seq=0), now=record.at(19)).reruns_wanted
    assert (after.taken_by, after.held_by) == (('bo',), ())
    # The rerun leaves the list when the check that settles it replies to the post.
    assert brief(record.post(rerun_check('bo', take=9)).board(), 'cy', News(seq=0)).reruns_wanted == ()


def test_only_verifold_marks_a_check_as_the_one_check_of_a_take() -> None:
    # The mark names the author's own take of the same post, on a rerun with files.
    for check in (
        rerun_check('cy', take=3),
        rerun_check('bo', take=9),
        rerun_check('cy', method='code_read', take=9),
        rerun_check('cy', take=9).model_copy(update={'evidence': ()}),
    ):
        with pytest.raises(RejectedEvent, match='is not a take of'):
            wanted().take('cy', 'p-1').post(check).board()
    # One take has one such check.
    with pytest.raises(RejectedEvent, match='is not a take of cy for p-1 that has no check yet'):
        taken_by('cy').post(rerun_check('cy', take=9).model_copy(update={'id': 'p-3'})).board()


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
    board = wanted().board()
    assert news(board, 'cy', 8, told=told_of(board, news(board, 'cy', 0).reruns)).reruns == ()
    assert not hears(wanted().take('cy', 'p-1'), 'cy')
    assert not hears(taken_by('cy'), 'bo')


def test_a_rerun_is_for_the_reviewer_seats_and_for_any_agent_when_no_holder_can_take_it() -> None:
    def seated(*holders: str) -> RecordBuilder:
        record = lab().reviewer_seats(1)
        for holder in holders:
            record.reviewer(holder, 'person')
        return record.post(RESULT).rerun('ada', 'p-1')

    def state(record: RecordBuilder) -> tuple[str, list[bool]]:
        board = record.board()
        return open_to(board, 'p-1'), [can_take(board, agent, 'p-1') for agent in ('ada', 'bo', 'cy')]

    # A holder that can take it keeps the rerun for the seats.
    assert state(seated('bo')) == ('reviewer', [False, True, False])
    # The lab has no seats, nobody holds one, the only holder wrote the post, or it left: any other agent can.
    assert state(wanted()) == ('any', [False, True, True])
    assert state(seated()) == ('any', [False, True, True])
    assert state(seated('ada')) == ('any', [False, True, True])
    assert state(seated('bo').leave('bo')) == ('any', [False, False, True])
    # The only holder took it already, so it is open to the others while that take has no check.
    assert state(seated('bo').take('bo', 'p-1')) == ('any', [False, False, True])
    # A holder that is on call, or that Verifold stopped after its harness failed too often, cannot take it now.
    assert state(seated('bo').on_call('bo')) == ('any', [False, True, True])
    assert state(seated('bo').turn('bo', error='It crashed.', stopped=True)) == ('any', [False, True, True])
    assert state(seated('bo').turn('bo', error='It crashed.', stopped=True).start('bo', seen=0))[0] == 'reviewer'
    # No agent of the lab can take it: every other agent took it or left, or the author is alone.
    assert state(wanted().take('bo', 'p-1').leave('cy')) == ('none', [False, False, False])
    alone = RecordBuilder().join('ada').thread('t-1', opened_by='ada').post(RESULT).rerun('ada', 'p-1')
    assert open_to(alone.board(), 'p-1') == 'none'
    line = rerun_line(alone.board(), 'p-1')
    assert line is not None
    assert line.open_to == 'none'


def test_a_post_that_becomes_wanted_is_news_once_whoever_asks_after() -> None:
    record = wanted()
    first = len(record.events)
    record.rerun('person', 'p-1').rerun('cy', 'p-1')
    board = record.board()

    # The first request is the news. A later request for the same rerun is recorded and shown, and wakes nobody.
    heard = news(board, 'cy', first - 1).reruns
    assert [line.asked_by for line in heard] == [('bo', 'person', 'cy')]
    told = told_of(board, heard)
    assert news(board, 'cy', first, told=told).reruns == ()
    assert update(board, 'cy', first, told=told).reruns == ()
    line = rerun_line(board, 'p-1')
    assert line is not None
    assert line.asked_by == ('bo', 'person', 'cy')
    # After a check answered it, a new request makes the post wanted again, and that is news again.
    record.take('cy', 'p-1')
    record.post(rerun_check('cy', take=len(record.events)))
    answered = len(record.events)
    record.rerun('person', 'p-1')
    assert [line.post for line in news(record.board(), 'bo', answered, told=told).reruns] == ['p-1']


def test_an_agent_that_gets_a_reviewer_seat_hears_once_of_the_reruns_that_are_wanted() -> None:
    record = lab().reviewer_seats(1).reviewer('bo', 'person').post(RESULT).rerun('ada', 'p-1')
    read = len(record.events)
    # cy holds no seat, so the request was no news for it.
    assert news(record.board(), 'cy', 0).reruns == ()

    record.reviewer('cy', 'person')

    seat = len(record.events)
    heard = news(record.board(), 'cy', read).reruns
    assert [line.post for line in heard] == ['p-1']
    told = told_of(record.board(), heard)
    assert news(record.board(), 'cy', seat, told=told).reruns == ()
    # A seat that the agent loses again brings no news.
    assert news(record.reviewer('cy', 'person', reviewer=False).board(), 'cy', seat, told=told).reruns == ()


def test_a_rerun_that_opens_to_any_agent_is_news_once_for_the_agents_that_can_now_take_it() -> None:
    def opened(change: str) -> bool:
        record = lab().reviewer_seats(1).reviewer('bo', 'person').post(RESULT).rerun('ada', 'p-1')
        read = len(record.events)
        # The request was for the reviewer seat, so it was no news for cy.
        assert news(record.board(), 'cy', 0).reruns == ()
        if change == 'took':
            record.take('bo', 'p-1')
        elif change == 'left':
            record.leave('bo')
        elif change == 'on call':
            record.on_call('bo')
        elif change == 'stopped':
            record.turn('bo', error='It crashed.', stopped=True)
        elif change == 'no seat':
            record.reviewer('bo', 'person', reviewer=False)
        elif change == 'no seats':
            record.reviewer_seats(0)
        else:
            record.post(Message(id='p-2', thread='t-1', author='bo', text='Later.'))
        after = len(record.events)
        lines = news(record.board(), 'cy', read).reruns
        # The change is news once: an agent that read it hears nothing more.
        assert news(record.board(), 'cy', after, told=told_of(record.board(), lines)).reruns == ()
        assert update(record.board(), 'cy', read).reruns == lines
        return [line.open_to for line in lines] == ['any']

    assert [opened(change) for change in ('took', 'left', 'on call', 'stopped', 'no seat', 'no seats')] == [True] * 6
    assert not opened('a post')


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
    record.post(rerun_check('cy').model_copy(update={'id': 'p-3'}))

    # The agent's later check is a plain check, and it answers no new request.
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


def test_a_take_keeps_its_clean_copy_while_its_lease_stands_and_for_the_fewest_minutes_at_least() -> None:
    record = wanted().take('cy', 'p-1')
    taken = record.events[-1].at
    board = record.board()

    assert copy_kept_until(board, 'p-1', taken) == taken + timedelta(minutes=COPY_MINUTES)
    assert copy_kept_until(board, 'p-1', taken + timedelta(minutes=COPY_MINUTES)) is None
    # A longer lease keeps the copy as long, and a lab with no leases keeps it for the fewest minutes.
    longer = wanted().settings(Settings(reruns=RerunSettings(lease_minutes=45))).take('cy', 'p-1')
    at = longer.events[-1].at
    assert copy_kept_until(longer.board(), 'p-1', at) == at + timedelta(minutes=45)
    none = wanted().settings(Settings(reruns=RerunSettings(lease_minutes=0))).take('cy', 'p-1')
    assert copy_kept_until(none.board(), 'p-1', at) == at + timedelta(minutes=COPY_MINUTES)
    # A take dated after the moment, as from a clock that jumped, keeps nothing.
    assert copy_kept_until(board, 'p-1', taken - timedelta(minutes=1)) is None


def test_a_renewal_moves_the_time_and_a_lease_given_up_needs_the_copy_no_more() -> None:
    record = wanted().take('cy', 'p-1')
    renewed = record.copy().lease('cy', 'p-1')
    at = renewed.events[-1].at

    assert copy_kept_until(renewed.board(), 'p-1', at) == at + timedelta(minutes=COPY_MINUTES)
    given_up = record.copy().lease('cy', 'p-1', held=False)
    assert copy_kept_until(given_up.board(), 'p-1', given_up.events[-1].at) is None
    # A take after the give-up needs it again.
    again = given_up.copy().lease('cy', 'p-1')
    assert copy_kept_until(again.board(), 'p-1', again.events[-1].at) is not None


def test_a_copy_that_another_take_still_needs_stays_and_a_settled_rerun_needs_none() -> None:
    # bo's lease keeps out ada's family only, so cy of another family takes the rerun too. bo gives its lease up.
    record = lab().reviewer_seats(0).post(RESULT).rerun('ada', 'p-1').take('bo', 'p-1').take('cy', 'p-1')
    record.lease('bo', 'p-1', held=False)
    cy_took = record.events[-2].at

    assert copy_kept_until(record.board(), 'p-1', cy_took) == cy_took + timedelta(minutes=COPY_MINUTES)
    settled = record.post(rerun_check('cy', take=len(record.events) - 1))
    assert copy_kept_until(settled.board(), 'p-1', cy_took) is None
    assert copy_kept_until(settled.board(), 'p-9', cy_took) is None


def test_a_take_of_an_agent_that_left_and_a_closed_lab_need_no_copy() -> None:
    record = wanted().take('cy', 'p-1')
    at = record.events[-1].at

    assert copy_kept_until(record.copy().leave('cy').board(), 'p-1', at) is None
    record.post(Close(id='p-2', thread='t-1', author='ada', text='Done.'))
    record.post(Answer(id='p-3', thread='t-1', author='bo', text='Agreed.', reply_to='p-2', accepts=True))
    assert copy_kept_until(record.board(), 'p-1', at) is None
