from datetime import timedelta
from decimal import Decimal

import pytest
from builders import RecordBuilder
from pydantic import ValidationError

from verifold.protocol.join import PostRequest
from verifold.protocol.posts import Answer, Check, FileEvidence, HeadlineNumber, Measure, Message, Objection
from verifold.society.attention import news, wakes
from verifold.society.errors import RejectedEvent
from verifold.society.measures import headline_label, headline_line, newest_measure, reruns_of
from verifold.society.views import brief

SOURCE = (FileEvidence(path='value.py', commit='c' * 40), FileEvidence(path='value.out', commit='c' * 40))


def measure(post_id: str, value: str, author: str = 'ada', label: str = 'Account value', **fields: object) -> Measure:
    return Measure.model_validate(
        {
            'id': post_id,
            'thread': 't-1',
            'author': author,
            'text': f'{label}: {value} USD',
            'label': label,
            'value': value,
            'unit': 'USD',
            'as_of': fields.pop('as_of', RecordBuilder().at(1)),
            'script': 'value.py',
            'output': 'value.out',
            'evidence': SOURCE,
        }
        | fields
    )


def naming(post_id: str, label: str, author: str = 'person', why: str | None = None) -> HeadlineNumber:
    return HeadlineNumber(id=post_id, thread='t-1', author=author, text='Named.', label=label, why=why)


def test_a_measure_pins_its_script_and_its_output_and_holds_its_value_exactly(record: RecordBuilder) -> None:
    board = record.post(measure('p-1', '382.240')).board()

    posted = board.posts[-1].post
    assert isinstance(posted, Measure)
    assert posted.value == Decimal('382.240')
    assert board.posts[-1].model_dump(mode='json')['post']['value'] == '382.240'
    assert Measure.model_validate(measure('p-1', '1E-7').model_dump(mode='json')).value == Decimal('1E-7')
    assert measure('p-1', '1E-7').model_dump(mode='json')['value'] == '0.0000001'
    with pytest.raises(ValidationError, match='pins two files'):
        measure('p-1', '1', script='other.py')
    with pytest.raises(ValidationError):
        measure('p-1', 'NaN')
    with pytest.raises(ValidationError, match='The label has 81 characters, and the limit is 80'):
        measure('p-1', '1', label='L' * 81)
    with pytest.raises(ValidationError, match='label holds no text'):
        measure('p-1', '1', label='   ')


def test_the_board_takes_a_measure_from_an_agent_for_a_time_that_has_come(record: RecordBuilder) -> None:
    late = record.at(len(record.events) + 1) + timedelta(seconds=1)
    with pytest.raises(RejectedEvent, match='after the time of the post'):
        record.copy().post(measure('p-1', '1', as_of=late)).board()
    with pytest.raises(RejectedEvent, match='number of an agent'):
        record.copy().post(measure('p-1', '1', author='person')).board()
    with pytest.raises(ValidationError, match='goes through the `measure` tool'):
        PostRequest(kind='measure', text='Account value: 1', thread='t-1')


def test_a_measure_carries_who_reran_it_and_what_that_rerun_found(record: RecordBuilder) -> None:
    record.post(measure('p-1', '382.24')).rerun('bo', 'p-1').take('bo', 'p-1')
    assert reruns_of(record.board(), 'p-1') == ((), ())

    record.post(
        Check(
            id='p-2',
            thread='t-1',
            author='bo',
            text='Same number.',
            reply_to='p-1',
            outcome='holds',
            method='rerun',
            take=len(record.events),
            evidence=SOURCE,
        )
    )
    # A check that is no check of a take is not a rerun of the measure, whatever its method.
    record.post(
        Check(id='p-3', thread='t-1', author='cy', text='I read it.', reply_to='p-1', outcome='fails', method='rerun')
    )
    board = record.board()

    assert reruns_of(board, 'p-1') == (('bo',), ())
    line = headline_line(record.copy().post(naming('p-4', 'account value')).board(), board.posts[-1].at)
    assert line is not None
    assert line.measure is not None
    assert (line.label, line.named_by, line.measure.rerun_by) == ('account value', 'person', ('bo',))


