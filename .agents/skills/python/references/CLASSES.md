# Classes, Factories & Service Logic

Classes provide encapsulation, testability through dependency injection, and clear ownership of behavior. They are generally the best structural default for reusable libraries/framework packages and larger domains, while procedural modules can still be a good fit for smaller, linear application flows.

---

## Core Patterns

### Use the right tool for the job

| Pattern | Use when |
|---|---|
| `dataclass` | Simple data container, no validation needed |
| Pydantic `BaseModel` | Validated domain models, API request/response |
| Pydantic `BaseSettings` | Environment-sourced configuration |
| `ABC` | Interface contract with multiple concrete implementations |
| Plain class | Service logic with injected dependencies |

---

## Procedural vs OOP in App Setup

Use architecture pragmatically based on context and team needs:

- **OOP/class-based setup** is usually the better fit for reusable libraries/frameworks and larger codebases where dependency injection, extension points, and clear ownership matter.
- **Procedural setup** is often a good fit for small services, API handlers, microservices with simple orchestration, scripts, and test-focused workflows.
- Teams should choose the style that keeps behavior readable and maintainable, while still following core engineering practices.

Regardless of style, keep these non-negotiables:

- Explicit dependencies (no hidden globals)
- Clear module boundaries
- Strong typing and validation at boundaries
- Testability (small units, predictable side effects)
- Consistent error handling and lifecycle management

---

## Settings Design Fundamentals

Treat settings as a first-class contract regardless of tooling choice. A good settings approach should provide:

- **Schema validation** at startup (fail fast on missing/invalid config)
- **Environment loading** with explicit prefixing and predictable precedence
- **Caching/singleton access** so settings are parsed once and reused
- **Secret-safe handling** (avoid leaking sensitive values in logs/errors)

`pydantic-settings` `BaseSettings` is one good way to implement this pattern, but teams may use another library that preserves these fundamentals.

### Example: Pydantic `BaseSettings` (one option)

```python
from pydantic import ConfigDict, Field
from pydantic_settings import BaseSettings


class AppSettings(BaseSettings):
    """Application configuration sourced from environment variables."""

    service_name: str = Field(default='my-service')
    db_url: str = Field(..., description='Database connection string')
    timeout_seconds: float = Field(default=30.0, gt=0)
    debug: bool = Field(default=False)

    model_config = ConfigDict(env_prefix='APP_', env_file='.env')
```

Use `@functools.cache` to create a singleton:

```python
from functools import cache


@cache
def get_settings() -> AppSettings:
    """Return the application settings singleton."""
    return AppSettings()
```

---

## Pydantic BaseModel for Domain Objects

Use `BaseModel` for any data that crosses a boundary (API request, API response, database row, event payload):

```python
from pydantic import BaseModel, Field


class CreateOrderRequest(BaseModel):
    """Incoming request body for order creation."""

    customer_id: str
    items: list[OrderItem]
    notes: str | None = None


class OrderResponse(BaseModel):
    """API response for a created order."""

    order_id: str
    status: OrderStatus
    created_at: datetime
```

Do not write custom serialization/validation helpers that duplicate Pydantic behavior. Prefer built-in APIs such as `model_validate`, `model_dump`, `SecretStr`, and `Field(...)`.

---

## Service Classes

Service logic lives inside classes. Dependencies are injected through the constructor:

```python
class OrderService:
    """Handles order creation and fulfillment."""

    def __init__(self, repository: OrderRepository, notifier: Notifier) -> None:
        self._repository = repository
        self._notifier = notifier

    async def create_order(self, request: CreateOrderRequest) -> OrderResponse:
        """Create a new order and dispatch a confirmation notification."""
        order = await self._repository.save(request)
        await self._notifier.send_confirmation(order)
        return OrderResponse.model_validate(order)
```

- Each class owns one domain of behavior.
- Dependencies are explicit — no hidden globals, no module-level singletons created inside the class.

---

## Abstract Base Classes

Use `abc.ABC` to define interface contracts when multiple implementations exist:

