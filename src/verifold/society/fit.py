"""
The one size budget of a brief: which parts the board cuts when a brief is larger than one tool result, and in what order.

A brief has `MAX_BRIEF` characters of JSON at most. The parts that an agent must not lose are never cut: the
question, the board's instructions, the agent's own line and notes, the lab's state, time, budget, and limits, the
reading, the open round, the person's post that waits for the coordinator, and the posts for the agent in its news.
Every other part has a place in `CUTS`. The board cuts whole lines from the first part there until the brief fits,
then from the next one, and the brief says in `cut` what it left out and which tool shows it.
"""

from collections.abc import Callable, Mapping
from typing import Literal

from verifold.protocol.join import MAX_BRIEF, Brief

type Part = Literal[
    'quiet_threads',
    'one_agent_threads',
    'moves',
    'side_threads',
    'reruns_wanted',
    'news.reruns',
    'open_tasks',
    'open_calls',
    'open_asks',
    'obstacles',
    'not_checked',
    'not_built_on',
    'disputed',
    'left',
    'news.others',
    'threads',
    'news.rounds',
    'offers',
    'candidates',
    'agents',
    'steering',
    'news.for_you',
]
"""A part of a brief that the board can cut, by its field."""

CUTS: tuple[Part, ...] = (
    'quiet_threads',
    'one_agent_threads',
    'moves',
    'side_threads',
    'reruns_wanted',
    'news.reruns',
    'open_tasks',
    'open_calls',
    'open_asks',
    'obstacles',
    'not_checked',
    'not_built_on',
    'disputed',
    'left',
    'news.others',
    'threads',
    'news.rounds',
    'offers',
    'candidates',
    'agents',
    'steering',
    'news.for_you',
)
"""
The parts that the board cuts, the first first, each down to its floor before the next.

The lists that point to the threads go first, because `threads` shows every thread, and so do the coordinator's
moves, which `steering` lists. In the lists of posts, a post
keeps its ID and loses its line, because `thread` shows each post. The lists of posts go in the reverse of their
order in the brief, so a post that an earlier list holds keeps its line there while a later list holds its ID. The
other posts of the news, the threads, the entries of closed rounds, and the offers of the deliverables come after
them. The candidates lose their lines but stay by their IDs, and the other agents lose the lines of their plans and
latest posts but stay. Then the coordinator's steering facts go, which the tool `steering` returns. Last, the news
ends earlier: the next result brings the posts for the agent that it holds no
longer, so none is lost.
"""

FLOOR: Mapping[Part, int] = {'news.for_you': 1}
"""The fewest lines that a part keeps. A news holds one post for the agent at least."""

type Keep = Mapping[Part, int]
"""For each part, how many of its lines the brief keeps: the newest, or the ones that the part says."""

type Render = Callable[[Keep], Brief]
"""Builds the brief that keeps the lines that `Keep` says."""


def fit(render: Render, full: Keep, budget: int = MAX_BRIEF) -> Brief:
    """
    Return the brief with the most lines whose JSON has `budget` characters at most.

    `full` says how many lines each part has. A part that it leaves out is never cut. The board cuts the parts in
    the order of `CUTS`, each to the most lines that fit, or to its floor before it cuts the next part. When the
    parts that are never cut are larger than the budget by themselves, the brief is larger too.
    """
    made: dict[tuple[tuple[Part, int], ...], tuple[Brief, int]] = {}

    def built(keep: dict[Part, int]) -> tuple[Brief, int]:
        key = tuple(sorted(keep.items()))
        if key not in made:
            view = render(keep)
            made[key] = (view, len(view.model_dump_json()))
        return made[key]

    keep = dict(full)
    view, size = built(keep)
    for part in CUTS:
        least = FLOOR.get(part, 0)
        if size <= budget:
            break
        if keep.get(part, least) <= least:
            continue
        # The most lines of this part that fit, as all of them do not. When the floor does not fit either, the part
        # keeps its floor, and the next part is cut.
        fits, over = least, keep[part]
        if built(keep | {part: least})[1] <= budget:
            while over - fits > 1:
                middle = (fits + over) // 2
                fits, over = (middle, over) if built(keep | {part: middle})[1] <= budget else (fits, middle)
        keep[part] = fits
        view, size = built(keep)
    return view


_BY_ID = '`{part}` leaves out {lines} and holds those posts by ID alone. `thread` shows each post.'

CUT_LINES: Mapping[Part, str] = {
    'quiet_threads': '`quiet_threads` leaves out {lines}. `threads` shows every thread.',
    'one_agent_threads': '`one_agent_threads` leaves out {lines}. `threads` shows every thread.',
    'moves': "`moves` leaves out {lines} of the coordinator's older moves. `steering` shows them.",
    'side_threads': '`side_threads` leaves out {lines}. `threads` shows every thread.',
    'reruns_wanted': '`reruns_wanted` leaves out {lines} of older reruns, the reruns of {named}. `take_rerun` takes one by its post.',
    'news.reruns': '`reruns` of `news` leaves out {lines} of reruns that you can take. The news of a later result has them.',
    'open_tasks': _BY_ID,
    'open_calls': _BY_ID,
    'open_asks': _BY_ID,
    'obstacles': _BY_ID,
    'not_checked': _BY_ID,
    'not_built_on': _BY_ID,
    'disputed': _BY_ID,
    'left': '`left` leaves out {lines} of agents that left: {named}. Their posts stay, and `thread` shows them.',
    'news.others': '`others` of `news` leaves out {lines} of older posts. `threads` and `thread` show them.',
    'threads': '`threads` leaves out {lines}. The tool `threads` shows every thread.',
    'news.rounds': (
        '`rounds` of `news` leaves out {lines} of entries, and `left_out` of each round counts them. `thread` shows '
        'each one whole.'
    ),
    'offers': "`deliverables` leaves out {lines} of older offers. `thread` shows them in each deliverable's `thread`.",
    'candidates': '`candidates` leaves out {lines}, and `older_candidates` names them. `thread` shows each proposal.',
    'agents': '`agents` leaves out the plans and latest posts of {named}. `thread` shows them.',
    'steering': '`steering` is left out of this brief. The tool `steering` shows the steering facts.',
    'news.for_you': (
        '`news` leaves out {lines} of posts for you, and `more` counts them. The news of the next result has them.'
    ),
}
"""The fact that a brief left out lines of a part, with what shows them, for each part."""


def cut_line(part: Part, count: int, ids: tuple[str, ...] = ()) -> str:
    """Return the fact that a brief left out `count` lines of a part, with what shows them. `ids` names them."""
    lines = f'{count} {"line" if count == 1 else "lines"}'
    return CUT_LINES[part].format(part=part, lines=lines, named=', '.join(ids))
