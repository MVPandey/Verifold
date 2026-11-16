import re

import pytest
from builders import START, RecordBuilder, lab
from pydantic import ValidationError

from verifold.protocol.events import ProfileSet
from verifold.protocol.posts import Message, Plan, Result
from verifold.society.attention import news, update, wakes
from verifold.society.board import Board
from verifold.society.errors import RejectedEvent
from verifold.society.identity import GUEST_LABEL, byline, post_line, seat_label
from verifold.society.names import check_name
from verifold.society.views import brief, profile_result, thread_view

RESULT = Result(id='p-1', thread='t-1', author='ada', text='Holds.')


def name_of(board: Board, agent_id: str) -> str:
    joined = board.agent(agent_id)
    assert joined is not None
    return joined.agent.name


PICTURE = {'shape': 'hex', 'color': '#f08c3a', 'symbol': 'orbit'}


def seats() -> RecordBuilder:
    """Two Codex seats of one model and one Claude Code seat, with thread t-1."""
    record = RecordBuilder().join('agent-1', name='Codex · gpt-6.1-sol').join('agent-2', name='Codex · gpt-6.1-sol 2')
    return record.join('agent-3', name='Claude Code · Opus 5.5', family='anthropic').thread('t-1', opened_by='agent-1')


def test_a_record_from_before_profiles_has_the_seats_label_as_each_name_and_no_picture() -> None:
    board = lab().post(RESULT).profile('ada', role='theory', status='Reads.').board()

    assert (name_of(board, 'ada'), board.label('ada'), board.chosen_name('ada')) == ('Ada', 'Ada', '')
    assert (board.about('ada'), board.picture('ada'), board.flag('ada')) == ('', None, None)
    assert board.profile('ada') == ('theory', 'Reads.')
    assert board.given_role('ada') == ('', 'person')
    line = post_line(board, board.posts[0], 'person')
    assert line.by is not None
    assert (line.by.name, line.by.seat, line.by.marks, line.by.role) == ('Ada', '', (), 'theory')


def test_an_agent_chooses_a_name_an_about_line_and_a_picture_and_the_seats_label_stays_a_fact() -> None:
    record = seats().profile('agent-2', name='Tessel', about='I run a number twice.', picture=PICTURE)
    board = record.board()

    assert name_of(board, 'agent-2') == 'Tessel'
    assert (board.label('agent-2'), board.chosen_name('agent-2')) == ('Codex · gpt-6.1-sol 2', 'Tessel')
    assert board.about('agent-2') == 'I run a number twice.'
    picture = board.picture('agent-2')
    assert picture is not None
    assert (picture.shape, picture.color, picture.symbol) == ('hex', '#f08c3a', 'orbit')
    # An empty name takes the chosen name back, and the name that the agent had stays its own.
    back = record.copy().profile('agent-2', name='').board()
    assert (name_of(back, 'agent-2'), back.chosen_name('agent-2')) == ('Codex · gpt-6.1-sol 2', '')
    assert ('agent-2', 'Tessel') in back.names()


@pytest.mark.parametrize('name', ['T', 'x' * 25, 'Te_ssel', 'Tessel!', 'Codex · mine', '-Tessel'])
def test_a_name_is_two_to_24_letters_and_digits_with_single_spaces_hyphens_and_apostrophes(name: str) -> None:
    with pytest.raises(ValidationError):
        ProfileSet(seq=9, at=START, agent='ada', name=name)


def test_a_name_and_an_about_line_are_one_printable_line_and_a_picture_takes_only_the_listed_parts() -> None:
    cleaned = ProfileSet(seq=9, at=START, agent='ada', name=" Ada\u200b  O'Neil-2 ", about='One\nline.')
    assert (cleaned.name, cleaned.about) == ("Ada O'Neil-2", 'One line.')
    with pytest.raises(ValidationError):
        ProfileSet(seq=9, at=START, agent='ada', about='x' * 241)
    for part in ({'shape': 'star'}, {'color': '#000000'}, {'symbol': 'face'}):
        with pytest.raises(ValidationError):
            ProfileSet.model_validate({'seq': 9, 'at': START, 'agent': 'ada', 'picture': PICTURE | part})


