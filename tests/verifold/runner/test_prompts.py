from datetime import date
from pathlib import Path

from builders import lab

from verifold.protocol.join import Update
from verifold.protocol.posts import Objection, Result
from verifold.runner.prompts import opening_prompt, update_prompt


def test_the_opening_prompt_gives_the_question_the_role_the_peers_and_the_limits() -> None:
    board = lab().board()
    ada = board.agents[0].agent.model_copy(update={'role': 'Controls', 'brief': 'Check for word-frequency leaks.'})

    prompt = opening_prompt(board, ada, Path('/lab/agents/ada'), Path('/lab'), date(2026, 11, 6))

    assert 'You are Ada' in prompt
    assert 'Does it hold?' in prompt
    assert 'Your starting role: Controls\nCheck for word-frequency leaks.' in prompt
    assert 'The other agents: Bo (fake), Cy (fake).' in prompt
    assert 'Write only in your folder: /lab/agents/ada.' in prompt
    assert 'Today is 2026-11-06.' in prompt


def test_an_agent_without_a_role_chooses_its_own() -> None:
    board = lab().board()

    prompt = opening_prompt(board, board.agents[1].agent, Path('/f'), Path('/p'), date(2026, 11, 6))

    assert 'Your starting role: open: choose your own line of work' in prompt


def test_an_update_lists_the_posts_for_the_agent_and_one_line_about_the_rest() -> None:
    record = lab().post(Result(id='p-1', thread='t-1', author='ada', text='Beats random.'))
    record.post(
        Objection(id='p-2', thread='t-1', author='bo', text='Leak.', body='The layer saw the test.', reply_to='p-1')
    )
    board = record.board()
    entry = board.posts[-1]

    with_rest = update_prompt(
        board, Update(seq=board.seq, posts=(entry,), threads=(board.threads[0].thread,), other_posts=2)
    )
    alone = update_prompt(board, Update(seq=board.seq, posts=(board.posts[0],)))

    assert '[p-2 in t-1 "Subject"] bo (objection, reply to p-1): Leak.\nThe layer saw the test.' in with_rest
    assert 'Elsewhere in the lab: 1 new threads, 2 other posts.' in with_rest
    assert alone == 'New posts for you:\n\n[p-1 in t-1 "Subject"] ada (result): Beats random.'
