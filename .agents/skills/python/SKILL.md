---
name: python
description: Python engineering style guide for designing packages, services, and CLIs. Use for any Python work creating or reviewing packages/APIs, PR reviews, refactors/restructures, error/logging patterns, config/classes, testing, type annotations, and immutability.
metadata:
  version: "0.1"
---

# Python Style Guide Skill

## Who This Skill Is Useful For

This skill is most useful for:
- **humans** reading and maintaining Python code
- **coding agents** generating and refactoring Python code reliably
- **production-focused teams** optimizing for correctness, testability, and maintainability

Activate this skill for all Python work: new code, refactors, reviews, and architecture decisions.

## Policy Keywords

- **MUST**: mandatory requirement for new and modified code.
- **SHOULD**: default practice unless repo constraints require a different approach.
- **MAY**: optional guidance.

## Agent Quick Policy (Python 3.12+ Baseline)

- **Python version**: match the repository's declared runtime; if unspecified, recommend **Python 3.12+**.
- **Runtime lifecycle**: Python versions earlier than **3.10 are end-of-life** and must not be targeted for new work.
- **Type aliases**: in 3.12+ codebases, prefer `type Alias = ...`; use `TypeAlias` only when repository compatibility constraints require 3.11 syntax.
- **Web framework**: **FastAPI** is the preferred framework for APIs and microservices.
- **Package manager**: **Poetry** is the default; `uv` is a strong alternative when the repository has adopted it.
- **Lint checks**: **Ruff** is the primary recommendation; **Pylint** remains a supported alternative when repo policy chooses it.
- **Type checks**: follow the repository's configured checker (commonly **ty**, **mypy**, or **pyright**).
- **Layout**: use the `src/` layout for both services and libraries.
- **Logging**: libraries raise exceptions and return data; services own logging and observability.

## Agent Decision Rules

When guidance conflicts, apply this precedence in order:

1. **Repository source of truth**: `pyproject.toml`, lock/config files, CI pipeline rules, and repository-local docs.
2. **This skill's defaults**: This file details the recommended defaults when repository policy is not explicit. If the repository is cleary violating standards, it might be worth mentioning it to the user and allowing a human to use best judgement.

If ambiguity exists in the conflict resolution approach, pick the more conservative option (fewer assumptions, no runtime upgrade, no policy broadening).

## Legacy Compatibility Note (3.10/3.11 Maintenance)

For maintenance tasks in repositories explicitly pinned to Python 3.10/3.11, keep syntax/runtime compatibility for touched code and avoid introducing 3.12-only syntax unless the task includes a planned runtime upgrade. Python versions below 3.10 are end-of-life and should not be introduced.

---

## When to Activate This Skill

Use this skill anytime you are working with Python: new code, refactors, reviews, and architecture decisions.

---

## TL;DR

- **Target the repository runtime** for generated code; if unspecified, default to **Python 3.12+**.
- **FastAPI** is the recommended web framework for services and APIs.
- **Pydantic** is a common standard for data validation and domain models; settings can use `BaseSettings` or another schema-validated env-loading approach.
- **Poetry** is the default package manager for production apps; `uv` is a strong alternative when repo policy adopts it.
- Linting and formatting should follow repository-configured tooling (**Ruff** is the primary recommendation; **Pylint** is a valid alternative).
- Type checking should follow repository-configured tooling (`ty`, `mypy`, and `pyright` are common choices).
- Design for testability: inject dependencies, keep logic pure and isolated.
- Libraries raise exceptions and return data — they do **not** log.
- Services own logging, error handling, and observability.
- Meet the repository's CI coverage gate (**95%** where configured).
- Define a custom exception hierarchy per package; always chain with `from`.
- Annotate **every** parameter and return type; use built-in generics, not `typing` wrappers.
- **Domain objects are immutable values** by default; use `@dataclass(frozen=True, slots=True)` and functional updates via `dataclasses.replace`.

---

## House Style Disclaimer

This is intentionally opinionated. It favors consistency and long-term maintainability over accommodating every Python style preference.

