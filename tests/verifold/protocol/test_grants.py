import pytest
from pydantic import TypeAdapter, ValidationError

from verifold.protocol.grants import Grant, plain

GRANT: TypeAdapter[str] = TypeAdapter(Grant)


def test_a_grant_is_the_start_of_one_plain_command() -> None:
    assert GRANT.validate_python('  ./gpu python3 ') == './gpu python3'


@pytest.mark.parametrize('prefix', ['', './gpu; rm', 'a && b', 'a | b', 'a > b', 'a < b', '`a`', '$(a)', 'a\nb'])
def test_a_grant_holds_no_shell_operator(prefix: str) -> None:
    with pytest.raises(ValidationError):
        GRANT.validate_python(prefix)


def test_a_plain_command_has_no_shell_operator() -> None:
    assert (plain('./gpu python3 train.py 0'), plain('./gpu x 2>&1')) == (True, False)
