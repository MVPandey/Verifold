import pytest

from verifold.society.grants import grantable, granted


@pytest.mark.parametrize('command', ['./gpu', '  ./gpu python3 train.py 0 ', 'make', './gpu --seed=1'])
def test_a_grant_covers_its_command_with_any_plain_arguments(command: str) -> None:
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
        './gpu =(cat secrets)',
        "./gpu *(e:'cat secrets':)",
        './gpu x\rcat secrets',
    ],
)
def test_a_grant_covers_no_other_command_and_none_that_is_not_plain(command: str) -> None:
    assert not granted(('make', './gpu'), command)


def test_nothing_is_granted_without_a_grant() -> None:
    assert not granted((), './gpu')


@pytest.mark.parametrize(
    ('command', 'prefix'),
    [
        ('./gpu python3 train.py 0', './gpu'),
        (' make ', 'make'),
        ('./gpu x 2>&1 | tail -1', None),
        ('cd x && make', None),
        ("' ' x", None),
        ('A=1 make', None),
        ('PATH=. ls', None),
        ('', None),
        ('x' * 201 + ' y', None),
    ],
)
def test_a_grant_for_a_plain_command_names_its_first_word(command: str, prefix: str | None) -> None:
    assert grantable(command) == prefix