---

## Quick Rules Table

| Topic | Rule | Reference |
| --- | --- | --- |
| Python version | Match repository runtime; default to **3.12+** when unspecified. Python **< 3.10 is end-of-life** and must not be targeted for new work. | [LAYOUT.md](references/LAYOUT.md) |
| Package management | **Poetry** by default; `uv` as an approved alternative; `pyproject.toml` required | [LAYOUT.md](references/LAYOUT.md) |
| Linting & formatting | Prefer **Ruff** by default; use **Pylint** when configured by the repository | [FORMATTING.md](references/FORMATTING.md) |
| Type annotations | Built-in generics; annotate everything; validate with repo type checker (`ty` / `mypy` / `pyright`) | [TYPES.md](references/TYPES.md) |
| Project layout | `src/` layout for both libraries and services | [LAYOUT.md](references/LAYOUT.md) |
| Classes & constructors | Prefer schema-validated config contracts (Pydantic `BaseSettings` is one option); validate in `__init__` | [CLASSES.md](references/CLASSES.md) |
| Errors | Custom hierarchy; raise specific; chain with `from` | [ERRORS.md](references/ERRORS.md) |
| Logging | Services own logging/observability using the repository or platform standard | [LOGGING.md](references/LOGGING.md) |
| Testing | pytest as primary/default; coverage from repo CI policy; mirror `src/` structure | [TESTING.md](references/TESTING.md) |
| Documentation | Google-style docstrings; all public APIs; clear naming | [DOCS.md](references/DOCS.md) |
| Naming | PascalCase classes, snake_case functions, UPPER_SNAKE constants | [NAMING.md](references/NAMING.md) |
| Async | Async variants for I/O-bound APIs; `httpx.AsyncClient` for HTTP | [ASYNC.md](references/ASYNC.md) |
| Immutability | `@dataclass(frozen=True, slots=True)` for value objects; functional updates; no mutable defaults | [IMMUTABILITY.md](references/IMMUTABILITY.md) |
| Review | Use the checklist for PRs and agent reviews | [REVIEW-CHECKLIST.md](references/REVIEW-CHECKLIST.md) |

---

## Avoid the following common anti-patterns:

- Using `typing.List`, `typing.Dict`, `typing.Optional` — use built-in generics and `|` syntax instead.
- Using `typing.TYPE_CHECKING` to gate imports only used in annotations — prefer plain string-literal forward references (`def f(x: 'HeavyType') -> ...`) and let the type checker resolve them. `TYPE_CHECKING` adds an extra import block, breaks `grep` for symbol usage, and isn't needed once the codebase is consistent about quoting expensive annotations.
- Inline imports inside functions / methods — keep imports at the top of the module. Only defer when there's a concrete reason (heavy import that bloats package load time when the function isn't called, or a genuine import cycle that can't be restructured). When you do defer, mark the line with `# noqa: PLC0415` and a brief comment explaining the reason. Enforce this with Ruff: do **not** add `PLC0415` to `[tool.ruff.lint] ignore`.
- Logging inside a library/framework package instead of raising exceptions.
- Re-implementing what Pydantic already provides (`model_dump`, `model_validate`, secret masking, validation).
- Bare `except Exception` with no re-raise — hiding failures.
- Missing `__all__` in `__init__.py` — leaking internal modules into public API.
- Hiding dependencies in module-level globals/functions for complex flows; if using procedural modules, keep orchestration explicit and testable.
- Re-reading files, re-creating clients, or recompiling regexes on every call instead of caching.
- Missing type annotations on parameters or return values.
- Over-commenting — narrating what the code does rather than why.
- Skipping or shortening docstrings on public modules, classes, or functions. Docstrings must read as proper English sentences (capitalized, end with a period). Inline one-line `#` comments **may** be lowercase and informal — that's a legitimate scratchpad register; full docstrings are not.
- Writing log messages in code-style key=value form (`'request msg[0] role=%s text=%r'`). The prose portion of a log template is human-readable text — capitalize it, spell out abbreviations, and don't let snake_case variable names leak into the message ("prompt tokens" not `prompt_tokens`). See [LOGGING.md](references/LOGGING.md#log-message-style).
- Skipping or shortening docstrings on public modules, classes, or functions. Docstrings must read as proper English sentences (capitalized, end with a period). Inline one-line `#` comments **may** be lowercase and informal — that's a legitimate scratchpad register; full docstrings are not.
- Writing log messages in code-style key=value form (`'request msg[0] role=%s text=%r'`). The prose portion of a log template is human-readable text — capitalize it, spell out abbreviations, and don't let snake_case variable names leak into the message ("prompt tokens" not `prompt_tokens`). See [LOGGING.md](references/LOGGING.md#log-message-style).
- Using `list`, `dict`, or `set` as fields inside a frozen dataclass — use `tuple`, `frozenset`, and sorted item tuples instead.
- Using mutable defaults (`[]`, `{}`, `set()`) in function signatures or dataclass fields.
- Implementing setters or mutating `self` in place instead of returning a new object via `dataclasses.replace`.
- Returning a live internal `list` or `dict` from a property — always expose `tuple` or `frozenset`.

