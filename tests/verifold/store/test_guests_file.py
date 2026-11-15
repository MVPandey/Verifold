import stat
from pathlib import Path

from verifold.store.guests_file import Guests, keep_guest, read_guests


def test_the_file_keeps_each_guests_digest_and_the_port_and_only_the_person_reads_it(tmp_path: Path) -> None:
    path = tmp_path / '.verifold' / 'guests.json'

    assert read_guests(path) == Guests()
    keep_guest(path, 'agent-2', 'a' * 64, 8123)
    keep_guest(path, 'agent-3', 'b' * 64, 8200)

    assert read_guests(path) == Guests(port=8200, digests={'agent-2': 'a' * 64, 'agent-3': 'b' * 64})
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert [item.name for item in path.parent.iterdir()] == ['guests.json']


def test_a_file_that_is_not_valid_holds_no_guest(tmp_path: Path) -> None:
    path = tmp_path / 'guests.json'
    path.write_text('{"version": 9}')

    assert read_guests(path) == Guests()


def test_a_file_that_cannot_be_written_leaves_the_old_one_and_no_other_file(tmp_path: Path) -> None:
    path = tmp_path / 'guests.json'
    path.mkdir()

    try:
        keep_guest(path, 'agent-2', 'a' * 64, None)
    except OSError:
        pass
    else:
        raise AssertionError('The write passed.')

    assert [item.name for item in tmp_path.iterdir()] == ['guests.json']
