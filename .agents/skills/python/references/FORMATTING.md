# Formatting & Linting

**Ruff** is the primary recommended lint/format tool in this guide. **Pylint** remains a valid alternative when it is already configured by the repository.

Prefer the tooling already configured by the repository.

Ruff is a modern, extremely fast option that can consolidate most linting, import sorting, and formatting in one tool. It includes many Pylint-equivalent checks via the `PL` rule family, but it is not a strict 1:1 replacement for every Pylint rule/plugin.

Both tools configure via `pyproject.toml` (some repos also keep a minimal `.pylintrc`).

---

## Ruff (primary)

Ruff is the default recommendation for new or unconfigured repos that follow this skill:

- Fast linting and formatting in one workflow.
- Auto-fix support: `ruff check --fix` resolves many issues automatically.
- Import sorting and docstring linting can be enforced in the same config.
- Works well in CI and pre-commit with low runtime overhead.

### Canonical ruff `pyproject.toml` Configuration

```toml
[tool.ruff]
fix = true
line-length = 120

[tool.ruff.lint]
extend-select = ["D", "RUF", "PT", "TID", "I", "PL"]
ignore = ["D203", "D212"]
per-file-ignores = { "tests/*.py" = ["D", "PLR"], "*_test.py" = ["D"] }

[tool.ruff.format]
quote-style = "single"
indent-style = "space"
docstring-code-format = true
```

---

## Pylint (alternative)

Use Pylint when the repository already standardizes on it, or when teams require specific checks not enabled in their Ruff configuration.

Install Pylint:

```bash
poetry add --group code-quality pylint
# or (if your repo uses uv)
uv add --dev pylint
```

Run:

```bash
# src/ layout (libraries and services)
poetry run pylint src/
# or
uv run pylint src/
```

Generate a starter config:

```bash
poetry run pylint --generate-rcfile > .pylintrc
# or
uv run pylint --generate-rcfile > .pylintrc
```

Keep your `.pylintrc` minimal - only override what differs from defaults. See [Pylint documentation](https://pylint.pycqa.org/en/latest/) for available checkers.

---

## Tool Selection (Deterministic)

Use repository configuration to choose the lint/format path:

1. If `pyproject.toml` contains `[tool.ruff]`, use Ruff commands and rules.
2. Else if repo has `.pylintrc` or `[tool.pylint]`, use Pylint (and repo formatter/import tools).
3. Else default to Ruff as the baseline recommendation in this skill.

Do not introduce a second lint stack in the same repository unless the team explicitly decides to migrate.

---

## Style Rules

### Quotes
- Follow the repository's configured formatter/linter quote style.
- If no style is configured, prefer single quotes for consistency in this guide.
- Use double quotes only when it improves readability (for example to avoid escaping single quotes).

```python
# Good
name = 'Alice'
message = "it's working"

# Bad
name = "Alice"
```

### Indentation
- **Spaces**, never tabs.
- 4-space indentation (Python standard).

### Line Length
- **120 characters** maximum.
- Prefer splitting logical expressions across lines over cramming onto one line.

### Imports
- In Ruff-based repos, import order is managed automatically by Ruff `I` rules.
- In Ruff-based repos, unused imports can be removed with `ruff check --fix`.
- In Pylint-based repos, follow the repository's configured formatter/import sorter workflow.
- Never manually reorder imports unless the repository workflow explicitly requires it.

Standard import order (enforced):
1. Standard library
2. Third-party
3. First-party / local

`from __future__ import annotations` is usually unnecessary in 3.12+ repositories because annotations are deferred by default. Use it only when repository compatibility policy includes 3.10/3.11 and explicitly requires it.

```python

import os
from pathlib import Path

import httpx
from pydantic import BaseModel

from my_service.settings import get_settings
```

---

## Lint Rules Enabled

| Rule Set | Coverage |
|---|---|
| `D` | Docstring enforcement (pydocstyle) |
| `RUF` | Ruff-native rules |
| `PT` | pytest-style checks |
| `TID` | Import tidying |
| `I` | Import sorting (isort-equivalent) |
| `PL` | Pylint-equivalent checks |

### Docstrings
- `D203` and `D212` are ignored (conflicting blank-line rules — the `D211`/`D213` variants are used instead).
- Test files are exempt from `D` and `PLR` rules.

---

## Running the Linter

### Ruff (primary)

```bash
# Check and auto-fix
poetry run ruff check --fix .
# or
uv run ruff check --fix .

# Format
poetry run ruff format .
# or
uv run ruff format .
```

### Pylint (alternative)

```bash
# Lint the src/ tree
poetry run pylint src/
# or
uv run pylint src/

# Lint a single file
poetry run pylint path/to/module.py
# or
uv run pylint path/to/module.py
```

Both commands should run automatically before every commit via git hooks.
Never skip hooks with `--no-verify` in normal development.

---

## Git Hooks

Use a git hook manager (e.g., **Lefthook** or **pre-commit**) to run linting and tests automatically.

Example `lefthook.yml` using Ruff (primary):

```yaml
pre-commit:
  commands:
    ruff-fix:
      run: poetry run ruff check --fix {staged_files}
    ruff-format:
      run: poetry run ruff format {staged_files}

pre-push:
  commands:
    tests:
      run: poetry run pytest
```

Example using Pylint instead:

```yaml
pre-commit:
  commands:
    pylint:
      run: poetry run pylint {staged_files}

pre-push:
  commands:
    tests:
      run: poetry run pytest
```

---

## Docstring Code Blocks

With `docstring-code-format = true`, ruff will also format Python code blocks embedded in docstrings:

```python
def example() -> None:
    """
    Demonstrate formatting.

    Example:
        >>> result = example()
        >>> print(result)
        None

    """
```