def test_a_name_that_an_agent_has_or_had_is_never_another_agents_name() -> None:
    record = seats().profile('agent-1', name='Maren').profile('agent-1', name='Tessel')
    board = record.board()

    for taken, held in (('maren', 'Maren'), ('TESSEL', 'Tessel')):
        with pytest.raises(RejectedEvent, match=rf'{taken} reads as {held}, a name that another agent has or had'):
            check_name(board, 'agent-2', taken)
    # The agent itself takes a name again that it had.
    check_name(board, 'agent-1', 'Maren')
    # A seat's new label keeps clear of a chosen name too, and a label that changes leaves a chosen name alone.
    named = record.copy().named('agent-1', 'Codex · gpt-7').board()
    assert (name_of(named, 'agent-1'), named.label('agent-1')) == ('Tessel', 'Codex · gpt-7')
    with pytest.raises(RejectedEvent, match='Another agent has or had the name Tessel'):
        record.copy().named('agent-2', 'Tessel').board()


@pytest.mark.parametrize(
    ('held', 'name'),
    [
        *(('Tessel', name) for name in ('tessel', 'Tesse1', 'TesseI', 'Tes sel', 'Te55el', "Tessel's", 'Tessel 2')),
        *(('Tessel', name) for name in ('Tessel2', 'Tessel-2', 'Tessel Two', 'Tesse1 2')),
        # The other way round: the name that is held is the new name with one more word or with digits.
        *(('Mar en', 'Mar'), ("Jo's", 'Jo'), ('Tessel2', 'Tessel'), ('Al 2', 'Al'), ('Quill-Pen', 'quill')),
    ],
)
def test_a_name_that_reads_as_another_agents_name_is_refused_in_both_directions(held: str, name: str) -> None:
    board = seats().profile('agent-2', name=held).board()

    with pytest.raises(RejectedEvent, match=f'reads as {held}, a name that another agent has or had'):
        check_name(board, 'agent-3', name)


@pytest.mark.parametrize(('held', 'name'), [('Al', 'Alpha'), ('Alpha', 'Al'), ('Tess', 'Tessel'), ('Mar', 'Maren')])
def test_a_name_that_only_begins_like_another_name_is_free(held: str, name: str) -> None:
    check_name(seats().profile('agent-2', name=held).board(), 'agent-3', name)


@pytest.mark.parametrize(
    ('name', 'word'),
    [
        *((name, 'person') for name in ('person', 'The Person', 'ThePerson', 'Person2', 'Per5on', 'Persons')),
        *((name, 'reviewer') for name in ('Reviewer 1', 'Reviewer2', 'Rev1ewer')),
        *((name, 'coordinator') for name in ('Coordinator 2', 'Coordinator2', 'The Coordinator', 'LabCoordinator')),
        *((name, 'verifold') for name in ('Verifold', 'Verif0ld', 'Verifold Server', 'VerifoldServer')),
        *(('System', 'system'), ('Admin1', 'admin'), ('Human', 'human'), ('User', 'user'), ('Everyone', 'everyone')),
        *(('Lab', 'lab'), ('Moderator', 'moderator'), ('You', 'you'), ('Agent', 'agent'), ('Agents', 'agent')),
        *(('Agent 9', 'agent'), ('agent-99', 'agent'), ('Checker', 'checker'), ('Guest', 'guest'), ('All', 'all')),
        *(('On call', 'oncall'), ('On Call 2', 'oncall'), ('Helper', 'helper')),
    ],
)
def test_a_name_made_of_reserved_words_is_refused_and_the_refusal_names_the_word(name: str, word: str) -> None:
    with pytest.raises(RejectedEvent, match=f'{name} is made of the word "{word}"'):
        check_name(seats().board(), 'agent-3', name)


