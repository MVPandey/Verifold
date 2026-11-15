from pathlib import Path

import pytest

from verifold.protocol.app import MAX_NORMS
from verifold.store.errors import NormsUnreadable, SettingsUnwritable
from verifold.store.norms_file import DEFAULTS, read_norms, write_norms


def test_a_folder_without_a_norms_file_gives_the_default_that_a_new_lab_gets(tmp_path: Path) -> None:
    assert read_norms(tmp_path, 'LAB.md') == (DEFAULTS['LAB.md'], False)
    assert read_norms(tmp_path / 'missing', 'WRITING.md') == (DEFAULTS['WRITING.md'], False)
    assert DEFAULTS['LAB.md'].startswith("# The lab's norms")


def test_a_saved_norms_file_reads_back_and_the_write_makes_the_lab_folder(tmp_path: Path) -> None:
    folder = tmp_path / '.verifold'

    write_norms(folder, 'LAB.md', '# Our rules\n\n- Be brief.\n')
    write_norms(folder, 'LAB.md', '# Our rules\n')

    assert read_norms(folder, 'LAB.md') == ('# Our rules\n', True)
    assert [path.name for path in folder.iterdir()] == ['LAB.md']


def test_a_norms_file_that_is_a_link_is_not_read_and_not_written(tmp_path: Path) -> None:
    secret = tmp_path / 'secret.txt'
    secret.write_text('a key')
    (tmp_path / 'LAB.md').symlink_to(secret)

    with pytest.raises(NormsUnreadable, match='is a link'):
        read_norms(tmp_path, 'LAB.md')
    with pytest.raises(SettingsUnwritable, match='is a link'):
        write_norms(tmp_path, 'LAB.md', '# Mine')
    assert secret.read_text() == 'a key'


def test_a_norms_file_that_is_too_large_or_not_text_is_not_shown(tmp_path: Path) -> None:
    (tmp_path / 'LAB.md').write_text('x' * (MAX_NORMS + 1))
    (tmp_path / 'WRITING.md').write_bytes(b'\xff\xfe\x00')

    with pytest.raises(NormsUnreadable, match='more than 100,000 characters'):
        read_norms(tmp_path, 'LAB.md')
    with pytest.raises(NormsUnreadable, match="Can't read"):
        read_norms(tmp_path, 'WRITING.md')
