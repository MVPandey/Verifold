# Async Code

Python's `asyncio` enables concurrent I/O without threading. Use async patterns for all I/O-bound work in services.

---

## Core Rules

- Use `async def` for I/O-bound functions (HTTP calls, DB queries, queue operations).
- Never call blocking I/O directly inside an `async def` — use `asyncio.to_thread()` to offload synchronous I/O.
- Use `httpx.AsyncClient` for HTTP — never `requests` in async code.
- Async resources with open/close semantics (HTTP clients, DB sessions, streams, locks, files) must be managed with context managers: `async with` for local scope and `@asynccontextmanager`/lifespan for app scope.
- For CPU-heavy work, use a process pool or an external worker; do not rely on `asyncio.to_thread()` as a scaling strategy.

---

## Async Context Managers Are Required

Always acquire and release async resources with context managers. This prevents leaks and guarantees cleanup on cancellation/errors.

```python
# Bad — resource lifecycle is manual and easy to leak
client = httpx.AsyncClient()
response = await client.get(url)
return response.json()

# Good — request-scoped lifecycle is explicit and safe
async with httpx.AsyncClient() as client:
    response = await client.get(url)
    return response.json()
```

For shared application resources, use FastAPI `lifespan` with `@asynccontextmanager`.

---

## FastAPI and Async

FastAPI fully supports async route handlers. Prefer async for all routes that perform I/O:

```python
from fastapi import APIRouter, Depends
from my_service.module_a.dependencies import get_order_service
from my_service.module_a.service import OrderService
from my_service.module_a.models import CreateOrderRequest, OrderResponse

router = APIRouter(prefix='/orders', tags=['orders'])


@router.post('/', response_model=OrderResponse, status_code=201)
async def create_order(
    request: CreateOrderRequest,
    service: OrderService = Depends(get_order_service),
) -> OrderResponse:
    """Create a new order."""
    return await service.create_order(request)
```

---

## HTTP Clients — httpx

Never create a new `httpx.AsyncClient` per request — this defeats connection pooling and creates unnecessary overhead.

```python
# Bad — new client per request, no pooling
async def call_api(url: str) -> dict:
    async with httpx.AsyncClient() as client:
        response = await client.get(url)
        return response.json()
```

Create the client once in the application lifecycle and inject it where needed:

```python
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage startup and shutdown of shared resources."""
    app.state.http_client = httpx.AsyncClient(
        timeout=30,
        limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
    )
    yield
    await app.state.http_client.aclose()


app = FastAPI(lifespan=lifespan)


async def call_api(app: FastAPI, url: str) -> dict:
    """Call an external API using the shared client."""
    response = await app.state.http_client.get(url)
    response.raise_for_status()
    return response.json()
```

If you use `@cache` in library code, ensure lifecycle ownership is clear and avoid reusing closed clients.

---

## Blocking I/O in Async Context

Never call blocking functions directly in `async def` — this stalls the entire event loop:

```python
# Bad — blocks the event loop for every request
async def read_config(path: str) -> str:
    with open(path) as f:      # blocking file I/O
        return f.read()

# Good — offload to a thread pool
import asyncio


async def read_config(path: str) -> str:
    """Read a config file without blocking the event loop."""
    return await asyncio.to_thread(_read_sync, path)


def _read_sync(path: str) -> str:
    with open(path) as f:
        return f.read()
```

Common blocking operations to offload with `asyncio.to_thread()`:
- File I/O (`open()`, `Path.read_text()`)
- `subprocess.run()`
- Synchronous DB drivers

CPU-heavy computation should run in a process pool or dedicated worker service.

---

## Concurrent Tasks

Use `asyncio.gather()` to run independent coroutines concurrently:

```python
import asyncio


async def enrich_order(order_id: str) -> EnrichedOrder:
    """Fetch order data and customer data concurrently."""
    order, customer = await asyncio.gather(
        order_repo.get(order_id),
        customer_repo.get_by_order(order_id),
    )
    return EnrichedOrder(order=order, customer=customer)
```

Use `asyncio.TaskGroup` (Python 3.11+) for structured concurrency with better error propagation:

```python
async def fetch_all(ids: list[str]) -> list[Order]:
    """Fetch multiple orders concurrently, failing fast on any error."""
    async with asyncio.TaskGroup() as tg:
        tasks = [tg.create_task(order_repo.get(oid)) for oid in ids]
    return [t.result() for t in tasks]
```

Prefer `TaskGroup` over `gather()` for new code — it has cleaner cancellation semantics and surfaces errors more predictably.

---

## Testing Async Code

Install `pytest-asyncio` and set `asyncio_mode = "auto"` in pytest config — all `async def` test functions then run automatically without needing extra markers:

```toml
[tool.pytest.ini_options]
asyncio_mode = "auto"
```

Use `mocker.AsyncMock()` from `pytest-mock` for async dependencies:

```python
async def test_create_order_returns_response(mocker):
    mock_repo = mocker.AsyncMock()
    mock_repo.save.return_value = {'order_id': '123', 'status': 'ACTIVE'}
    mock_notifier = mocker.AsyncMock()

    service = OrderService(repository=mock_repo, notifier=mock_notifier)
    result = await service.create_order(CreateOrderRequest(customer_id='c1', items=[]))

    assert result.order_id == '123'
    mock_notifier.send_confirmation.assert_called_once()
```

Use `respx` to mock `httpx` calls at the transport level when you need end-to-end testing of HTTP interactions:

```python
import respx
import httpx


async def test_api_call_returns_parsed_data(app: FastAPI):
    with respx.mock:
        respx.get('https://api.example.com/data').mock(
            return_value=httpx.Response(200, json={'key': 'value'})
        )
        result = await call_api(app, 'https://api.example.com/data')

    assert result == {'key': 'value'}
```

---

## Async Generators and Streaming

Use async generators for streaming responses or paginated results:

```python
from collections.abc import AsyncIterator


async def stream_transactions(account_id: str) -> AsyncIterator[Transaction]:
    """Stream transactions for an account page by page."""
    cursor = None
    while True:
        batch, cursor = await tx_repo.get_page(account_id, cursor=cursor)
        for tx in batch:
            yield tx
        if cursor is None:
            break
```

Consume with `async for`:

```python
async for tx in stream_transactions(account_id):
    await process(tx)
```

---

## What NOT to Do

```python
# Never — requests blocks the event loop
import requests
async def fetch(url: str) -> dict:
    return requests.get(url).json()

# Never — time.sleep blocks the event loop
async def wait_a_bit() -> None:
    import time
    time.sleep(5)  # use: await asyncio.sleep(5)

# Never — new client per call (no connection pooling)
async def call(url: str) -> dict:
    async with httpx.AsyncClient() as client:
        return (await client.get(url)).json()
```