@pytest.mark.parametrize(
    ('name', 'model'),
    [
        *((name, 'Claude Code') for name in ('Claude', 'Claude Code', 'Claude Code 2', 'Code', 'C1aude')),
        *((name, 'Codex') for name in ('Codex', 'Codex 2', 'C0dex')),
        *(('Sonnet 5', 'Sonnet 5'), ('Sonnet5', 'Sonnet 5'), ('Sonnet', 'Sonnet')),
        *(
            ('Opus', 'Opus 5.5'),
            ('Astra', 'Astra Max'),
            ('Astra Max', 'Astra Max'),
            ('gpt-6', 'gpt-6'),
            ('Anthropic', 'Anthropic'),
        ),
        *(('OpenAI', 'OpenAI'), ('fake', 'fake'), ('Reported', 'Reported 7')),
    ],
)
def test_a_name_that_is_or_holds_a_harness_or_a_model_is_refused_and_the_refusal_names_it(
    name: str, model: str
) -> None:
    record = seats().join('agent-4', name='Claude Code · Sonnet 5', family='Anthropic')
    record.join('agent-5', name='Codex · gpt-6', family='OpenAI').join('agent-6', name='Codex · Astra Max 2')
    board = record.start('agent-3', seen=1, model_name='Reported 7').board()

    with pytest.raises(RejectedEvent, match=f'(?i){re.escape(f"name of a harness or a model in this lab ({model})")}'):
        check_name(board, 'agent-3', name)


@pytest.mark.parametrize(
    'name',
    [
        *('Maren', 'Quill', 'We', 'Plan', 'Result', 'The', "O'Neil-2", 'Ali', 'Systemic', 'Personable', 'Allison'),
        # A short fragment of a model's ID is no model.
        *('Sol', 'Max', 'Pro', 'Mini', 'GPT', 'Maren 5'),
    ],
)
def test_the_board_takes_a_name_that_is_no_other_name_no_reserved_word_and_no_model(name: str) -> None:
    record = seats().join('agent-4', name='Codex · gpt-6.1-pro-mini').join('agent-5', name='Codex · Astra Max')

    check_name(record.profile('agent-2', name='Tessel').board(), 'agent-3', name)


@pytest.mark.parametrize('name', ['p-1', 't-2', 'P1', 'agent-2'])
def test_a_name_with_the_form_of_an_id_is_refused(name: str) -> None:
    with pytest.raises(
        RejectedEvent, match=r'form of the ID of an agent, a post, or a thread|made of the word "agent"'
    ):
        check_name(seats().board(), 'agent-3', name)


def test_a_record_keeps_a_name_that_todays_rules_refuse() -> None:
    # The rules for names are checked when an agent chooses one. A record from before a rule still loads.
    board = seats().profile('agent-1', name='Coordinator').profile('agent-2', name='coordinator 2').board()

    assert [name_of(board, agent) for agent in ('agent-1', 'agent-2')] == ['Coordinator', 'coordinator 2']
    with pytest.raises(RejectedEvent, match='made of the word "coordinator"'):
        check_name(board, 'agent-3', 'The Coordinators')


def test_a_post_shows_the_seats_label_as_it_was_when_the_post_was_written() -> None:
    record = RecordBuilder().join('agent-1', name='Codex · default model').thread('t-1', opened_by='agent-1')
    record.post(RESULT.model_copy(update={'author': 'agent-1'})).named('agent-1', 'Codex · gpt-6.1-sol')
    record.start('agent-1', seen=1, model_name='gpt-6.1-sol')
    record.post(Message(id='p-2', thread='t-1', author='agent-1', text='Second.'))
    # Another model takes the seat over: the harness reports it when a later turn starts.
    record.start('agent-1', seen=1, model_name='gpt-7').profile('agent-1', name='Tessel')
    record.post(Message(id='p-3', thread='t-1', author='agent-1', text='Third.'))
    board = record.board()

    first, second, third = (byline(board, entry) for entry in board.posts)
    assert first is not None
    assert second is not None
    assert third is not None
    assert (first.name, first.seat) == ('Tessel', 'Codex · default model')
    assert (second.name, second.seat) == ('Tessel', 'Codex · gpt-6.1-sol')
    assert (third.name, third.seat) == ('Tessel', 'Codex · gpt-7')
    # The seat keeps its label in the record, and the label of now names the model that the harness reported last.
    assert (board.label('agent-1'), seat_label(board, 'agent-1')) == ('Codex · gpt-6.1-sol', 'Codex · gpt-7')


def test_a_numbered_seat_keeps_its_number_when_the_harness_reports_the_same_model() -> None:
    record = seats().start('agent-2', seen=1, model_name='gpt-6.1-sol')
    record.post(Message(id='p-1', thread='t-1', author='agent-2', text='Hello.'))
    board = record.board()

    line = byline(board, board.posts[0])
    # The label is the agent's name, so the line does not repeat it.
    assert line is not None
    assert (line.name, line.seat, seat_label(board, 'agent-2')) == (
        'Codex · gpt-6.1-sol 2',
        '',
        'Codex · gpt-6.1-sol 2',
    )


