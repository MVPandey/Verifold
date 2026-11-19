import os
from pathlib import Path

from verifold.protocol.settings import DiskSettings
from verifold.runner.disk import DiskMeter, size
from verifold.server.lab import Lab


def blocks(path: Path) -> int:
    return os.lstat(path).st_blocks * 512


def test_a_size_counts_the_blocks_of_each_file_once_and_follows_no_link(tmp_path: Path) -> None:
    folder = tmp_path / 'folder'
    (folder / 'inner').mkdir(parents=True)
    (folder / 'data.bin').write_bytes(b'x' * 100_000)
    (folder / 'inner' / 'more.bin').write_bytes(b'y' * 50_000)
    os.link(folder / 'data.bin', folder / 'inner' / 'same.bin')
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'huge.bin').write_bytes(b'z' * 1_000_000)
    (folder / 'away').symlink_to(outside)

    measured = size(folder)

    parts = (folder, folder / 'inner', folder / 'data.bin', folder / 'inner' / 'more.bin', folder / 'away')
    assert measured == sum(blocks(part) for part in parts)
    assert size(folder / 'away') == blocks(folder / 'away')
    assert size(tmp_path / 'missing') == 0


async def test_a_measure_of_one_agent_keeps_the_others_and_the_lab_hears_every_measure(
    lab: Lab, tmp_path: Path
) -> None:
    project = tmp_path / 'project'
    agents = project / '.verifold' / 'agents'
    for agent in ('ada', 'bo'):
        (agents / agent).mkdir(parents=True)
        (agents / agent / 'work.bin').write_bytes(b'w' * 20_000)
    (project / '.verifold' / 'reruns' / 'p-1').mkdir(parents=True)
    (project / '.verifold' / 'snapshots.git').mkdir()
    meter = DiskMeter(project, lab)

    first = await meter.measure()
    (agents / 'ada' / 'more.bin').write_bytes(b'm' * 200_000)
    (agents / 'bo' / 'more.bin').write_bytes(b'm' * 200_000)
    second = await meter.measure('ada')

    assert set(first.folders) == {'ada', 'bo'}
    assert second.folders['bo'] == first.folders['bo']
    assert second.folders['ada'] > first.folders['ada']
    assert second.total == sum(second.folders.values()) + second.reruns + second.snapshots
    assert lab.disk == second


async def test_a_measure_above_the_disk_limit_stops_the_lab(lab: Lab, tmp_path: Path) -> None:
    folder = tmp_path / '.verifold' / 'agents' / 'ada'
    folder.mkdir(parents=True)
    (folder / 'big.bin').write_bytes(b'b' * 100_000)
    await lab.set_settings(lab.board.settings.model_copy(update={'disk': DiskSettings(limit_gb=0)}))
    meter = DiskMeter(tmp_path, lab)
    await meter.measure()
    assert lab.board.halted is None

    # A limit that the files reach stops the lab in the step that sets it.
    await lab.set_settings(lab.board.settings.model_copy(update={'disk': DiskSettings(limit_gb=1)}))
    assert lab.board.halted is None
    lab_disk = lab.disk
    assert lab_disk is not None
    await lab.measured(lab_disk.model_copy(update={'total': 2 * 1024**3}))

    assert lab.board.halted == 'disk'


async def test_a_turn_that_ends_within_a_minute_of_a_measure_waits_for_the_next_and_a_new_limit_measures_at_once(
    lab: Lab, tmp_path: Path
) -> None:
    agents = tmp_path / '.verifold' / 'agents'
    for agent in ('ada', 'bo'):
        (agents / agent).mkdir(parents=True)
    meter = DiskMeter(tmp_path, lab)

    start = await meter.measure()
    (agents / 'bo' / 'more.bin').write_bytes(b'm' * 200_000)
    skipped = await meter.turn_ended('bo')
    unchanged = lab.disk
    # Each look at the lab's clock of this test is one second.
    for _ in range(60):
        lab.now()
    later = await meter.turn_ended('ada')
    (agents / 'ada' / 'more.bin').write_bytes(b'm' * 200_000)
    # A new disk limit measures at once, also within a minute of the last measure.
    fresh = await meter.measure()

    assert (skipped, unchanged) == (None, start)
    assert later is not None
    # The folder of the turn that ended within the minute counts at the next measure.
    assert later.folders['bo'] > start.folders['bo']
    assert fresh.folders['ada'] > later.folders['ada']
    assert lab.disk == fresh