---

## Core Principles

1. **Testability is first-class**
   Design for easy testing without booting an entire application. Inject dependencies explicitly. Keep pure logic isolated in functions and methods that take inputs and return outputs.

2. **Pydantic-driven construction**
   Prefer Pydantic `BaseSettings` / `BaseModel` for validated configuration and domain models. Validate at construction. Let the framework do the heavy lifting.

3. **Errors are a contract**
   Define a custom exception hierarchy per package. Raise specific, meaningful exceptions. Chain with `from` to preserve tracebacks. Libraries raise; services catch.

4. **Libraries are reusable by default**
   Keep packages domain-focused and individually testable. No logging, no hidden globals, no side effects at import time.

5. **Runtime-aware modern Python**
   Match the repository's declared runtime and use modern syntax available there. When unspecified, default to **Python 3.12+**. Use `match`/`case`, built-in generics, `tomllib`, `type Alias = ...`, and similar features when supported. Avoid EOL versions (**< 3.10**). Never write shims for legacy Python.

6. **Domain objects are immutable values**
   Use `@dataclass(frozen=True, slots=True)` for all value objects by default. Accept mutable inputs only at well-defined boundaries (parsers, I/O adapters); normalize them into immutable forms immediately. Perform updates via `dataclasses.replace` or explicit `with_*` factory methods — never mutate in place.

---

## Package Types

### Service (orchestrator)

**FastAPI is the preferred web framework** for APIs and microservices:

- **FastAPI** — native async, automatic OpenAPI docs, Pydantic-native validation, and clean dependency injection.

For FastAPI services, wire resources through a `lifespan` context manager.

The service package owns:
- dependency wiring (DB pools, HTTP clients, settings)
- lifecycle (startup/shutdown via `lifespan`)
- error policy (exception handlers, retry, structured responses)
- logging and observability (repository/platform standard)

See: [LAYOUT.md](references/LAYOUT.md)

### Library / Framework package (reusable unit)

Rules:
- No logging (see [LOGGING.md](references/LOGGING.md))
- Return errors via exceptions, don't hide them
- Define a local settings/config contract (Pydantic `BaseSettings` is one option; equivalent schema-validated approaches are valid)
- Accept initialized dependencies — do not create them internally unless using `@functools.cache` singletons

---

## Directory Structure

See [`references/LAYOUT.md`](references/LAYOUT.md) for canonical directory layouts for services and libraries.

---

## Classes, Config & Construction

Prefer **Pydantic `BaseModel`** for validated domain objects. For settings/config, use a schema-validated, env-loading approach with caching/singleton access (`BaseSettings` is one option). Use **`dataclass`** for simple DTOs with no validation. Use **ABC** for interfaces with multiple implementations.

