# Project Layout

This reference defines how to organize Python code for **readability**, **maintainability**, and **reproducibility**.

It applies to:
- standalone libraries and framework packages
- backend services and APIs
- CLI tools and workers

The goal is to guide both **humans** and **coding agents** toward consistent, idiomatic Python structure.

---

## Goals

1. **Scannability**
   A reader should understand the shape of a package in seconds from directory names alone.

2. **Testability-first design**
   Packages should be independently testable with clear seams and no hidden globals.

3. **Reproducibility**
   Lock files and explicit dependency bounds guarantee identical environments across machines.

4. **Predictability**
   Consistent conventions reduce cognitive load and agent drift.

---

## Python Version

Match the repository's declared runtime first. If a repo does not state otherwise, use **Python 3.12+** as the default.

Python versions earlier than **3.10 are end-of-life** and must not be targeted for new work.

- Use structural pattern matching (`match`/`case`) where supported.
- Use built-in generic types (`list[str]`, `dict[str, int]`) where supported.
- Use `tomllib` from stdlib when running on 3.11+.
- Never write compatibility shims for EOL Python versions

---

## Package Management

**Poetry** is the default package manager and build backend for production applications in this guide.

`uv` is an approved, high-performance alternative that is worth knowing. Use Poetry by default unless your repository/team has explicitly adopted `uv`.

All dependencies must be declared in `pyproject.toml` (source of truth). Never use bare `setup.py` for new projects.
Lock files (`poetry.lock` / `uv.lock`) must be committed and kept up to date.

A `requirements.txt` or constraints file is acceptable when required by runtime tooling (for example, Docker/image workflows), but it must be generated/exported from the project dependency source and not hand-maintained as a second source of truth.

### Common dependency workflow examples

```bash
# Poetry-first workflow
poetry install
poetry add httpx
poetry run pytest

# uv workflow (when repo has adopted uv)
uv sync
uv add httpx
uv run pytest
```

---

## Web Framework

**FastAPI** is the preferred web framework for APIs and microservices.

### FastAPI — APIs and Microservices

FastAPI is preferred because:
- Native async/await support — ideal for I/O-bound services.
- Automatic OpenAPI/Swagger documentation from type hints.
- Pydantic-native request/response validation.
- Built-in dependency injection for clean service wiring.
- Strong runtime performance for I/O-bound API workloads.

### Minimal FastAPI Service Structure

```python
# src/my_service/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI
from my_service.module_a.routes import router as orders_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown lifecycle."""
    # Initialize shared resources here (DB pools, HTTP clients)
    yield
    # Clean up resources here


app = FastAPI(
    title='My Service',
    version='1.0.0',
    lifespan=lifespan,
)

app.include_router(orders_router)
```

`main.py` is wiring only. Real logic lives in feature modules.

---

### Dependency Groups

| Group | Purpose |
|---|---|
| `dependencies` | Runtime — shipped to production |
| `dev` | Full local dev (tests + linting + hooks) |
| `unit-test` | CI test runner (pytest + coverage only) |
| `code-quality` | CI lint/type-check |
| `build-and-publish` | Publishing artifacts |

### `pyproject.toml` skeleton

Compatibility note: this example uses PEP 621 metadata (`[project]`) with Poetry dependency groups. Use a Poetry version that supports this combination in your environment. If your repo still uses `[tool.poetry]` package metadata, keep that format and apply the same policy guidance.

```toml
[project]
name = "my-package"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
    "pydantic>=2.6.0,<3.0.0",
    "fastapi>=0.115.0,<1.0.0",
]

[tool.poetry.group.unit-test.dependencies]
pytest = ">=8.0.0,<9.0.0"
pytest-cov = ">=5.0.0,<6.0.0"
pytest-mock = ">=3.14.0,<4.0.0"

[tool.poetry.group.code-quality.dependencies]
ruff = ">=0.6.0,<1.0.0"
# Choose one checker your repository standardizes on.
# Examples: ty, mypy, or pyright.

[build-system]
requires = ["poetry-core"]
build-backend = "poetry.core.masonry.api"
```

Pin with lower + upper bounds (e.g., `>=2.6.0, <3.0.0`) in `pyproject.toml` to balance stability with security patches.
Avoid exact pins (`==`) in `pyproject.toml` unless there is a documented compatibility reason.
Exact pins are appropriate in exported lock/constraints artifacts used for reproducible builds.

---

## Project Layout (src/)

Both libraries and services use the `src/` layout to cleanly separate package code from project metadata. The `src/` layout prevents accidental imports of the package from the project root and enforces proper installation.

### Library / Framework Layout

