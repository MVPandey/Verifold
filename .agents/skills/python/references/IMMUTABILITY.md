# Practical Immutability (Python 3.12+)

Immutability reduces accidental state mutation, makes concurrent code safer, and enables reliable hashing and caching. Treat domain objects as values that are constructed once and never modified in place.

---

## Core Requirements

| Requirement | Value |
|---|---|
| Default posture | Domain objects are immutable values by default |
| Value objects | `@dataclass(frozen=True, slots=True)` |
| Functional updates | `dataclasses.replace(obj, field=new)` or `obj.with_*(...)` factory methods |
| Mutable defaults | Never — no `[]`, `{}`, or `set()` as default values |
| Mutable arguments | Copy/normalize at the boundary before storing |
| Escape hatch | Explicit `State`/`MutableState` types with documented invariants |

---

## 1. Default Posture

Treat **all domain objects as immutable values** by default.

- Prefer **construct-once, use-many** objects.
- Avoid in-place mutation outside tight, local scopes.
- Mutable state MUST NOT cross module boundaries unless it is an explicit, named state object.

---

## 2. Allowed Mutable Zones

Mutation is permitted **only** in:

- **Builders / parsers**: transforming raw input (bytes, JSON, config) into an immutable value object.
- **I/O adapters**: DB, HTTP, filesystem interactions where the framework owns the lifecycle.
- **Performance-critical inner loops**: must be isolated to a single function scope and backed by tests that verify outputs are immutable.

