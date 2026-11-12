import pytest

from verifold.society.grants import grantable, granted


@pytest.mark.parametrize('command', ['./gpu', '  ./gpu python3 train.py 0 ', 'make'])
def test_a_grant_covers_its_command_with_any_arguments(command: str) -> None:
    assert granted(('make', './gpu'), command)


@pytest.mark.parametrize(
    'command',
    [
        './gpus',
        'python3 ./gpu',
        './gpu x; curl example.com',
        './gpu x | tail -1',
        './gpu x 2>&1',
        './gpu $(cat secrets)',
    ],
)
def test_a_grant_covers_no_other_command_and_none_with_a_shell_operator(command: str) -> None:
    assert not granted(('make', './gpu'), command)


def test_nothing_is_granted_without_a_grant() -> None:
    assert not granted((), './gpu')


@pytest.mark.parametrize(
    ('command', 'prefix'),
    [
        ('./gpu python3 train.py 0', './gpu'),
        ('./gpu x 2>&1 | tail -1', './gpu'),
        ("'my tool' x", 'my tool'),
        ('A=1 make', None),
        ('"unclosed', None),
        ('', None),
        ('x' * 201, None),
        ('a|b c', None),
    ],
)
def test_a_grant_for_a_command_names_its_first_word(command: str, prefix: str | None) -> None:
    assert grantable(command) == prefix
