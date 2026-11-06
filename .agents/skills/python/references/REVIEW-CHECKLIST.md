# Python Style Guide — Review Checklist (Humans + Agents)

This checklist is the practical enforcement layer of the style guide.

Use it when:
- reviewing PRs
- restructuring packages
- introducing new APIs
- evaluating consistency across a repo
- guiding coding agents toward preferred patterns

The goal is not perfection. The goal is consistency, clarity, and long-term maintainability.

---

## Python Version & Modern Features

- [ ] Code matches the repository runtime configuration (default to Python 3.12+ guidance when runtime is unspecified).
- [ ] Python versions earlier than 3.10 are treated as end-of-life and are not targeted for new work.
- [ ] Built-in generics used (`list[str]`, `dict[str, int]`) — no `typing.List`, `typing.Dict`, etc.
- [ ] `X | None` used — not `Optional[X]`.
- [ ] `X | Y` used — not `Union[X, Y]`.
- [ ] Type aliases use syntax compatible with the repo runtime (prefer `type Alias = ...` for 3.12+; use `TypeAlias` for explicit 3.11 compatibility).

---

## Project Layout

- [ ] Libraries and services both use the `src/` layout.
- [ ] `pyproject.toml` is the dependency source of truth.
- [ ] If a `requirements.txt` exists, it is generated/exported from the project dependency source (not hand-maintained separately).
- [ ] `poetry.lock` (or equivalent lock file) is committed and up to date.
- [ ] Tests mirror source directory structure exactly.
- [ ] One test file per source module.
- [ ] Public API `__init__.py` files define an explicit `__all__` (internal-only packages may omit it).

---

## Type Annotations

- [ ] Every function parameter has a type hint.
- [ ] Every function return value has a type hint (including `-> None`).
- [ ] No banned `typing` imports (`List`, `Dict`, `Tuple`, `Set`, `Optional`, `Union`).
- [ ] Repo-configured type checks are run (for example `ty`, `mypy`, or `pyright`) with no blocking issues in touched code.
- [ ] Ruff/Pylint type-adjacent findings are used as complementary quality checks.

---

## Naming

- [ ] Classes: `PascalCase`.
- [ ] Functions / methods: `snake_case`.
- [ ] Constants: `UPPER_SNAKE_CASE`.
- [ ] Private members prefixed with `_`.
- [ ] No generic suffixes (`Manager`, `Helper`, `Handler`) without domain justification.
- [ ] Boolean functions read as questions: `is_*`, `has_*`, `can_*`.

---

## Classes & Construction

- [ ] Configuration uses a schema-validated, env-loading settings approach with cached/singleton access (Pydantic `BaseSettings` is one option) — avoid scattered raw `os.environ` reads.
- [ ] Domain models use Pydantic `BaseModel` and standard v2 APIs (`model_validate`, `model_dump`) — no custom serialization/validation wrappers that duplicate framework behavior.
- [ ] Service classes inject dependencies through `__init__` — no hidden globals.
- [ ] ABCs live in `domain/base.py`; each implementation in its own file.
- [ ] `@classmethod` factory methods used for multiple construction paths.
- [ ] Composition preferred over inheritance.

---

## Errors

- [ ] A custom exception hierarchy rooted in a package base exception exists in `exceptions.py`.
- [ ] Specific exceptions raised — never bare `raise Exception(...)`.
- [ ] All exception chains use `from` to preserve tracebacks.
- [ ] No bare `except:` or `except Exception:` that swallows errors.
- [ ] `PydanticValidationError` is always wrapped before crossing a module boundary.
- [ ] Libraries raise; services catch and log.

---

## Logging

- [ ] Library / framework packages contain **zero** logging statements.
- [ ] Services use stdlib `logging` configured for structured output (or the appropriate enterprise logging client for the platform).
- [ ] Log statements use structured, machine-parseable messages — not bare f-strings for variable fields.
- [ ] No secrets, tokens, PII, or `SecretStr` values logged.
- [ ] Logging is configured per the repository/platform standard.
- [ ] Logging is at boundaries only (incoming requests, outgoing calls, errors).