Every mutable exception MUST be justified in a docstring — see [Section 14](#14-documentation-rule).

---

## 3. Immutable Data Modeling

Use `@dataclass(frozen=True, slots=True)` for value objects. `frozen=True` makes instances immutable at runtime; `slots=True` reduces memory overhead and prevents accidental attribute addition.

```python
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Money:
    """An immutable monetary value."""

    amount: int       # stored in minor units (cents)
    currency: str     # ISO 4217 code


@dataclass(frozen=True, slots=True)
class Address:
    """An immutable postal address."""

    street: str
    city: str
    postal_code: str
    country: str
```

### Allowed field types inside immutable types

| Type | Allowed |
|---|---|
| `str`, `int`, `float`, `bool`, `bytes` | ✅ |
| `tuple[...]` | ✅ |
| `frozenset[...]` | ✅ |
| Other frozen dataclasses | ✅ |
| `enum.Enum` subclasses | ✅ |
| `dict`, `list`, `set` | ⛔ — forbidden |

If you need to represent a mapping or sequence:
- Use `tuple[tuple[str, int], ...]` for ordered pairs.
- Use `frozenset[str]` for unordered unique values.
- Normalize at the boundary in `__post_init__` (see [Section 5](#5-deep-ish-immutability-enforcement)).

---

## 4. No Shared-Mutable Defaults

Never use mutable objects as default parameter values:

```python
# Bad — the list is shared across all callers
def process(items: list[str] = []) -> None: ...

# Good — use None and normalize
def process(items: Sequence[str] | None = None) -> None:
    resolved = tuple(items) if items is not None else ()
    ...
```

If a constructor or function accepts a mutable argument, **copy or normalize it immediately**:

```python
from dataclasses import dataclass
from collections.abc import Sequence


@dataclass(frozen=True, slots=True)
class Report:
    """An immutable report with a stable, ordered list of sections."""

    title: str
    sections: tuple[str, ...]

    @classmethod
    def create(cls, title: str, sections: Sequence[str]) -> 'Report':
        """Construct a Report, normalizing sections to an immutable tuple."""
        return cls(title=title, sections=tuple(sections))
```

---

## 5. "Deep-ish" Immutability Enforcement

Use `__post_init__` to normalize mutable inputs into immutable forms at construction time:

```python
from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class TaggedItem:
    """An item annotated with an immutable, ordered set of tags."""

    name: str
    tags: frozenset[str]
    metadata: tuple[tuple[str, str], ...]

    def __post_init__(self) -> None:
        # frozen=True prevents direct assignment; use object.__setattr__ for normalization
        object.__setattr__(self, 'tags', frozenset(self.tags))
        object.__setattr__(
            self,
            'metadata',
            tuple(sorted((str(k), str(v)) for k, v in self.metadata)),
        )
```

Normalization rules:

| Input type | Normalized form |
|---|---|
| `list[T]` | `tuple[T, ...]` |
| `set[T]` | `frozenset[T]` |
| `dict[K, V]` | `tuple[tuple[K, V], ...]` (sorted by key when order is insignificant) |
| Nested mutable structures | Normalize recursively if they are part of the domain model |

---

## 6. Functional Updates

Do not implement setters. Provide updates via `dataclasses.replace` or explicit `with_*` methods that return a **new instance**.

```python
import dataclasses
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class UserProfile:
    """An immutable user profile."""

    user_id: str
    display_name: str
    email: str

    def with_display_name(self, name: str) -> 'UserProfile':
        """Return a new UserProfile with the display name updated."""
        return dataclasses.replace(self, display_name=name)

    def with_email(self, email: str) -> 'UserProfile':
        """Return a new UserProfile with the email address updated."""
        return dataclasses.replace(self, email=email)
```

Rules:
- **Never mutate and return `self`**.
- `dataclasses.replace(obj, field=new_value)` is the preferred shallow-copy primitive.
- Name explicit helpers `with_<field>(...)` for discoverability.
- Chained transformations MUST each return a new object: `profile.with_display_name('x').with_email('[REDACTED_EMAIL_ADDRESS_1]')`.

---

## 7. Equality, Hashing, and Identity

Prefer value semantics:

- `frozen=True` on a dataclass automatically enables `eq=True` and `__hash__` based on fields.
- Never rely on object identity (`is`) for domain equality — use `==`.
- Only hashable types may be used as dict keys or set members; this is automatically satisfied when all fields are immutable.

```python
a = Money(amount=100, currency='USD')
b = Money(amount=100, currency='USD')

assert a == b          # ✅ value equality
assert a is not b      # ✅ different objects
assert hash(a) == hash(b)  # ✅ consistent hash
```

---

## 8. Public API Guarantees

Public functions MUST NOT mutate their arguments unless explicitly documented.

```python
# Good — input is unchanged; a new object is returned
def apply_discount(order: Order, pct: float) -> Order:
    """Return a new Order with a discount applied."""
    discounted = round(order.total * (1 - pct / 100))
    return dataclasses.replace(order, total=discounted)
```

If a function mutates internally for performance:
- Mutation MUST be confined to local variables only.
- Return a new immutable output.
- Tests MUST assert the original argument is unchanged (see [Section 12](#12-tests-that-enforce-immutability)).

---

## 9. Collections and Views

When a class exposes internal collections through a property or method:

```python
@dataclass(frozen=True, slots=True)
class Catalog:
    """An immutable product catalog."""

    _items: tuple[str, ...]

    @property
    def items(self) -> tuple[str, ...]:
        """Return the immutable sequence of catalog items."""
        return self._items
```

Rules:
- Expose `tuple` or `frozenset` — never return a live `list` or `dict`.
- If a mutable collection must be returned for framework compatibility, document it clearly and return a shallow copy:

  ```python
  def to_list(self) -> list[str]:
      """Return a copy of items as a list (caller may mutate the copy safely)."""
      return list(self._items)
  ```

- Avoid "read-only views" (e.g., `types.MappingProxyType`) that still reflect upstream mutation unless you fully control the upstream object's lifetime.

---

## 10. Concurrency and Caching

- Only share **immutable values** across threads or async tasks — never share mutable state without explicit locking.
- Cache keys MUST be immutable and hashable (e.g., `str`, `int`, frozen dataclasses, `tuple` of hashables).
- `@functools.cache` / `@functools.lru_cache` require hashable arguments; using immutable types satisfies this automatically.

```python
from functools import cache


@cache
def compute_risk_score(profile: UserProfile) -> float:
    """Compute and cache a risk score for the given profile.

    UserProfile is frozen so it is hashable and safe to cache.
    """
    ...
```

---

## 11. Type Checking and Narrow Interfaces

Annotate parameters with **the narrowest immutable interface** that satisfies the contract:

| Use | Instead of |
|---|---|
| `Sequence[T]` | `list[T]` |
| `Mapping[K, V]` | `dict[K, V]` |
| `AbstractSet[T]` | `set[T]` |
| `tuple[T, ...]` | `list[T]` (for homogeneous fixed sequences) |

```python
from collections.abc import Mapping, Sequence


def build_report(rows: Sequence[str], config: Mapping[str, str]) -> Report:
    """Accept any sequence or mapping — normalize to immutable internals."""
    return Report(
        sections=tuple(rows),
        settings=tuple(sorted(config.items())),
    )
```

Use `Final` from `typing` for names that must not be rebound at module or class level:

```python
from typing import Final

MAX_RETRIES: Final = 3
DEFAULT_CURRENCY: Final = 'USD'
```

---

## 12. Tests That Enforce Immutability

Write tests that explicitly validate immutability guarantees:

```python
import dataclasses
import pytest
from my_package.domain.models import Money, UserProfile


class TestMoneyImmutability:
    def test_frozen_raises_on_attribute_assignment(self) -> None:
        """Frozen dataclass must reject direct field mutation."""
        m = Money(amount=100, currency='USD')
        with pytest.raises(dataclasses.FrozenInstanceError):
            m.amount = 200  # type: ignore[misc]

    def test_value_equality(self) -> None:
        """Two Money instances with the same fields must be equal."""
        assert Money(100, 'USD') == Money(100, 'USD')

    def test_hash_is_consistent(self) -> None:
        """Hash must be stable and equal for equal instances."""
        assert hash(Money(100, 'USD')) == hash(Money(100, 'USD'))


class TestUserProfileFunctionalUpdates:
    def test_with_display_name_returns_new_instance(self) -> None:
        """with_display_name must not mutate the original."""
        original = UserProfile(user_id='u1', display_name='Alice', email='[REDACTED_EMAIL_ADDRESS_2]')
        updated = original.with_display_name('Bob')

        assert updated.display_name == 'Bob'
        assert original.display_name == 'Alice'  # original unchanged
        assert updated is not original

    def test_inputs_not_mutated_by_build_report(self) -> None:
        """build_report must not modify its input list."""
        rows = ['Section A', 'Section B']
        snapshot = list(rows)
        build_report(rows, {})
        assert rows == snapshot
```

Required immutability test scenarios:
- Attempting attribute assignment raises `FrozenInstanceError` for frozen dataclasses.
- `with_*` or functional-update methods return **new objects**, not `self`.
- Inputs passed to constructors or functions are **not mutated** after the call.
- Canonical normalization (tuple conversion, sort order) is **stable across calls**.

---

## 13. Escape Hatches (Must Be Explicit)

When true mutability is unavoidable (e.g., large evolving state, streaming accumulators, performance-critical buffers):

- Create a dedicated `State` or `MutableState` type.
- Name it clearly to signal its mutable nature.
- Document invariants, mutation points, and ownership.
- Keep it **out of frozen value objects** and **out of hashing/equality roles**.

```python
from dataclasses import dataclass, field


@dataclass
class PipelineState:
    """Mutable accumulator for pipeline execution state.

    Mutation rationale:
        Collecting thousands of intermediate results into a list before
        creating the immutable PipelineResult is significantly cheaper than
        allocating a new tuple on every append.

    Mutation containment:
        Only PipelineRunner.run() writes to this object.
        Callers receive an immutable PipelineResult; this class never escapes
        the run() scope.

    Invariants enforced by tests:
        - test_pipeline_result_is_immutable
        - test_pipeline_state_not_exposed_to_callers
    """

    errors: list[str] = field(default_factory=list)
    processed_count: int = 0

    def to_result(self) -> 'PipelineResult':
        """Snapshot current state into an immutable result."""
        return PipelineResult(
            errors=tuple(self.errors),
            processed_count=self.processed_count,
        )


@dataclass(frozen=True, slots=True)
class PipelineResult:
    """Immutable snapshot of a completed pipeline run."""

    errors: tuple[str, ...]
    processed_count: int
```

---

## 14. Documentation Rule

Every mutable exception MUST be justified with a docstring block that answers three questions:

```python
class StreamBuffer:
    """Mutable byte accumulator for streaming HTTP responses.

    Mutation rationale:
        Streaming responses arrive in chunks; pre-allocating an immutable
        container is not possible without buffering the entire response first.

    Mutation containment:
        Only StreamReader.read_all() appends to _buffer.
        The buffer is finalized and converted to immutable bytes before
        returning to the caller; _buffer never escapes this class.

    Invariants enforced by tests:
        - test_stream_buffer_result_is_bytes
        - test_stream_buffer_not_accessible_after_finalize
    """

    def __init__(self) -> None:
        self._buffer: list[bytes] = []

    def append(self, chunk: bytes) -> None:
        """Append a chunk to the internal buffer."""
        self._buffer.append(chunk)

    def finalize(self) -> bytes:
        """Return all accumulated chunks as immutable bytes and clear the buffer."""
        result = b''.join(self._buffer)
        self._buffer.clear()
        return result
```

The three required answers:
1. **Mutation rationale** — why mutation is needed here.
2. **Mutation containment** — how mutation is prevented from leaking.
3. **Invariants enforced by tests** — which test(s) verify the contract.
