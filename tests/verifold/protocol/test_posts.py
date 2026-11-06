import pytest
from pydantic import TypeAdapter, ValidationError

from verifold.protocol.posts import Answer, Check, FileEvidence, Message, Post

posts = TypeAdapter(Post)


def test_the_kind_selects_the_model() -> None:
    post = posts.validate_python(
        {
            'kind': 'check',
            'id': 'p-2',
            'thread': 't-1',
            'author': 'bo',
            'text': 'Reran it.',
            'reply_to': 'p-1',
            'outcome': 'holds',
            'method': 'rerun',
        }
    )

    assert isinstance(post, Check)
    assert post.outcome == 'holds'


def test_a_post_round_trips_through_json() -> None:
    post = Message(id='p-1', thread='t-1', author='ada', text='  Using the baseline.  ', mentions=('bo',))

    assert posts.validate_json(posts.dump_json(post)) == post
    assert post.text == 'Using the baseline.'


@pytest.mark.parametrize('kind', ['answer', 'objection', 'check'])
def test_replies_name_their_target(kind: str) -> None:
    with pytest.raises(ValidationError, match='reply_to'):
        posts.validate_python(
            {
                'kind': kind,
                'id': 'p-2',
                'thread': 't-1',
                'author': 'bo',
                'text': 'No target.',
                'outcome': 'fails',
                'method': 'code_read',
            }
        )


def test_a_post_is_immutable() -> None:
    answer = Answer(id='p-2', thread='t-1', author='ada', text='Right.', reply_to='p-1')

    with pytest.raises(ValidationError, match='frozen'):
        answer.accepts = True  # ty: ignore[invalid-assignment]


@pytest.mark.parametrize('field', [{'title': 'x'}, {'kind': 'note'}])
def test_unknown_fields_and_kinds_are_rejected(field: dict[str, str]) -> None:
    with pytest.raises(ValidationError):
        posts.validate_python({'kind': 'message', 'id': 'p-1', 'thread': 't-1', 'author': 'ada', 'text': 'Hi'} | field)


@pytest.mark.parametrize('path', ['/etc/passwd', '../other/file.txt', 'a/../../b', ''])
def test_evidence_stays_inside_the_folder(path: str) -> None:
    with pytest.raises(ValidationError, match='relative to your folder'):
        FileEvidence(path=path, commit='a' * 40)


def test_evidence_names_a_full_commit() -> None:
    assert FileEvidence(path='results/run.json', commit='0' * 40).path == 'results/run.json'
    with pytest.raises(ValidationError, match='commit'):
        FileEvidence(path='results/run.json', commit='abc123')