```python
from abc import ABC, abstractmethod
from pathlib import Path


class FileParser(ABC):
    """Interface for file format parsers."""

    @property
    @abstractmethod
    def supported_extensions(self) -> tuple[str, ...]:
        """Return the file extensions this parser handles."""
        ...

    @abstractmethod
    def parse(self, file_path: Path) -> dict:
        """Parse the file at file_path and return structured data."""
        ...


class YAMLParser(FileParser):
    """YAML file parser implementation."""

    @property
    def supported_extensions(self) -> tuple[str, ...]:
        return ('.yaml', '.yml')

    def parse(self, file_path: Path) -> dict:
        ...
```

- The ABC lives in `domain/base.py`.
- Each concrete implementation gets its own file: `domain/yaml_parser.py`, `domain/json_parser.py`.

---

## Factory Class Methods

Use `@classmethod` factory methods when a class has multiple construction paths:

```python
class ReportGenerator:
    """Generates reports from various input sources."""

    def __init__(self, data: list[dict], template: str) -> None:
        self._data = data
        self._template = template

    @classmethod
    def from_file(cls, path: Path) -> 'ReportGenerator':
        """Construct a ReportGenerator by reading data from a JSON file."""
        data = json.loads(path.read_text())
        return cls(data=data, template='default')

    @classmethod
    def from_api(cls, client: APIClient, query: str) -> 'ReportGenerator':
        """Construct a ReportGenerator by fetching data from the API."""
        data = client.query(query)
        return cls(data=data, template='api')
```

---

## Singletons and Caching

Use `@functools.cache` for resources that are expensive to create and safe to share in library code.

For service applications, prefer lifecycle-owned resources (for example FastAPI `lifespan` + `app.state`) and inject them into classes instead of relying on module-global cached clients.

```python
from functools import cache
import httpx


@cache
def get_http_client() -> httpx.AsyncClient:
    """Return the application-wide HTTP client (created once)."""
    return httpx.AsyncClient(
        timeout=30,
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
    )
```

Use `@functools.lru_cache` when you need a bounded cache:

```python
from functools import lru_cache


@lru_cache(maxsize=256)
def resolve_template(name: str) -> str:
    """Load and cache a named template from disk."""
    return (TEMPLATES_DIR / f'{name}.html').read_text()
```

Cache file reads, parsed configs, compiled regexes, and other idempotent results.

### What NOT to do

```python
# Bad — re-reads file on every call
def get_config():
    with open('config.yaml') as f:
        return yaml.safe_load(f)

# Bad — new HTTP client per request
async def call_api(url: str):
    async with httpx.AsyncClient() as client:
        return await client.get(url)

# Bad — recompiles regex in a hot loop
def is_valid(value: str) -> bool:
    return bool(re.compile(r'^[A-Z]+$').match(value))
```

---

## Module-level Compiled Patterns

Compile regex patterns at module level, not inside functions:

```python
import re

# Good — compiled once at import time
_ENV_VAR_PATTERN = re.compile(r'^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$')


def is_env_var_name(value: str) -> bool:
    """Return True if value looks like a valid environment variable name."""
    return bool(_ENV_VAR_PATTERN.match(value))
```

---

## Composition over Inheritance

Inherit only when there is a true "is-a" relationship. For everything else, compose:

```python
# Bad — forces subclassing to change behavior
class BaseProcessor:
    def process(self, data): ...

class MyProcessor(BaseProcessor):
    def process(self, data): ...

# Good — inject the strategy
class Processor:
    def __init__(self, strategy: ProcessingStrategy) -> None:
        self._strategy = strategy

    def process(self, data: bytes) -> dict:
        return self._strategy.execute(data)
```

---

## FastAPI Lifespan for Shared Resources

Use FastAPI's `lifespan` context manager for startup and shutdown of shared resources:

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle — startup and shutdown."""
    app.state.http_client = httpx.AsyncClient(
        timeout=30,
        limits=httpx.Limits(max_connections=100),
    )
    yield
    await app.state.http_client.aclose()


app = FastAPI(lifespan=lifespan)
```

This is the preferred pattern over deprecated `@app.on_event("startup")` handlers.
