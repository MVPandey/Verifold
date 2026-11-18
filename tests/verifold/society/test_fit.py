from verifold.protocol.join import Brief, News
from verifold.society.fit import CUTS, Keep, cut_line, fit


def _render(keep: Keep) -> Brief:
    # A brief whose size grows by 100 characters for each line of quiet threads that it keeps, and by 1,000 for
    # each line of the agents.
    size = 100 * keep.get('quiet_threads', 0) + 1_000 * keep.get('agents', 0)
    return Brief(you='ada', question='Does it hold?', news=News(seq=0), how='x' * size)


def _size(keep: Keep) -> int:
    return len(_render(keep).model_dump_json())


def test_a_brief_that_fits_keeps_every_line() -> None:
    full: Keep = {'quiet_threads': 10, 'agents': 5}

    assert fit(_render, full, budget=_size(full)).how == _render(full).how


def test_the_board_cuts_the_first_part_to_nothing_before_it_cuts_the_next_and_that_one_only_as_far_as_it_needs() -> (
    None
):
    full: Keep = {'quiet_threads': 10, 'agents': 5}

    view = fit(_render, full, budget=_size({'quiet_threads': 0, 'agents': 2}) + 999)

    # The quiet threads come before the agents in the order of the cuts.
    assert CUTS.index('quiet_threads') < CUTS.index('agents')
    assert len(view.how) == 2_000


def test_a_part_that_full_leaves_out_is_never_cut_and_a_brief_that_never_fits_is_the_smallest_one() -> None:
    def render(keep: Keep) -> Brief:
        # Seven lines of quiet threads that `full` does not name, and the lines of the agents.
        return _render({'quiet_threads': keep.get('quiet_threads', 7), 'agents': keep.get('agents', 0)})

    view = fit(render, {'agents': 5}, budget=10)

    assert len(view.how) == 700


def test_the_news_keeps_one_post_for_the_agent_at_least() -> None:
    def render(keep: Keep) -> Brief:
        return Brief(you='ada', question='Does it hold?', news=News(seq=keep['news.for_you']), how='x' * 1_000)

    assert fit(render, {'news.for_you': 20}, budget=10).news.seq == 1


def test_each_cut_says_how_many_lines_it_left_out_and_what_shows_them() -> None:
    assert cut_line('not_checked', 1) == (
        '`not_checked` leaves out 1 line and holds those posts by ID alone. `thread` shows each post.'
    )
    assert cut_line('agents', 2, ('agent-2', 'agent-3')) == (
        '`agents` leaves out the plans and latest posts of agent-2, agent-3. `thread` shows them.'
    )
    assert cut_line('reruns_wanted', 2, ('p-4', 'p-9')) == (
        '`reruns_wanted` leaves out 2 lines of older reruns, the reruns of p-4, p-9. `take_rerun` takes one by its post.'
    )
