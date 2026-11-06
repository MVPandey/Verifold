# Naming Conventions

Python naming is intentionally simple. This reference defines the conventions used across all Python code in this guide.

---

## Core Principles

1. **Names should communicate intent** — a reader should understand the purpose without needing to read the implementation.
2. **Consistency reduces cognitive load** — following one convention everywhere means fewer micro-decisions.
3. **Avoid abbreviations** unless they are universally understood in context.

---

## Summary Table

| Construct | Convention | Example |
|---|---|---|
| Package | `lowercase` | `orderservice`, `configloader` |
| Module (file) | `lower_snake_case` | `order_service.py`, `yaml_parser.py` |
| Class | `PascalCase` | `OrderService`, `AppSettings`, `YAMLParser` |
| Exception | `PascalCase` + `Error` suffix | `ConfigError`, `NotFoundError` |
| Function / method | `snake_case` | `load_config`, `create_order` |
| Constant | `UPPER_SNAKE_CASE` | `DEFAULT_TIMEOUT`, `MAX_RETRIES` |
| Type alias | `PascalCase` | `type RouteMap = dict[str, list[str]]` |
| Private member | `_` prefix | `_client`, `_get_parser` |
| "Protected" class member | `_` prefix | `_config`, `_registry` |
| Truly internal (dunder) | `__` prefix | `__slots__` (sparingly) |

---

## Package and Module Names

- All lowercase, no hyphens (use underscores for multi-word modules).
- Short, evocative, singular: `parser` not `parsers`, `service` not `services`.
- Avoid generic suffixes: `utils`, `helpers`, `common` — name after the domain instead.

```text
# Good
order_service.py
yaml_parser.py
settings.py

# Bad
utils.py           # what kind of utils?
helpers.py         # too generic
service_utils.py   # redundant
```

---

## Class Names

Use `PascalCase`. Name after the domain concept, not the implementation detail:

```python
# Good
class OrderRepository: ...
class TransactionValidator: ...
class EmbeddingModel: ...

# Bad
class OrderRepo: ...           # abbreviation
class ValidateTx: ...          # verb-noun pattern, not a class
class EmbeddingModelImpl: ...  # "Impl" suffix leaks implementation
```

**Avoid generic suffixes** unless they carry real meaning:

| Avoid | Prefer |
|---|---|
| `OrderManager` | `OrderService` or `Orders` |
| `DataProcessor` | `ReportBuilder`, `EventTransformer` |
| `BaseHelper` | `Formatter`, `Parser` |

### Acronyms in Class Names

Treat acronyms as words:

```python
# Good
class HttpClient: ...
class ApiGateway: ...
class JsonParser: ...

# Bad
class HTTPClient: ...  # inconsistent caps
class APIGateway: ...
```

---

## Function and Method Names

Use `snake_case`. Functions should read as actions:

```python
# Good
def load_config() -> AppSettings: ...
def create_order(request: CreateOrderRequest) -> Order: ...
def is_valid_currency(code: str) -> bool: ...
def has_permission(user_id: str, resource: str) -> bool: ...

# Bad
def config() -> AppSettings: ...       # ambiguous — load? get? create?
def orderCreate(): ...                  # camelCase, wrong Python convention
def validCurrency(code: str): ...       # not snake_case
```

**Boolean functions** read as questions:
- `is_*` — state check: `is_active`, `is_expired`, `is_valid`
- `has_*` — possession check: `has_permission`, `has_items`
- `can_*` — capability check: `can_retry`, `can_publish`

**Functions that fetch data** read as noun phrases:
- `get_order`, `load_config`, `fetch_transactions`, `build_report`

---

## Constants

`UPPER_SNAKE_CASE` at module level:

```python
DEFAULT_TIMEOUT: float = 30.0
MAX_RETRIES: int = 3
ENV_VAR_PATTERN = re.compile(r'^[A-Z][A-Z0-9_]+$')
```

For collections of related constants, use `enum.Enum` or `enum.StrEnum`:

```python
from enum import StrEnum

class OrderStatus(StrEnum):
    PENDING = 'PENDING'
    ACTIVE = 'ACTIVE'
    CANCELLED = 'CANCELLED'
    COMPLETED = 'COMPLETED'
```

Prefer `StrEnum` when the string value matters (e.g., API responses, DB values).

---

## Private Members

Prefix with a single underscore `_` to signal "internal to this module/class":

```python
class WidgetService:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient = _build_client()  # private attribute
        self._cache: dict[str, str] = {}

    def _validate(self, widget_id: str) -> None:
        """Internal validation — not part of public API."""
        ...
```

Double underscore `__` (name mangling) should be used **sparingly** — only when subclass collision is a real concern.

---

## Type Aliases

Use `PascalCase` for type aliases. In Python 3.12+ codebases, define aliases with `type Alias = ...`:

```python
type IPv4 = str
type Port = int
type Address = tuple[IPv4, Port]
type RouteMap = dict[str, list[Address]]
```

For repositories pinned to 3.11, use `TypeAlias` syntax for compatibility.

---

## Variables

- Descriptive names, even in short scopes: `order` not `o`, `response` not `r`.
- Single-letter variables are acceptable **only** in:
  - Comprehensions: `[x * 2 for x in values]`
  - Trivial lambdas: `sorted(items, key=lambda x: x.created_at)`
  - Mathematical formulas where the letter is standard: `t` for time, `n` for count.
- Avoid negated boolean names (`not_ready`, `is_not_valid`) — they make conditionals harder to read.

```python
# Bad
if not is_not_valid:
    ...

# Good
if is_valid:
    ...
```

---

## Test Names

Test function names should be descriptive enough to understand without reading the body:

```python
# Good
def test_load_config_raises_config_error_when_db_url_missing(): ...
def test_create_order_sends_confirmation_notification(): ...
def test_is_valid_currency_returns_false_for_unknown_code(): ...

# Bad
def test_config(): ...
def test_error(): ...
def test_1(): ...
```