def test_an_invited_agent_keeps_the_name_that_the_person_gave_it_and_its_seat_says_what_verifold_knows() -> None:
    record = seats().join('agent-4', harness='guest', name='Sorrel')
    record.post(Message(id='p-1', thread='t-1', author='agent-4', text='Hello.')).profile('agent-4', name='Scout')
    board = record.board()

    line = byline(board, board.posts[0])
    assert line is not None
    assert (line.name, line.seat) == ('Scout', GUEST_LABEL)
    assert name_of(record.copy().profile('agent-4', name='').board(), 'agent-4') == 'Sorrel'


def test_a_line_of_a_post_carries_the_authors_name_seat_marks_and_role_within_a_bound() -> None:
    long = f'Codex · {"m" * 60}'
    record = (
        RecordBuilder()
        .join('agent-1', name=long)
        .join('agent-2', name='Codex · gpt-6')
        .thread('t-1', opened_by='agent-1')
    )
    record.coordinator('agent-1').reviewer('agent-1', by='person').on_call('agent-1')
    record.profile('agent-1', name='Maren', role='keeps the map').profile('agent-2', by='person', given_role='driver')
    record.post(RESULT.model_copy(update={'author': 'agent-1'}))
    record.post(Message(id='p-2', thread='t-1', author='agent-2', text='Seen.'))
    record.post(Message(id='p-3', thread='t-1', author='person', text='Go on.'))
    board = record.board()

    unseen = news(board, 'agent-9', 0)
    mine, theirs, persons = sorted((*unseen.for_you, *unseen.others), key=lambda line: line.id)
    assert mine.by is not None
    assert theirs.by is not None
    assert (mine.by.name, mine.by.marks, mine.by.role) == (
        'Maren',
        ('coordinator', 'reviewer', 'on_call'),
        'keeps the map',
    )
    # A long label is cut in a line, and a thread shows all of it.
    assert (len(mine.by.seat), mine.by.seat[-1]) == (28, '…')
    whole = thread_view(board, 'agent-2', 't-1').posts[0].by
    assert whole is not None
    assert whole.seat == long
    # A role that somebody gave the seat stands where the agent gave itself none. The person's post has no byline.
    assert (theirs.by.name, theirs.by.seat, theirs.by.role, persons.by) == ('Codex · gpt-6', '', 'driver', None)
    # `wait` returns each post for the agent with the same facts.
    waited = update(board, 'agent-2', 0).posts
    assert [(view.post.id, view.by.name if view.by else None) for view in waited] == [('p-1', 'Maren'), ('p-3', None)]


def test_the_brief_shows_each_agents_name_seat_about_line_and_seats() -> None:
    record = seats().profile('agent-2', name='Tessel', about='I run a number twice.', role='builder')
    record.coordinator('agent-2').reviewer('agent-3').profile('agent-3', by='agent-2', given_role='second reader')
    board = record.board()

    view = brief(board, 'agent-1', news(board, 'agent-1', 0))
    tessel, third = view.agents
    assert (tessel.name, tessel.seat, tessel.about) == ('Tessel', 'Codex · gpt-6.1-sol 2', 'I run a number twice.')
    assert (tessel.role, tessel.coordinator, tessel.reviewer) == ('builder', True, False)
    assert (third.name, third.seat, third.reviewer) == ('Claude Code · Opus 5.5', '', True)
    assert (third.given_role, third.given_by) == ('second reader', 'agent-2')
    assert view.your_line is not None
    assert (view.your_line.name, view.your_line.given_by) == ('Codex · gpt-6.1-sol', None)
    assert (view.reviewers, view.reviewer_seats, view.reviewer_seats_free) == (('agent-3',), 1, 0)


