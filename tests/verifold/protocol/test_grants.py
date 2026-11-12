import pytest
from pydantic import TypeAdapter, ValidationError

from verifold.protocol.grants import Grant, plain

GRANT: TypeAdapter[str] = TypeAdapter(Grant)


def test_a_grant_is_the_start_of_one_plain_command() -> None:
    assert GRANT.validate_python('  ./gpu python3 ') == './gpu python3'


@pytest.mark.parametrize('prefix', ['', '   ', './gpu; rm', 'a | b', '$(a)', "'my tool'", 'x' * 201])
def test_a_grant_is_not_empty_too_long_or_more_than_a_plain_command(prefix: str) -> None:
    with pytest.raises(ValidationError):
        GRANT.validate_python(prefix)


@pytest.mark.parametrize(
    'command',
    [
        './gpu',
        ' ./gpu  python3 train.py 0 ',
        'make -j4 test',
        'python3 run.py --lr=1e-3 --out=a/b_c.json',
        'x@1 50% a,b +1',
    ],
)
def test_a_plain_command_is_words_of_letters_digits_and_a_few_signs(command: str) -> None:
    assert plain(command)


@pytest.mark.parametrize(
    'command',
    [
        '',
        './gpu x; rm -rf y',
        './gpu x && y',
        './gpu x | tail -1',
        './gpu x 2>&1',
        './gpu x > out',
        './gpu < in',
        './gpu `id`',
        './gpu $(id)',
        './gpu =(id)',
        "./gpu *(e:'id':)",
        './gpu ${HOME}',
        './gpu $[1]',
        './gpu ~/x',
        './gpu x\\',
        './gpu x\nid',
        './gpu x\rid',
        './gpu x\x0bid',
        './gpu\tx',
        './gpu "a b"',
        './gpu {a,b}',
        './gpu a?',
        './gpu =id',
        'A=1 ./gpu =x',
    ],
)
def test_a_sign_that_a_shell_acts_on_makes_a_command_not_plain(command: str) -> None:
    assert not plain(command)
