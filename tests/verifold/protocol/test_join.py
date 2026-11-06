import pytest
from pydantic import ValidationError

from verifold.protocol.join import PostRequest
from verifold.protocol.posts import Answer, Check, Message


def test_a_request_becomes_a_post_of_its_kind() -> None:
    request = PostRequest(kind='check', text='Reran it.', thread='t-1', reply_to='p-1', outcome='fails', method='rerun')

    post = request.to_post('p-2', 't-1', 'bo')

    assert isinstance(post, Check)
    assert (post.id, post.author, post.outcome) == ('p-2', 'bo', 'fails')


def test_a_false_accepts_is_the_same_as_none() -> None:
    post = PostRequest(kind='message', text='Hi.', thread='t-1', accepts=False).to_post('p-1', 't-1', 'ada')

    assert isinstance(post, Message)


def test_an_answer_keeps_accepts() -> None:
    request = PostRequest(kind='answer', text='Right.', thread='t-1', reply_to='p-2', accepts=True)

    post = request.to_post('p-3', 't-1', 'ada')

    assert isinstance(post, Answer)
    assert post.accepts


def test_fields_that_the_kind_does_not_use_are_rejected() -> None:
    with pytest.raises(ValidationError, match='outcome'):
        PostRequest(kind='message', text='Hi.', thread='t-1', outcome='holds').to_post('p-1', 't-1', 'ada')


@pytest.mark.parametrize(
    ('fields', 'reason'),
    [
        ({}, 'Give thread'),
        ({'thread': 't-1', 'new_thread': 'Another'}, 'Give thread'),
        ({'new_thread': 'Another', 'reply_to': 'p-1'}, 'reply stays in the thread'),
    ],
)
def test_a_request_names_exactly_one_thread(fields: dict[str, str], reason: str) -> None:
    with pytest.raises(ValidationError, match=reason):
        PostRequest.model_validate({'kind': 'message', 'text': 'Hi.'} | fields)