def test_a_chosen_name_reaches_its_agent_only_after_an_at_sign_and_a_seats_label_as_before() -> None:
    record = seats().profile('agent-2', name='Tessel').profile('agent-2', name='We')
    record.post(RESULT.model_copy(update={'author': 'agent-1'}))
    plain = Plan(id='p-2', thread='t-1', author='agent-3', text='We test the bound first. Tessel knows why.')
    former = Message(id='p-3', thread='t-1', author='agent-3', text='What does @Tessel think?')
    now = Message(id='p-4', thread='t-1', author='agent-3', text='And @we, at the end of a sentence: @We.')
    label = Message(id='p-5', thread='t-1', author='agent-3', text='Ask Codex · gpt-6.1-sol 2 about it.')
    other = Message(id='p-6', thread='t-1', author='agent-3', text='mail@We.example, @Weston and a@We name nobody.')
    start = record.board().seq
    board = record.post(plain).post(former).post(now).post(label).post(other).board()

    # A name can be a common word, so the name alone names nobody.
    assert not any(wakes(board, joined.agent.id, board.posts[1]) for joined in board.agents[1:])
    assert [line.id for line in news(board, 'agent-2', start).for_you] == ['p-3', 'p-4', 'p-5']
    # A name that the person took back still reaches its agent after the sign, and still wakes nobody without it.
    back = record.copy().profile('agent-2', by='person', name='')
    back.post(Message(id='p-7', thread='t-1', author='agent-3', text='We found it.'))
    back.post(Message(id='p-8', thread='t-1', author='agent-3', text='@We found it.'))
    assert [line.id for line in news(back.board(), 'agent-2', board.seq).for_you] == ['p-8']


@pytest.mark.parametrize('name', ['Persοn', 'Verifοld', 'Ｔｅｓｓｅｌ', 'Теssel', '𝐓essel', 'Opus 5.5', 'T'])  # noqa: RUF001
def test_a_name_holds_only_the_letters_a_to_z_and_digits(name: str) -> None:
    with pytest.raises(ValidationError):
        ProfileSet(seq=9, at=START, agent='ada', name=name)


def test_an_agent_chooses_a_name_five_times_at_most_in_a_lab() -> None:
    record = seats()
    for name in ('Alpha', 'Beta', 'Gamma', 'Delta', 'Zeta'):
        record.profile('agent-1', name=name)
    board = record.board()

    with pytest.raises(RejectedEvent, match=r'at most 5 times in a lab, and you chose 5\. Your name stays Zeta'):
        check_name(board, 'agent-1', 'Omega')
    # The agent can still take its name back, and the names that it held stay its own.
    assert name_of(record.copy().profile('agent-1', name='').board(), 'agent-1') == 'Codex · gpt-6.1-sol'
    with pytest.raises(RejectedEvent, match='Alpha reads as Alpha'):
        check_name(board, 'agent-2', 'Alpha')


def test_a_rename_is_news_for_the_other_agents_once_and_the_brief_keeps_the_former_names() -> None:
    record = seats().profile('agent-2', name='Tessel')
    seen = record.board().seq
    record.profile('agent-2', name='Quill').named('agent-3', 'Claude Code · Opus 6')
    record.profile('agent-1', name='Maren').profile('agent-1', name='')
    board = record.board()

    told = news(board, 'agent-1', seen)
    assert [(line.id, line.name, line.was) for line in told.renamed] == [
        ('agent-2', 'Quill', 'Tessel'),
        ('agent-3', 'Claude Code · Opus 6', 'Claude Code · Opus 5.5'),
    ]
    # The agent's own change is no news for it, a name that came and went is none, and the next news has none.
    assert [line.id for line in update(board, 'agent-2', seen).renamed] == ['agent-3']
    assert news(board, 'agent-1', board.seq).renamed == ()
    assert [line.was for line in news(board, 'agent-3', seats().board().seq).renamed] == ['Codex · gpt-6.1-sol 2']
    lines = {line.id: line for line in brief(board, 'agent-3', news(board, 'agent-3', 0)).agents}
    assert (lines['agent-2'].former_names, lines['agent-1'].former_names) == (('Tessel',), ('Maren',))
    # The line has the two names that the agent held last before its name of now, newest last, also after it
    # took a name again.
    again = (
        record.copy().profile('agent-2', name='Wren').profile('agent-2', name='Tessel').profile('agent-2', name='Finch')
    )
    (line,) = [
        line
        for line in brief(again.board(), 'agent-3', news(again.board(), 'agent-3', 0)).agents
        if line.id == 'agent-2'
    ]
    assert line.former_names == ('Wren', 'Tessel')


