from verifold.society.labels import DEFAULT_MODEL, MAX_MODEL, awaits_model, label


def test_a_name_holds_the_harness_and_the_model_and_gets_a_number_only_when_another_agent_has_it() -> None:
    first = label('Claude Code', 'Opus 5.5', ())
    second = label('Codex', 'gpt-6.1-sol', ('Codex · gpt-6.1-sol', first))
    third = label('Codex', 'gpt-6.1-sol', ('codex · GPT-6.1-sol', second))

    assert (first, second, third) == ('Claude Code · Opus 5.5', 'Codex · gpt-6.1-sol 2', 'Codex · gpt-6.1-sol 3')


def test_a_name_invents_no_model_and_keeps_a_long_model_name_short() -> None:
    unknown = label('Codex', None, ())
    long = label('Codex', f'  model\n{"x" * 200}', ())

    assert unknown == f'Codex · {DEFAULT_MODEL}'
    assert label('Codex', '  ', (unknown,)) == 'Codex · default model 2'
    assert (long.startswith('Codex · model xxx'), len(long)) == (True, len('Codex · ') + MAX_MODEL)
    # Two long names that differ only at the end stay apart, and a name is one printable line.
    family = 'us.vendor.very-long-provider-prefix-for-a-model-of-the-family-that-we-test-'
    assert label('Codex', f'{family}small-v1', ()) != label('Codex', f'{family}large-v1', ())
    assert label('Codex', f'{family}small-v1', ()).endswith('test-small-v1')
    assert label('Codex', 'gpt\u202e-6\u200b\tsol', ()) == 'Codex · gpt -6 sol'


def test_only_a_name_that_verifold_built_without_a_model_waits_for_one() -> None:
    assert awaits_model('Codex · default model', 'Codex')
    assert awaits_model('Codex · default model 12', 'Codex')
    assert not awaits_model('Codex · gpt-6.1-sol', 'Codex')
    assert not awaits_model('Codex · default model', 'Claude Code')
    assert not awaits_model('Codex · default model x', 'Codex')
    # A record from before these names holds names such as "Agent 3", which stay.
    assert not awaits_model('Agent 3', 'Codex')
    # A name that holds the ID of the model that the person chose waits for the harness's own name for it.
    assert awaits_model('Codex · gpt-6.1-sol 2', 'Codex', 'gpt-6.1-sol')
    assert not awaits_model('Codex · GPT 6.1 Sol', 'Codex', 'gpt-6.1-sol')