---

## Testing

- [ ] `pytest` is used as the primary/default test runner for unit tests.
- [ ] Coverage meets the repository CI threshold (for example `--cov-fail-under=95` where configured).
- [ ] Coverage targets the `--cov=src` layout for both libraries and services.
- [ ] `pytest-mock` (`mocker` fixture) used — not `unittest.mock.patch` decorators.
- [ ] Async tests use `mocker.AsyncMock()` for async dependencies.
- [ ] Both happy paths and error paths tested.
- [ ] `@pytest.mark.parametrize` used for multiple input/output combinations.
- [ ] Test names describe the scenario and expected outcome.
- [ ] No tautology tests (`assert True`, `assert result is not None` without further checks).

---

## Immutability

- [ ] Domain value objects use `@dataclass(frozen=True, slots=True)`.
- [ ] No `dict`, `list`, or `set` fields inside frozen dataclasses — use `tuple`, `frozenset`, or `tuple(sorted(d.items()))`.
- [ ] No mutable defaults (`[]`, `{}`, `set()`) in function signatures or dataclass `field(default=...)` values.
- [ ] Mutable inputs (lists, sets, dicts) are normalized into immutable forms in `__post_init__` before storage.
- [ ] No setters; updates use `dataclasses.replace(...)` or `with_*` factory methods that return new instances.
- [ ] Public properties that expose collections return `tuple` or `frozenset` — not a live `list` or `dict`.
- [ ] Public functions do not mutate their arguments; tests verify inputs are unchanged after the call.
- [ ] Cache keys are immutable and hashable (e.g., frozen dataclasses, `tuple` of hashables).
- [ ] Only immutable values are shared across threads or async tasks.
- [ ] Parameters annotated with narrow immutable interfaces (`Sequence[T]`, `Mapping[K, V]`) where the function does not need mutation.
- [ ] `Final` used for module-level and class-level constants.
- [ ] Any escape hatch (mutable `State` / `MutableState` type) has a docstring documenting mutation rationale, containment, and which tests enforce invariants.

---

## Documentation

- [ ] All public classes, methods, and functions have docstrings (Google style).
- [ ] Every module has a one-line module docstring.
- [ ] No comments that narrate what the code does — only explain *why* when non-obvious.
- [ ] No multi-line comment blocks above functions (use docstrings instead).
- [ ] `README.md` covers: what, install, usage, configuration.

---

## Async

- [ ] `async def` used for all I/O-bound functions.
- [ ] No blocking I/O (`open()`, `requests.get()`, `time.sleep()`) inside `async def` — use `asyncio.to_thread()` for synchronous I/O.
- [ ] `httpx.AsyncClient` used — not `requests` — in async code.
- [ ] Async resources (HTTP clients, DB sessions, streams, locks, files) are always acquired/released with context managers (`async with` for local scope, `@asynccontextmanager`/lifespan for app scope).
- [ ] Shared `httpx.AsyncClient` is lifecycle-managed (for example FastAPI `lifespan`) and not created per request.
- [ ] FastAPI `lifespan` used for resource startup/shutdown — not deprecated `@app.on_event`.

---

## Performance & Resource Management

- [ ] Expensive reusable resources are created once (cache for pure/library resources; lifecycle ownership for service HTTP/DB clients).
- [ ] Regex patterns compiled at module level — not inside functions.
- [ ] No redundant file reads inside hot paths — cache parsed results.
- [ ] Connection pooling configured explicitly for HTTP clients and DB pools.

---

## Code Quality Tooling

- [ ] Repo-configured linting is run (prefer Ruff where configured; Pylint is a supported alternative) with no blocking issues in touched code.
- [ ] Code is formatted and imports sorted according to repo tooling.
- [ ] No `# type: ignore` comments without a documented inline justification.
- [ ] No commented-out code committed.
- [ ] No debug `print()` statements committed.

---

## Tooling Alignment

- [ ] FastAPI used for HTTP services.
- [ ] Poetry used for package management (or an explicitly adopted alternative such as uv).