def test_a_rerun_that_fails_marks_the_measure_and_a_check_that_its_author_conceded_counts_for_nothing(
    record: RecordBuilder,
) -> None:
    record.post(measure('p-1', '382.24')).rerun('ada', 'p-1').take('cy', 'p-1')
    record.post(
        Check(
            id='p-2',
            thread='t-1',
            author='cy',
            text='I get 380.',
            reply_to='p-1',
            outcome='fails',
            method='rerun',
            take=len(record.events),
            evidence=SOURCE,
        )
    )
    assert reruns_of(record.board(), 'p-1') == ((), ('cy',))

    record.post(Objection(id='p-3', thread='t-1', author='ada', text='You ran it a day later.', reply_to='p-2'))
    record.post(Answer(id='p-4', thread='t-1', author='cy', text='True.', reply_to='p-3', accepts=True))

    assert reruns_of(record.board(), 'p-1') == ((), ())


def test_the_newest_measure_with_the_label_is_the_headline_number_unless_its_author_conceded_it(
    record: RecordBuilder,
) -> None:
    record.post(measure('p-1', '400.21')).post(measure('p-2', '7', label='Orders')).post(measure('p-3', '382.24'))
    board = record.board()
    assert headline_line(board, board.posts[-1].at) is None
    assert newest_measure(board, 'ACCOUNT  value') == board.posts[2]

    record.post(Objection(id='p-4', thread='t-1', author='bo', text='Stale fill.', reply_to='p-3'))
    record.post(Answer(id='p-5', thread='t-1', author='ada', text='Yes.', reply_to='p-4', accepts=True))
    record.post(naming('p-6', 'Account value'))
    board = record.board()

    line = headline_line(board, board.posts[-1].at)
    assert line is not None
    assert line.measure is not None
    assert (line.measure.post, line.measure.value) == ('p-1', Decimal('400.21'))
    assert headline_line(record.post(naming('p-7', 'Win rate')).board(), board.posts[-1].at) is not None


def test_the_person_names_the_headline_number_and_the_coordinator_names_one_with_a_why_where_the_person_named_none(
    record: RecordBuilder,
) -> None:
    record.coordinator('bo')
    with pytest.raises(RejectedEvent, match='Only the person and the lab'):
        record.copy().post(naming('p-1', 'Account value', author='ada', why='It is the goal.')).board()
    with pytest.raises(RejectedEvent, match='needs `why`'):
        record.copy().post(naming('p-1', 'Account value', author='bo')).board()

    record.post(naming('p-1', 'Account value', author='bo', why='The person asked for the account.'))
    assert headline_label(record.board()) == 'Account value'
    record.post(naming('p-2', 'Cash', author='bo', why='Cash is what settles.'))
    record.post(naming('p-3', 'Account value'))
    assert headline_label(record.board()) == 'Account value'

    with pytest.raises(RejectedEvent, match='only the person changes it'):
        record.copy().post(naming('p-4', 'Cash', author='bo', why='Cash settles.')).board()
    record.post(naming('p-4', ''))
    record.post(naming('p-5', 'Cash', author='bo', why='Cash settles.'))
    assert headline_label(record.board()) == 'Cash'


def test_a_naming_of_the_headline_number_is_for_the_whole_lab_and_reaches_every_agent(record: RecordBuilder) -> None:
    record.thread('t-2', 'ada', between=('ada', 'bo')).coordinator('cy')
    with pytest.raises(RejectedEvent, match='thread for the whole lab'):
        record.copy().post(naming('p-1', 'Cash').model_copy(update={'thread': 't-2'})).board()

    board = record.post(naming('p-1', 'Cash', author='cy', why='Cash settles.')).board()

    assert all(wakes(board, agent, board.posts[-1]) for agent in ('ada', 'bo'))
    assert not wakes(board, 'cy', board.posts[-1])


def test_the_brief_has_the_headline_number_with_its_age_and_who_reran_it(record: RecordBuilder) -> None:
    record.post(measure('p-1', '382.24', as_of=record.at(1))).post(naming('p-2', 'Account value'))
    record.post(Message(id='p-3', thread='t-1', author='bo', text='Noted.'))
    board = record.board()
    now = board.posts[-1].at

    shown = brief(board, 'bo', news(board, 'bo', board.seq, now), now=now)

    assert shown.headline_number is not None
    assert shown.headline_number.measure is not None
    assert shown.headline_number.measure.minutes_ago == len(record.events) - 1
    assert shown.dashboard is None
    dumped = shown.model_dump(mode='json')
    assert dumped['headline_number'] == {
        'label': 'Account value',
        'named_by': 'person',
        'measure': {
            'post': 'p-1',
            'thread': 't-1',
            'by': 'ada',
            'label': 'Account value',
            'value': '382.24',
            'unit': 'USD',
            'as_of': record.at(1).isoformat().replace('+00:00', 'Z'),
            'minutes_ago': len(record.events) - 1,
        },
    }
    assert 'dashboard' not in dumped
