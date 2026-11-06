# Testing

Testing is a first-class discipline. Well-structured tests provide confidence to refactor, serve as living documentation, and prevent regressions.

---

## Core Requirements

| Requirement | Value |
|---|---|
| Test runner | `pytest` (primary/default) |
| Minimum line coverage | Repository CI threshold (often 95%) |
| Mocking | `pytest-mock` (`mocker` fixture) |
| Async tests | `pytest-asyncio` |
| Coverage source | `src/` (used for both libraries and services) |

---

## Recommended Test Dependencies

Add to `pyproject.toml` using Poetry dependency groups:

```toml
[tool.poetry.group.unit-test.dependencies]
pytest = ">=8.0.0,<9.0.0"
pytest-cov = ">=5.0.0,<6.0.0"
pytest-mock = ">=3.14.0,<4.0.0"
pytest-asyncio = ">=0.24.0,<1.0.0"
```

Optional additions (install only when needed):

```toml
[tool.poetry.group.unit-test.dependencies]
# ...existing required dependencies...
freezegun = ">=1.5.0,<2.0.0"    # freeze datetime.now() for deterministic tests
respx = ">=0.21.0,<1.0.0"       # mock httpx requests
pytest-html = ">=4.0.0,<5.0.0"  # HTML test reports
```

---

## Pytest Configuration

Both libraries and services use the `src/` layout, so coverage targets `src/`:

```toml
[tool.pytest.ini_options]
addopts = [
    "--cov=src",
    "--cov-report=xml",
    "--cov-report=term-missing",
    "--cov-fail-under=95",
    "--maxfail=3",
    "--durations=5",
]
asyncio_mode = "auto"
```

- `--maxfail=3` — stop early on cascading failures.
- `--durations=5` — surface the 5 slowest tests for optimization.
- `asyncio_mode = "auto"` — all async tests run automatically without `@pytest.mark.asyncio`.

---

## Test Structure

Mirror the source directory exactly:

```
src/package_name/domain_a/impl.py     →  tests/domain_a/test_impl.py
src/package_name/settings.py          →  tests/test_settings.py
src/my_service/module_a/service.py    →  tests/module_a/test_service.py
```

One test file per source module. Do not group unrelated tests together.

Use `conftest.py` at each level for fixtures scoped to that sub-package:

```
tests/
├── conftest.py          # project-wide fixtures (settings, shared mocks)
├── module_a/
│   ├── conftest.py      # module_a-specific fixtures
│   └── test_service.py
└── module_b/
    └── test_routes.py
```

---

## Test Style

### Name Tests Descriptively

Test names should describe the scenario and expected outcome:

```python
def test_load_config_returns_defaults_when_env_not_set(): ...
def test_load_config_raises_config_error_when_db_url_missing(): ...
def test_create_order_sends_confirmation_notification(): ...
```

### Use Fixtures over Setup Methods

Leverage pytest's dependency injection — no `setUp`/`tearDown` methods from `unittest`:

```python
import pytest
from my_service.settings import AppSettings


@pytest.fixture
def settings() -> AppSettings:
    """Return minimal test settings."""
    return AppSettings(db_url='sqlite://:memory:', service_name='test')


def test_something(settings: AppSettings) -> None:
    assert settings.service_name == 'test'
```

### Group Related Tests in Classes

Use classes to group tests for a single function or behavior:

```python
class TestLoadConfig:
    def test_returns_defaults(self, tmp_path): ...
    def test_raises_on_missing_required_field(self, tmp_path): ...
    def test_reads_from_env(self, monkeypatch, tmp_path): ...
```

---

## Mocking

Use `pytest-mock`'s `mocker` fixture. Do not use `unittest.mock.patch` decorators.

```python
async def test_create_order_calls_notifier(mocker):
    mock_notifier = mocker.AsyncMock()
    mock_repo = mocker.AsyncMock()
    mock_repo.save.return_value = {'order_id': '123'}

    service = OrderService(repository=mock_repo, notifier=mock_notifier)
    await service.create_order(CreateOrderRequest(customer_id='c1', items=[]))

    mock_notifier.send_confirmation.assert_called_once()
```

For async dependencies, use `mocker.AsyncMock()`:

```python
async def test_fetch_order_returns_model(mocker):
    mock_client = mocker.AsyncMock()
    mock_client.get.return_value = {'order_id': '123', 'status': 'OPEN'}

    service = OrderService(client=mock_client)
    result = await service.fetch_order('123')

    assert result.order_id == '123'
```

---

## Async Tests

With `asyncio_mode = "auto"` in pytest config, async test functions run automatically:

```python
async def test_fetch_order_not_found(mocker):
    mock_client = mocker.AsyncMock()
    mock_client.get.side_effect = httpx.HTTPStatusError(
        '404', request=mocker.Mock(), response=mocker.Mock(status_code=404)
    )

    service = OrderService(client=mock_client)

    with pytest.raises(NotFoundError):
        await service.fetch_order('missing-id')
```

---

## Parametrize for Input Combinations

Use `@pytest.mark.parametrize` to cover multiple cases without duplicating test bodies:

```python
@pytest.mark.parametrize('ext', ['.yaml', '.yml', '.json', '.toml'])
def test_parser_accepts_supported_extension(ext):
    parser = ParserRegistry.get(ext)
    assert parser is not None


@pytest.mark.parametrize(('value', 'expected'), [
    ('USD', True),
    ('EUR', True),
    ('XYZ', False),
    ('', False),
])
def test_is_valid_currency(value, expected):
    assert is_valid_currency(value) == expected
```

---

## Testing Exceptions

Always assert the exception type and a meaningful match on the message:

```python
def test_load_config_raises_on_missing_url(tmp_path):
    with pytest.raises(ConfigError, match='db_url'):
        load_config({'service_name': 'test'})  # missing required field
```

---

## What NOT to Test

- **Framework internals** — don't test that Pydantic validates types correctly; test your own logic.
- **Tautologies** — `assert True` or `assert result is not None` without further verification.
- **Mock wiring** — tests that only verify `.assert_called_once_with(...)` and nothing about the actual behavior of the unit under test.
- **Private implementation details** — only test the public interface.

---

## Coverage Gaps

When coverage falls below the repository threshold (for example 95% where configured), prioritize:

1. Error paths and exception branches — these are commonly missed.
2. Edge cases in conditional logic.
3. Module-level code executed at import time.

Do not add trivial tests just to hit the coverage number. Every test must assert meaningful behavior.

---

## BDD Testing

For features with complex acceptance criteria or product-facing behavior, BDD tests using `pytest-bdd` complement unit tests:

- Feature files describe user-facing behavior in Gherkin.
- Step definitions implement the given/when/then steps.
- BDD tests live in `tests/bdd/` or `tests/features/`.

BDD tests do **not** replace unit tests — unit tests remain the primary testing mechanism. BDD is additive for high-value behavioral coverage.

