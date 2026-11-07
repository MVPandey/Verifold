from fakes import FAKE_HARNESS

from verifold.harnesses.catalog import CATALOG, available


def test_a_harness_is_available_when_its_command_and_its_adapter_are_on_the_path() -> None:
    missing = FAKE_HARNESS.model_copy(update={'executable': 'no-such-harness-here'})

    assert (available(FAKE_HARNESS), available(missing)) == (True, False)


def test_the_catalog_names_each_harness_by_its_own_name() -> None:
    assert all(name == entry.name for name, entry in CATALOG.items())