def test_a_name_of_two_words_reaches_its_agent_after_an_at_sign_with_its_one_space() -> None:
    record = seats().profile('agent-2', name='Mar En').post(RESULT.model_copy(update={'author': 'agent-1'}))
    record.post(Message(id='p-2', thread='t-1', author='agent-3', text='Ask @Mar En about it, not @Mar or @MarEn.'))
    record.post(Message(id='p-3', thread='t-1', author='agent-3', text='Not @Mar, and not @En.'))
    board = record.board()

    assert [wakes(board, 'agent-2', entry) for entry in board.posts[1:]] == [True, False]


def test_the_brief_says_who_wrote_an_about_line() -> None:
    record = seats().coordinator('agent-1').profile('agent-2', about='I am the best.')
    own = brief(record.board(), 'agent-3', news(record.board(), 'agent-3', 0)).agents[1]
    board = record.profile('agent-2', by='agent-1', about='Runs numbers twice.').board()
    rewritten = brief(board, 'agent-3', news(board, 'agent-3', 0)).agents[1]

    assert (own.about_by, rewritten.about, rewritten.about_by) == ('agent-2', 'Runs numbers twice.', 'agent-1')
    assert (board.about_by('agent-3'), profile_result(board, 'agent-2').about_by) == (None, 'agent-1')
    assert record.copy().profile('agent-2', by='person', about='').board().about_by('agent-2') is None


def test_the_person_takes_back_the_name_the_about_line_and_the_picture_of_an_agent_that_left() -> None:
    record = seats().profile('agent-2', name='Overlord', about='I rule.', picture=PICTURE).leave('agent-2')
    board = record.copy().profile('agent-2', by='person', name='', about='', no_picture=True).board()

    assert (name_of(board, 'agent-2'), board.about('agent-2'), board.picture('agent-2')) == (
        'Codex · gpt-6.1-sol 2',
        '',
        None,
    )
    # Nobody gives a role to an agent that left, and it changes nothing itself.
    for fields in ({'by': 'person', 'given_role': 'driver'}, {'name': 'Again'}):
        with pytest.raises(RejectedEvent, match='left this lab'):
            record.copy().profile('agent-2', **fields).board()


def test_a_derived_label_keeps_the_number_of_its_seat() -> None:
    record = seats().start('agent-1', seen=1, model_name='gpt-7').start('agent-2', seen=1, model_name='gpt-7')
    board = record.start('agent-3', seen=1, model_name='Opus 6').board()

    assert [seat_label(board, agent) for agent in ('agent-1', 'agent-2', 'agent-3')] == [
        'Codex · gpt-7',
        'Codex · gpt-7 2',
        'Claude Code · Opus 6',
    ]


def test_the_person_takes_back_what_an_agent_chose_and_gives_its_seat_a_role_at_any_time() -> None:
    record = seats().profile('agent-2', name='Tessel', about='A lens.', picture=PICTURE)
    record.profile('agent-2', by='person', name='', about='', no_picture=True, given_role='driver')
    board = record.board()

    assert (name_of(board, 'agent-2'), board.about('agent-2'), board.picture('agent-2')) == (
        'Codex · gpt-6.1-sol 2',
        '',
        None,
    )
    assert board.given_role('agent-2') == ('driver', 'person')
    assert record.copy().profile('agent-2', by='person', given_role='scout').board().given_role('agent-2') == (
        'scout',
        'person',
    )
    # The agent can choose again afterwards, and its news says what the person changed.
    again = record.copy().profile('agent-2', name='Tessel', picture=PICTURE).board()
    assert (name_of(again, 'agent-2'), again.picture('agent-2') is not None) == ('Tessel', True)
    (note,) = news(board, 'agent-2', 0).profile
    assert (note.by, note.name_taken_back, note.about, note.picture_taken_back, note.given_role) == (
        'person',
        True,
        '',
        True,
        'driver',
    )
    assert news(board, 'agent-1', 0).profile == ()
    # The person writes no name, no about line, and no flag for an agent.
    for fields in ({'name': 'Mine'}, {'about': 'Written by the person.'}, {'flag': 'Why.'}, {'role': 'theory'}):
        with pytest.raises(RejectedEvent):
            record.copy().profile('agent-2', by='person', **fields).board()