```python
from pydantic import BaseModel, Field


class WidgetConfig(BaseModel):
    timeout_seconds: float = Field(default=30.0, gt=0)
    max_retries: int = Field(default=3, ge=0)


class WidgetService:
    def __init__(self, config: WidgetConfig) -> None:
        self._config = config

    @classmethod
    def from_env(cls) -> 'WidgetService':
        """Construct using environment-sourced config."""
        return cls(config=WidgetConfig())
```

See: [CLASSES.md](references/CLASSES.md)

---

## Type Annotations

Target Python 3.12+ where repository policy allows, so use built-in generics everywhere:

```python
# Good
def process(items: list[str], lookup: dict[str, int]) -> tuple[str, ...]: ...

# Bad — do not import these in modern codebases
from typing import List, Dict, Optional, Union
```

Use `X | None` instead of `Optional[X]`, and `X | Y` instead of `Union[X, Y]`.

In Python 3.12+ codebases, prefer `type Alias = ...`. Use `TypeAlias` only when repository compatibility constraints require 3.11 syntax.

Use PEP 695 style type parameters in 3.12+ repositories when it improves readability (for example `def identity[T](value: T) -> T: ...`).

Every function parameter and return value must have a type hint, including `-> None`.

See: [TYPES.md](references/TYPES.md)

---

## Logging

Logging is owned by the **service**, not by reusable packages.

- **Libraries** must not contain any `logger.*` calls, `print()`, or logging setup.
- **Services** configure logging via the repository/platform logging standard and log at boundaries.
- Never log secrets, tokens, PII, or `SecretStr` values.

See: [LOGGING.md](references/LOGGING.md)

---

## Errors

Define a single base exception per package and build a hierarchy from it:

```python
class AppException(Exception):
    """Base exception for this package."""

class ConfigError(AppException): ...
class ValidationError(AppException): ...
class NotFoundError(AppException): ...
```

Always chain with `from`:
```python
try:
    load_settings()
except PydanticValidationError as e:
    raise ValidationError(f'Config invalid: {e}') from e
```

See: [ERRORS.md](references/ERRORS.md)

---

## Testing

- **pytest** is the preferred primary test runner.
- Coverage must meet the repository's configured CI threshold (commonly 95%).
- Use `pytest-mock` (`mocker`) — not `unittest.mock.patch` decorators.
- Use `pytest-asyncio` for async tests.
- Mirror `src/` structure exactly under `tests/`.
- Test both happy paths and error paths.

See: [TESTING.md](references/TESTING.md)

---

## File Organization and Efficiency

Within a module, follow this order:

1. Module docstring
2. Imports (sorted by linter)
3. Constants / module-level compiled patterns
4. Type aliases (`type Alias = ...` in 3.12+; `TypeAlias` for 3.11 compatibility)
5. Exception classes
6. Abstract base classes / interfaces
7. Concrete classes
8. Module-level functions (pure helpers last)

Avoid catch-all filenames like `utils.py`, `helpers.py`, `common.py` unless the content is genuinely cross-cutting.
One responsibility per file. Split if a file exceeds ~200 lines.

---

## Singletons, Caching & Resource Pooling

Avoid redundant I/O and object construction:

- `@functools.cache` for pure-function memoization and library-safe singleton resources.
- Module-level compiled regex patterns — never compile in a loop.
- `httpx.AsyncClient` with pooling; never create a new client per request.
- In services, manage shared clients via FastAPI `lifespan` and inject them.

```python
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Create and close shared resources once per application lifecycle."""
    app.state.http_client = httpx.AsyncClient(timeout=30, limits=httpx.Limits(max_connections=100))
    yield
    await app.state.http_client.aclose()
```

---

## Immutability

Domain objects are **immutable values** by default.

### Default posture

- Prefer **construct-once, use-many** objects; avoid in-place mutation outside tight, local scopes.
- Mutable state MUST NOT cross module boundaries unless it is an explicit, named state object.

### Allowed mutable zones

Mutation is permitted only in:
- **Builders / parsers**: raw input → immutable value.
- **I/O adapters**: DB, HTTP, filesystem (framework-owned lifecycle).
- **Performance-critical inner loops**: isolated to a single function scope and backed by tests.

