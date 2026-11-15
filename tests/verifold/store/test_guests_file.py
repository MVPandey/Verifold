import stat
from pathlib import Path

import pytest

from verifold.store.errors import GuestsInvalid
from verifold.store.guests_file import Guests, keep_guest, read_guests


def test_the_file_keeps_each_guests_digest_and_the_port_and_only_the_person_reads_it(tmp_path: Path) -> None:
    path = tmp_path / '.verifold' / 'guests.json'

    assert read_guests(path) == Guests()
    keep_guest(path, 'agent-2', 'a' * 64, 8123)
    keep_guest(path, 'agent-3', 'b' * 64, 8200)

    assert read_guests(path) == Guests(port=8200, digests={'agent-2': 'a' * 64, 'agent-3': 'b' * 64})
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert [item.name for item in path.parent.iterdir()] == ['guests.json']


def test_a_new_digest_for_a_guest_replaces_its_old_one(tmp_path: Path) -> None:
    path = tmp_path / 'guests.json'
    keep_guest(path, 'agent-2', 'a' * 64, 8123)
    keep_guest(path, 'agent-2', 'b' * 64, 8123)

    assert read_guests(path).digests == {'agent-2': 'b' * 64}


@pytest.mark.parametrize('content', ['{"version": 9}', 'not json', '{"version": 1, "digests": {"Bad ID": "a"}}'])
def test_a_file_that_is_not_valid_is_refused_and_a_new_guest_does_not_overwrite_it(
    tmp_path: Path, content: str
) -> None:
    path = tmp_path / 'guests.json'
    path.write_text(content)

    with pytest.raises(GuestsInvalid, match='is not a valid file of invitations'):
        read_guests(path)
    with pytest.raises(GuestsInvalid, match='Delete the file'):
        keep_guest(path, 'agent-2', 'a' * 64, None)

    assert path.read_text() == content


def test_a_write_that_fails_leaves_the_old_file_and_no_other_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / 'guests.json'
    keep_guest(path, 'agent-2', 'a' * 64, 8123)

    def fail(*_: object) -> None:
        raise OSError('No space left on device')

    monkeypatch.setattr(Path, 'replace', fail)
    with pytest.raises(OSError, match='No space left'):
        keep_guest(path, 'agent-3', 'b' * 64, 8123)

    assert read_guests(path).digests == {'agent-2': 'a' * 64}
    assert [item.name for item in tmp_path.iterdir()] == ['guests.json']
