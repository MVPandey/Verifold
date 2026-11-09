import os
import subprocess
import sys
from pathlib import Path

from verifold.store.server_file import ServerProcess, running_server, server_file


def test_the_file_names_this_process_while_it_serves_and_goes_after(tmp_path: Path) -> None:
    path = tmp_path / '.verifold' / 'server.json'

    with server_file(path):
        named = running_server(path)
        assert named is not None
        assert named.pid == os.getpid()

    assert not path.exists()
    assert running_server(path) is None


def test_a_file_for_an_ended_or_another_process_names_none(tmp_path: Path) -> None:
    path = tmp_path / 'server.json'
    ended = subprocess.Popen([sys.executable, '-c', 'pass'])
    ended.wait()

    path.write_text(ServerProcess(pid=ended.pid, started=0.0).model_dump_json())
    assert running_server(path) is None

    # The same process ID with another start time is a later process that got the ID.
    path.write_text(ServerProcess(pid=os.getpid(), started=0.0).model_dump_json())
    assert running_server(path) is None

    path.write_text('not a server file')
    assert running_server(path) is None
