from collections.abc import Iterator
from dataclasses import replace

from builders import lab

from verifold.protocol.events import Posted
from verifold.protocol.posts import Message


class Counted(tuple[Posted, ...]):
    """The posts of a board, which count how often a caller reads them from the start."""

    reads = 0

    def __iter__(self) -> Iterator[Posted]:
        Counted.reads += 1
        return super().__iter__()


def test_a_board_with_an_index_finds_a_post_by_its_id_without_reading_every_post() -> None:
    # `standing` asks for a post once for each check of it, so a scan of a large board cost seconds in one brief.
    record = lab()
    for number in range(1, 40):
        record.post(Message(id=f'p-{number}', thread='t-1', author='ada', text='A note.'))
    board = record.board()
    counted = replace(board, posts=Counted(board.posts))
    ids = [entry.post.id for entry in board.posts]

    assert counted.post('p-39') == board.post('p-39')
    scans = Counted.reads
    assert counted.replies('p-1') == ()
    built = Counted.reads

    assert [entry.post.id for entry in map(counted.post, ids) if entry] == ids
    assert counted.post('p-99') is None
    assert (scans > 0, Counted.reads) == (True, built)