### Frozen dataclasses for value objects

```python
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Money:
    """An immutable monetary value."""
    amount: int       # minor units (cents)
    currency: str     # ISO 4217 code
```

Field types inside immutable types:
- ✅ `str`, `int`, `float`, `bool`, `bytes`
- ✅ `tuple[...]`, `frozenset[...]`
- ✅ Other frozen dataclasses, `enum.Enum` subclasses
- ⛔ `dict`, `list`, `set` — forbidden

### Normalize at construction

Use `__post_init__` to convert mutable inputs into immutable forms:

```python
@dataclass(frozen=True, slots=True)
class TaggedItem:
    name: str
    tags: frozenset[str]
    metadata: tuple[tuple[str, str], ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, 'tags', frozenset(self.tags))
        object.__setattr__(
            self,
            'metadata',
            tuple(sorted((str(k), str(v)) for k, v in self.metadata)),
        )
```

Normalization rules: `list` → `tuple`, `set` → `frozenset`, `dict` → `tuple(sorted(d.items()))`.

### Functional updates

Never implement setters. Use `dataclasses.replace` or `with_*` helpers:

```python
import dataclasses

updated = dataclasses.replace(original, display_name='Bob')
# or
updated = profile.with_display_name('Bob')
```

### Public API and collections

- Public functions MUST NOT mutate their arguments.
- Properties that expose collections MUST return `tuple` or `frozenset` — never a live `list` or `dict`.

### Concurrency and caching

- Only share **immutable values** across threads or async tasks.
- Cache keys must be immutable and hashable; frozen dataclasses satisfy this automatically.

### Type checking

Annotate with the narrowest immutable interface:
- `Sequence[T]` instead of `list[T]`
- `Mapping[K, V]` instead of `dict[K, V]`
- `Final` for constants and "do not rebind" names

### Escape hatches

When mutability is unavoidable, create a dedicated `MutableState` / `State` type, document invariants in its docstring, and keep it out of value objects and hashing/equality roles.

See: [IMMUTABILITY.md](references/IMMUTABILITY.md)

---

## Reference Index

Use these supporting documents when deeper detail is needed:

- [references/LAYOUT.md](references/LAYOUT.md)
  Project layout, `pyproject.toml` structure, dependency groups, file organization.

- [references/TYPES.md](references/TYPES.md)
  Type annotation rules, built-in generics, banned `typing` imports, and repo-configured type-check guidance (`ty`, `mypy`, or `pyright`).

- [references/FORMATTING.md](references/FORMATTING.md)
  Repository-driven lint/format options (**Ruff** primary, **Pylint** alternative), quote style, line length, and import sorting.

- [references/CLASSES.md](references/CLASSES.md)
  Class patterns, settings fundamentals, Pydantic models, dataclasses, ABCs, factory methods, and singletons/caching.

- [references/ERRORS.md](references/ERRORS.md)
  Custom exception hierarchies, chaining, raise discipline, library vs. service responsibilities.

- [references/LOGGING.md](references/LOGGING.md)
  Logging rules: no logging in libraries, platform/repo logging standards, log levels, and sensitive data handling.

- [references/TESTING.md](references/TESTING.md)
  pytest setup, coverage requirements, structure, mocking, async testing, parametrize.

- [references/DOCS.md](references/DOCS.md)
  Google-style docstrings, module docstrings, comment discipline, naming conventions.

- [references/NAMING.md](references/NAMING.md)
  Naming conventions: classes, functions, constants, private members, module names.

- [references/ASYNC.md](references/ASYNC.md)
  Async patterns, httpx, asyncio.to_thread, pytest-asyncio.

- [references/IMMUTABILITY.md](references/IMMUTABILITY.md)
  Immutability rules: frozen dataclasses, normalization, functional updates, mutable zones, escape hatches, and immutability tests.

- [references/REVIEW-CHECKLIST.md](references/REVIEW-CHECKLIST.md)
  PR review rubric for humans and coding agents.
