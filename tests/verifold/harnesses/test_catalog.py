from fakes import FAKE_HARNESS

from verifold.harnesses.catalog import CATALOG, NPX_PROJECT, available, catalog_with
from verifold.protocol.settings import HarnessSettings


def test_a_harness_is_available_when_its_command_and_its_adapter_are_on_the_path() -> None:
    missing = FAKE_HARNESS.model_copy(update={'executable': 'no-such-harness-here'})

    assert (available(FAKE_HARNESS), available(missing)) == (True, False)


def test_the_catalog_names_each_harness_by_its_own_name() -> None:
    assert all(name == entry.name for name, entry in CATALOG.items())


def test_the_built_in_adapters_take_an_npm_project_of_their_own() -> None:
    # npm would otherwise run a package from the node_modules of the folder that the adapter starts in, and read its
    # .npmrc: the project, or an agent's worktree.
    assert all(entry.command[:3] == ('npx', '--prefix', str(NPX_PROJECT)) for entry in CATALOG.values())


def test_the_persons_harnesses_join_the_built_in_ones_and_replace_a_built_in_by_name() -> None:
    harnesses = {
        'gemini': HarnessSettings(command=('gemini', '--experimental-acp'), family='google'),
        'codex': HarnessSettings(command=('codex-acp',), family='openai', title='My Codex', executable='codex'),
    }

    catalog = catalog_with(harnesses)

    assert list(catalog) == ['claude-code', 'codex', 'gemini']
    assert catalog['claude-code'] == CATALOG['claude-code']
    gemini = catalog['gemini']
    assert (gemini.title, gemini.executable, gemini.command, gemini.family) == (
        'gemini',
        'gemini',
        ('gemini', '--experimental-acp'),
        'google',
    )
    assert (catalog['codex'].title, catalog['codex'].command) == ('My Codex', ('codex-acp',))
