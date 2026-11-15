from pathlib import Path

import pytest
from builders import START

from verifold.protocol.events import RerunTaken
from verifold.runner.folders import agent_folder
from verifold.runner.git import commit_of, git
from verifold.runner.reruns import Reruns, rerun_ref
from verifold.runner.snapshots import pin
from verifold.server.errors import EvidenceRejected, NoCleanCopy


async def a_claim(project: Path) -> RerunTaken:
    """Give ada a result file that a post pins, and return bo's take of the rerun of that post."""
    project.mkdir()
    author = await agent_folder(project, 'ada')
    (author / 'result.txt').write_text('11.8')
    (author / 'notes.txt').write_text('How I got there.')
    pinned = await pin(author, 'ada', ('result.txt',))
    (author / 'result.txt').write_text('changed later')
    return RerunTaken(seq=9, at=START, agent='bo', post='p-4', commit=pinned[0].commit)


async def test_a_clean_copy_is_in_the_takers_own_folder_and_a_check_pins_its_files_from_it(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    taken = await a_claim(project)
    reruns = Reruns(project, 'bo')

    copy = await reruns.make(taken, 'ada')

    taker = await agent_folder(project, 'bo')
    assert copy.is_relative_to(taker)
    assert (copy / 'result.txt').read_text() == '11.8'
    assert await reruns.make(taken, 'ada') == copy

    # The agent reruns in the copy, and the evidence of its check is the copy's own file at the copy's commit.
    (copy / 'rerun.txt').write_text('11.8')
    (taker / 'rerun.txt').write_text('A file of the same name in the folder of the agent itself.')
    evidence = await reruns.pin(taken, ('rerun.txt',))

    assert [file.path for file in evidence] == ['rerun.txt']
    commit = evidence[0].commit
    assert await commit_of(copy, rerun_ref('bo', 'p-4')) == commit
    # The agent's own repository holds the commit, where the app reads the files of the agent's posts.
    assert await git('show', f'{commit}:rerun.txt', cwd=taker) == '11.8'
    assert await git('show', f'{commit}:result.txt', cwd=taker) == '11.8'
    # The commit holds the clean copy and nothing of the agent's own folder.
    assert sorted((await git('ls-tree', '-r', '--name-only', commit, cwd=taker)).split()) == [
        'notes.txt',
        'rerun.txt',
        'result.txt',
    ]


async def test_a_check_names_files_of_the_clean_copy_only(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    taken = await a_claim(project)
    reruns = Reruns(project, 'bo')

    with pytest.raises(EvidenceRejected, match=r'The clean copy .* is gone'):
        await reruns.pin(taken, ('rerun.txt',))

    await reruns.make(taken, 'ada')
    (await agent_folder(project, 'bo') / 'mine.txt').write_text('Not in the copy.')
    with pytest.raises(EvidenceRejected, match=r'These files are not in the clean copy: mine\.txt'):
        await reruns.pin(taken, ('mine.txt',))


async def test_a_clean_copy_that_cannot_be_made_is_an_error_that_the_agent_reads(tmp_path: Path) -> None:
    project = tmp_path / 'project'
    taken = await a_claim(project)

    with pytest.raises(NoCleanCopy, match='Verifold could not make the clean copy of post p-4'):
        await Reruns(project, 'bo').make(taken.model_copy(update={'commit': 'f' * 40}), 'ada')