```
repo-root/
├── pyproject.toml
├── poetry.lock or uv.lock
├── README.md
├── src/
│   └── package_name/
│       ├── __init__.py       # explicit __all__
│       ├── exceptions.py     # custom exception hierarchy
│       ├── settings.py       # Pydantic BaseSettings or dataclass config
│       ├── domain_a/
│       │   ├── __init__.py   # explicit __all__
│       │   ├── base.py       # ABC / interface lives here
│       │   ├── impl_x.py
│       │   └── impl_y.py
│       └── shared/
│           ├── __init__.py
│           └── http_client_factory.py
└── tests/
    ├── conftest.py
    ├── domain_a/
    │   ├── test_impl_x.py
    │   └── test_impl_y.py
    └── test_settings.py
```

### Service Layout

Services follow the same `src/` layout, with `main.py` for FastAPI wiring and feature modules alongside it:

```
repo-root/
├── pyproject.toml
├── poetry.lock or uv.lock
├── README.md
├── src/
│   └── my_service/
│       ├── __init__.py
│       ├── main.py          # FastAPI app creation + lifespan wiring only
│       ├── core/
│       │   ├── __init__.py
│       │   ├── settings.py
│       │   └── exceptions.py # Custom exception hierarchy
│       ├── routes/
│       │   ├── __init__.py
│       │   ├── route_a.py
│       │   └── route_b.py
│       ├── services/
│       │   ├── __init__.py
│       │   ├── service_a.py
│       │   └── service_b.py
│       ├── schemas/
│       │   ├── __init__.py
│       │   ├── request.py
│       │   └── user.py
│       └── shared/
│           ├── __init__.py
│           └── http_client_factory.py
└── tests/
    ├── core/
    │   └── test_settings.py
    ├── routes/
    │   ├── test_route_a.py
    │   └── test_route_b.py
    ├── services/
    │   ├── test_service_a.py
    │   └── test_service_b.py
    └── shared/
        └── test_http_client_factory.py
```

Keep `main.py` thin:
- create the `FastAPI` instance
- register the `lifespan` context manager
- include routers

Real logic lives in feature modules.

---

## Key Structural Rules

### `__init__.py`
- Public API packages should define an explicit `__all__` in `__init__.py`.
- Internal-only packages may omit `__all__` when nothing is intentionally re-exported.
- Re-export the public API so consumers import from the package, not internal modules.

```python
"""Widget package public API."""

from package_name.domain_a.impl_x import ImplX
from package_name.domain_a.impl_y import ImplY

__all__ = ['ImplX', 'ImplY']
```

### Tests mirror source
- Every source module has a corresponding `test_` file at the same relative path under `tests/`.
- Mirror the package structure under `src/` exactly.

Examples:
- `src/package_name/domain_a/impl_x.py` → `tests/domain_a/test_impl_x.py`
- `src/package_name/settings.py` → `tests/test_settings.py`
- `src/my_service/routes/route_a.py` → `tests/routes/test_route_a.py`
- `src/my_service/services/service_a.py` → `tests/services/test_service_a.py`

### One responsibility per file
- If a module exceeds ~200 lines, consider splitting.
- Avoid catch-all filenames: `utils.py`, `helpers.py`, `common.py` — only introduce a `shared/` module when genuinely shared logic exists across two or more feature modules, and prefer domain-specific names inside it.

### Abstract interfaces live in `base.py`
- The ABC for a domain lives in `domain_a/base.py`.
- Concrete implementations each get their own file.

---

## File Organization Within a Module

Within any `.py` file, follow this order:

1. Module docstring
2. Standard library imports
3. Third-party imports
4. Local / first-party imports
5. `__all__` (for `__init__.py`)
6. Constants and module-level compiled patterns
7. Type aliases (`type Alias = ...` for 3.12+; `TypeAlias` for pinned 3.11 compatibility)
8. Exception classes
9. Abstract base classes / interfaces
10. Concrete classes
11. Module-level functions (pure helpers last)

`from __future__ import annotations` is generally unnecessary in 3.12+ repositories because annotations are already deferred by default. Use it only when required by repository compatibility policy for 3.10/3.11 support.

Import ordering is enforced automatically by the linter's import-sort rules. Never manually reorder imports.

---

## Container Images

When deploying via Docker, follow your platform's base-image policy. Pin base images by digest when immutability is required by compliance or reproducibility needs.

### Pinning in requirements.txt for Docker builds

When a Docker workflow requires `requirements.txt`, use an exported, fully pinned artifact for reproducibility and scanner consistency. Do not treat it as the primary dependency source — generate it from `pyproject.toml`/lock file.

Within your `requirements.txt` (used inside Docker builds), always specify full version pins to maximize reproducibility and minimize vulnerability flags:

```
fastapi==0.115.0
uvicorn==0.34.0
pydantic==2.10.0
```