def test_the_coordinator_flags_a_profile_rewrites_its_about_line_and_takes_its_name_back() -> None:
    record = seats().coordinator('agent-1').profile('agent-2', name='Tessel', about='I am the best model.')
    record.profile('agent-2', by='agent-1', flag='It ranks itself.', about='Runs numbers twice.', name='')
    board = record.board()

    flag = board.flag('agent-2')
    assert flag is not None
    assert (flag.flag, flag.by, board.about('agent-2')) == ('It ranks itself.', 'agent-1', 'Runs numbers twice.')
    assert name_of(board, 'agent-2') == 'Codex · gpt-6.1-sol 2'
    # The record keeps the earlier text.
    assert [entry.about for entry in board.profiles if entry.agent == 'agent-2'] == [
        'I am the best model.',
        'Runs numbers twice.',
    ]
    (note,) = update(board, 'agent-2', 0).profile
    assert (note.by, note.flag, note.about, note.name_taken_back) == (
        'agent-1',
        'It ranks itself.',
        'Runs numbers twice.',
        True,
    )
    # The agent edits again, and its own change of the flagged text ends the flag.
    assert record.copy().profile('agent-2', status='Working.').board().flag('agent-2') is not None
    assert record.copy().profile('agent-2', about='I run a number twice.').board().flag('agent-2') is None
    # The coordinator takes its flag back with an empty reason.
    assert record.copy().profile('agent-2', by='agent-1', flag='').board().flag('agent-2') is None


def test_only_the_coordinator_and_the_person_change_the_profile_of_another_agent() -> None:
    record = seats().coordinator('agent-1').profile('agent-2', name='Tessel', picture=PICTURE)

    with pytest.raises(RejectedEvent, match="Only the person and the lab's coordinator"):
        record.copy().profile('agent-2', by='agent-3', flag='No.').board()
    for fields in ({'name': 'Mine'}, {'role': 'theory'}, {'status': 'Idle.'}, {'picture': PICTURE}):
        with pytest.raises(RejectedEvent, match='are its own'):
            record.copy().profile('agent-2', by='agent-1', **fields).board()
    with pytest.raises(RejectedEvent, match='Only the person takes a picture back'):
        record.copy().profile('agent-2', by='agent-1', no_picture=True).board()
    # An agent gives itself no role for its seat and flags nothing of its own.
    for fields in ({'given_role': 'driver'}, {'flag': 'Mine.'}, {'no_picture': True}):
        with pytest.raises(RejectedEvent, match='Only the person or the coordinator'):
            record.copy().profile('agent-2', **fields).board()
    with pytest.raises(RejectedEvent, match='changes nothing'):
        record.copy().profile('agent-2').board()
    with pytest.raises(RejectedEvent, match='not both'):
        record.copy().profile('agent-2', by='person', picture=PICTURE, no_picture=True).board()


def test_the_coordinator_gives_a_role_only_where_the_person_gave_none() -> None:
    record = seats().coordinator('agent-1').profile('agent-2', by='agent-1', given_role='second reader')

    assert record.board().given_role('agent-2') == ('second reader', 'agent-1')
    assert (
        record.copy().profile('agent-2', by='agent-1', given_role='builder').board().given_role('agent-2')[0]
        == 'builder'
    )
    # The person's role wins, and from then on only the person changes it.
    given = record.profile('agent-2', by='person', given_role='driver')
    with pytest.raises(RejectedEvent, match='only the person changes it'):
        given.copy().profile('agent-2', by='agent-1', given_role='builder').board()
    # A role from the setup is the person's too. Once the person takes the role back, the coordinator can give one.
    board = (
        given.copy()
        .profile('agent-2', by='person', given_role='')
        .profile('agent-2', by='agent-1', given_role='x')
        .board()
    )
    assert board.given_role('agent-2') == ('x', 'agent-1')


def test_a_profile_result_holds_the_profile_and_the_labs_seats() -> None:
    record = seats().profile('agent-2', name='Tessel', about='A lens.', picture=PICTURE, role='builder')
    board = record.coordinator('agent-1').profile('agent-2', by='agent-1', flag='Why.').reviewer('agent-2').board()

    result = profile_result(board, 'agent-2')
    assert (result.agent, result.name, result.seat, result.about) == (
        'agent-2',
        'Tessel',
        'Codex · gpt-6.1-sol 2',
        'A lens.',
    )
    assert (result.role, result.flag, result.coordinator, result.picture is not None) == (
        'builder',
        'Why.',
        'agent-1',
        True,
    )
    assert (result.reviewers, result.reviewer_seats, result.reviewer_seats_free) == (('agent-2',), 1, 0)
