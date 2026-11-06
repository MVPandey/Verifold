# Type Annotations

Python 3.12+ is the default recommendation for this skill when repository runtime is unspecified. Treat the repository runtime as source of truth.

Python versions earlier than **3.10 are end-of-life** and must not be targeted for new work.

Type annotations help developers write safer code and help tools catch bugs before runtime. Use the repository's configured type checker (commonly **ty**, **mypy**, or **pyright**); lint/type-adjacent checks from Ruff or Pylint are complementary.

---

## Core Rule: Built-in Generics Only

With a 3.12+ baseline, built-in types support subscripting directly. Prefer built-in generics over `typing` wrappers:

```python
# Good
def process(items: list[str], lookup: dict[str, int]) -> tuple[str, ...]: ...
def load(path: str | None = None) -> set[int]: ...
def tag(value: str) -> frozenset[str]: ...
```

### Banned imports from `typing`

Never import these in modern codebases:

| Banned | Use instead |
|---|---|
| `typing.List` | `list` |
| `typing.Dict` | `dict` |
| `typing.Tuple` | `tuple` |
| `typing.Set` | `set` |
| `typing.FrozenSet` | `frozenset` |
| `typing.Optional[X]` | `X \| None` |
| `typing.Union[X, Y]` | `X \| Y` |
| `typing.Type[X]` | `type[X]` |

---

## Acceptable `typing` Imports

Only use `typing` for constructs with **no built-in equivalent**:

```python
from typing import Any, Literal, Annotated, ClassVar, TypeVar, Protocol, TypeGuard, overload
```

Use `collections.abc` for abstract collection types:

```python
from collections.abc import Callable, Iterable, Iterator, Generator, Sequence, Mapping
```

---

## Annotation Rules

- **Every function parameter** must have a type hint.
- **Every function return** must have a type hint, including `-> None`.
- **Class attributes** used in Pydantic models must follow Pydantic annotation patterns.
- Annotate instance variables in `__init__` or as class-level field declarations.

```python
class WidgetService:
    _client: httpx.AsyncClient
    _config: WidgetConfig

    def __init__(self, config: WidgetConfig, client: httpx.AsyncClient) -> None:
        self._config = config
        self._client = client

    def process(self, widget_id: str) -> Widget | None:
        ...
```

---

## Optional Values

Use `X | None` instead of `Optional[X]`:

```python
# Good
def find(key: str) -> str | None: ...

# Bad
from typing import Optional
def find(key: str) -> Optional[str]: ...
```

---

## Union Types

Use `X | Y` instead of `Union[X, Y]`:

```python
# Good
def render(value: str | int | float) -> str: ...

# Bad
from typing import Union
def render(value: Union[str, int, float]) -> str: ...
```

---

## Type Aliases

In Python 3.12+ codebases, prefer the `type Alias = ...` statement:

```python
type IPv4 = str
type Port = int
type Address = tuple[IPv4, Port]
type RouteMap = dict[str, list[Address]]
```

For repositories pinned to 3.11, use `TypeAlias` from `typing` for compatibility.


---

## Literal Types

Use `Literal` to constrain string or int sets:

```python
from typing import Literal

type Environment = Literal['dev', 'staging', 'prod']


def configure(env: Environment) -> None: ...
```

---

## Annotated and Field Metadata

Use `Annotated` with Pydantic `Field` for constraints and metadata:

```python
from typing import Annotated
from pydantic import Field, BaseModel

type PositiveInt = Annotated[int, Field(gt=0)]
type ShortStr = Annotated[str, Field(max_length=255)]

class Order(BaseModel):
    quantity: PositiveInt
    label: ShortStr
```

---

## Generics and Protocols

In Python 3.12+ codebases, prefer PEP 695 type parameters when a function must preserve input/output types:

```python
from collections.abc import Callable


def retry[T](fn: Callable[[], T], attempts: int) -> T:
    """Call fn up to attempts times, returning its result."""
    ...
```

For repositories pinned to 3.11, use `TypeVar` syntax for compatibility:

```python
from typing import TypeVar
from collections.abc import Callable

T = TypeVar('T')


def retry(fn: Callable[[], T], attempts: int) -> T:
    """Call fn up to attempts times, returning its result."""
    ...
```


Use `Protocol` for structural subtyping (duck typing with type safety):

```python
from typing import Protocol

class Parseable(Protocol):
    def parse(self, raw: bytes) -> dict: ...
```

---

## Type Checking

Use the repository's configured static type checker in CI (commonly **ty**, **mypy**, or **pyright**).

### `ty` (fast alternative)

`ty` is a fast checker from Astral and a good option when your repository has adopted it.

```bash
# Typical runs
poetry run ty check
# or
uv run ty check
```

Example `pyproject.toml` section:

```toml
[tool.ty]
strict = true
```

### `mypy` (widely used)

Example `mypy` config in `pyproject.toml`:

```toml
[tool.mypy]
python_version = "3.12"
strict = true
ignore_missing_imports = false
```

Run in CI:

```bash
poetry run mypy src/
# or
uv run mypy src/
```

### `pyright` (widely used)

Run in CI when adopted:

```bash
poetry run pyright
# or
uv run pyright
```

Type errors must be resolved, not suppressed with `# type: ignore` unless there is a documented justification inline.

---

## `from __future__ import annotations`

In Python 3.12+ repositories, this import is generally unnecessary because annotations are already deferred by default.

Use it only when repository compatibility requirements include Python 3.10/3.11 and a project standard still relies on it.
