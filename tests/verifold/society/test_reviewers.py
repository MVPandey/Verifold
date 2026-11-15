import pytest
from builders import RecordBuilder, lab

from verifold.protocol.posts import Message, Proposal, Result
from verifold.society.errors import RejectedEvent
from verifold.society.reviewers import default_seats, free_seats, holders, may_review, seats, seats_line

RESULT = Result(id='p-1', thread='t-1', author='ada', text='Holds.')


@pytest.mark.parametrize(
    ('agents', 'expected'), [(1, 0), (2, 0), (3, 1), (4, 1), (5, 1), (9, 1), (10, 2), (14, 2), (15, 3), (20, 4)]
)
def test_a_lab_has_one_reviewer_seat_for_every_five_agents_and_one_from_three_agents(
    agents: int, expected: int
) -> None:
    assert default_seats(agents) == expected


def test_the_seats_count_the_agents_that_are_in_the_lab_and_the_person_can_set_the_number() -> None:
    record = lab().join('guest-1', harness='guest').join('dee').leave('dee')
    for number in range(6):
        record.join(f'agent-{number}')

    # Nine agents are in the lab: an invited agent that has not posted and an agent that left do not count.
    assert seats(record.board()) == 1
    came = record.post(Message(id='p-1', thread='t-1', author='guest-1', text='Here.')).board()
    assert seats(came) == 2
    # A blind checker is no agent of the lab.
    assert seats(record.post(RESULT.model_copy(update={'id': 'p-2'})).join('checker-1', checks='p-2').board()) == 2
    assert [seats(record.copy().reviewer_seats(number).board()) for number in (0, 5)] == [0, 5]


def test_an_agent_takes_a_free_reviewer_seat_and_gives_it_up_and_the_person_gives_and_takes_one() -> None:
    record = lab().reviewer('bo')
    board = record.board()

    assert (holders(board), free_seats(board), board.reviewer('bo'), board.reviewer('ada')) == (('bo',), 0, True, False)
    assert seats_line(board) == 'The lab has 1: held by bo; 0 are free.'
    with pytest.raises(RejectedEvent, match=r'No reviewer seat is free\. The lab has 1: held by bo; 0 are free\.'):
        record.copy().reviewer('cy').board()
    with pytest.raises(RejectedEvent, match='Only the person gives one to another'):
        record.copy().reviewer('ada', by='cy').board()
    with pytest.raises(RejectedEvent, match='you have none to give up'):
        record.copy().reviewer('ada', reviewer=False).board()
    # The person is not limited by the number, and takes a seat from its holder.
    more = record.copy().reviewer('ada', by='person').board()
    assert (holders(more), free_seats(more)) == (('ada', 'bo'), 0)
    assert holders(record.copy().reviewer('bo', by='person', reviewer=False).board()) == ()
    # A seat that its holder gives up is free again, and so is the seat of an agent that left.
    assert free_seats(record.copy().reviewer('bo', reviewer=False).board()) == 1
    left = record.copy().leave('bo').board()
    assert (holders(left), left.reviewer('bo')) == ((), False)
    assert seats_line(lab().board()) == 'The lab has 1: held by nobody; 1 is free.'


def test_a_reviewer_seat_is_for_an_agent_of_the_lab() -> None:
    record = lab().post(RESULT).join('checker-1', checks='p-1')

    for agent, why in (('zed', 'not an agent'), ('checker-1', 'blind checker has no seat')):
        with pytest.raises(RejectedEvent, match=why):
            record.copy().reviewer(agent, by='person').board()
    with pytest.raises(RejectedEvent, match='left this lab'):
        record.copy().leave('bo').reviewer('bo', by='person').board()


def test_a_check_and_a_rerun_request_on_another_agents_post_take_a_reviewer_seat() -> None:
    record = lab().post(RESULT).post(Result(id='p-2', thread='t-1', author='ada', text='Also.'))
    board = record.board()

    assert not may_review(board, 'bo', 'p-1')
    assert may_review(board, 'person', 'p-1')
    assert may_review(record.copy().reviewer('bo').board(), 'bo', 'p-1')
    # An agent asks for a blind rerun of its own post without a seat.
    assert may_review(board, 'ada', 'p-1')
    # No post of the agent opens the gate: not one that builds on the post, not a reply, and not the lab's answer.
    for post in (
        Result(id='p-3', thread='t-1', author='bo', text='More.', builds_on=('p-1',)),
        Message(id='p-3', thread='t-1', author='bo', text='How?', reply_to='p-1'),
        Proposal(id='p-3', thread='t-1', author='cy', text='It holds.', builds_on=('p-1',)),
    ):
        after = record.copy().post(post).board()
        assert [may_review(after, 'bo', target) for target in ('p-1', 'p-3')] == [False, post.author == 'bo']


def test_a_lab_without_reviewer_seats_and_a_blind_checker_are_not_limited() -> None:
    two = RecordBuilder().join('ada').join('bo').thread('t-1', opened_by='ada').post(RESULT)

    assert (seats(two.board()), may_review(two.board(), 'bo', 'p-1')) == (0, True)
    record = lab().post(RESULT)
    assert may_review(record.copy().reviewer_seats(0).board(), 'bo', 'p-1')
    assert may_review(record.copy().join('checker-1', checks='p-1').board(), 'checker-1', 'p-1')
