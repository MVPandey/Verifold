import os
from pathlib import Path

import pytest

from verifold.protocol.app import MAX_NORMS
from verifold.store.errors import NormsUnreadable, SettingsUnwritable
from verifold.store.norms_file import (
    DEFAULTS,
    NormsRead,
    missing_lines,
    read_norms,
    revision,
    write_missing_norms,
    write_norms,
)


def test_a_folder_without_a_norms_file_gives_the_default_that_a_new_lab_gets(tmp_path: Path) -> None:
    assert read_norms(tmp_path, 'LAB.md') == NormsRead(text=DEFAULTS['LAB.md'], saved=False)
    assert read_norms(tmp_path / 'missing', 'WRITING.md') == NormsRead(text=DEFAULTS['WRITING.md'], saved=False)
    assert DEFAULTS['LAB.md'].startswith("# The lab's norms")


def test_a_saved_norms_file_reads_back_with_its_time_and_the_write_makes_the_lab_folder(tmp_path: Path) -> None:
    folder = tmp_path / '.verifold'

    write_norms(folder, 'LAB.md', '# Our rules\n\n- Be brief.\n')
    write_norms(folder, 'LAB.md', '# Règles\n')

    read = read_norms(folder, 'LAB.md')
    assert (read.text, read.saved) == ('# Règles\n', True)
    assert read.changed_at is not None
    assert read.changed_at.timestamp() == pytest.approx((folder / 'LAB.md').stat().st_mtime)
    assert (folder / 'LAB.md').read_bytes() == '# Règles\n'.encode()
    assert [path.name for path in folder.iterdir()] == ['LAB.md']
    assert revision('# Règles\n') != revision('# Regles\n')


def test_a_norms_file_that_is_a_link_is_not_read_and_not_written(tmp_path: Path) -> None:
    secret = tmp_path / 'secret.txt'
    secret.write_text('a key')
    (tmp_path / 'LAB.md').symlink_to(secret)

    with pytest.raises(NormsUnreadable, match='is a link'):
        read_norms(tmp_path, 'LAB.md')
    with pytest.raises(SettingsUnwritable, match='is a link'):
        write_norms(tmp_path, 'LAB.md', '# Mine')
    assert secret.read_text() == 'a key'


def test_a_pipe_or_a_folder_in_place_of_a_norms_file_gives_an_error_and_does_not_block(tmp_path: Path) -> None:
    os.mkfifo(tmp_path / 'LAB.md')
    (tmp_path / 'WRITING.md').mkdir()

    for name in ('LAB.md', 'WRITING.md'):
        with pytest.raises(NormsUnreadable, match='is not a regular file'):
            read_norms(tmp_path, name)
    blocked = tmp_path / 'file'
    blocked.write_text('x')
    with pytest.raises(NormsUnreadable, match="Can't read"):
        read_norms(blocked, 'LAB.md')


def test_a_norms_file_that_is_too_large_or_not_text_is_not_shown_and_bad_text_is_not_written(tmp_path: Path) -> None:
    (tmp_path / 'LAB.md').write_text('x' * (MAX_NORMS + 1))
    (tmp_path / 'WRITING.md').write_bytes(b'\xff\xfe\x00')

    with pytest.raises(NormsUnreadable, match='more than 100,000 characters'):
        read_norms(tmp_path, 'LAB.md')
    with pytest.raises(NormsUnreadable, match="Can't read"):
        read_norms(tmp_path, 'WRITING.md')
    # A text that UTF-8 cannot hold is refused, and the file stays as it was.
    with pytest.raises(SettingsUnwritable, match="Can't write"):
        write_norms(tmp_path, 'WRITING.md', 'half \ud800 a pair')
    assert (tmp_path / 'WRITING.md').read_bytes() == b'\xff\xfe\x00'
    assert sorted(path.name for path in tmp_path.iterdir()) == ['LAB.md', 'WRITING.md']


def test_a_lab_gets_only_the_norms_files_that_it_lacks_and_no_write_goes_through_a_link(tmp_path: Path) -> None:
    (tmp_path / 'LAB.md').write_text('# Our own rules\n')
    outside = tmp_path / 'outside.md'
    (tmp_path / 'WRITING.md').symlink_to(outside)

    write_missing_norms(tmp_path)

    assert (tmp_path / 'LAB.md').read_text() == '# Our own rules\n'
    # The link leads nowhere. Verifold leaves it, and writes nothing at the place that it names.
    assert not outside.exists()
    (tmp_path / 'WRITING.md').unlink()
    write_missing_norms(tmp_path)
    assert (tmp_path / 'WRITING.md').read_text() == DEFAULTS['WRITING.md']


def test_a_file_from_an_older_default_shows_the_lines_that_the_current_default_has_and_it_lacks() -> None:
    lines = DEFAULTS['LAB.md'].splitlines()
    older = '\n'.join(line for line in lines if 'helper field' not in line and 'with a rerun' not in line)

    missing = missing_lines('LAB.md', older + '\n- A norm of our own.\n')

    assert len(missing) == 2
    assert 'helper field' in missing[0]
    assert missing[1].startswith('- When you check a result with a rerun')
    assert missing_lines('LAB.md', DEFAULTS['LAB.md']) == ()
    assert missing_lines('WRITING.md', '') == tuple(
        line for line in DEFAULTS['WRITING.md'].splitlines() if line.strip()
    )
