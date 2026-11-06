# Error Handling

Exceptions are part of the public API contract.

Define a custom exception hierarchy per package so callers can reliably detect and handle specific failure modes without string matching.

---

## Core Principles

### 1. Define a Custom Exception Hierarchy

Every package defines a single base exception and builds a hierarchy from it:

```python
class AppException(Exception):
    """Base exception for this package."""


class ConfigError(AppException):
    """Raised when configuration is missing or invalid."""


class ValidationError(AppException):
    """Raised when input data fails validation."""


class NotFoundError(AppException):
    """Raised when a requested resource does not exist."""


class ExternalServiceError(AppException):
    """Raised when a downstream service call fails."""
```

Place the hierarchy in `exceptions.py` at the package root. Import from there everywhere else.

---

### 2. Raise Specific Exceptions

Never raise bare `Exception`:

```python
# Bad
raise Exception('something went wrong')

# Good
raise ConfigError(f'Required field "api_url" is missing from settings')
```

---

### 3. Chain with `from` to Preserve Tracebacks

Always chain when converting a lower-level error into a domain exception:

```python
# Good — preserves the original traceback
try:
    config = AppSettings()
except PydanticValidationError as e:
    raise ConfigError(f'Settings validation failed: {e}') from e

# Bad — loses the original cause
try:
    config = AppSettings()
except PydanticValidationError as e:
    raise ConfigError(f'Settings validation failed: {e}')
```

---

### 4. Don't Catch What You Can't Handle

Let exceptions propagate to the layer that can act on them.

```python
# Bad — swallows the error
try:
    result = fetch_data(key)
except NotFoundError:
    pass  # silent failure

# Good — let it propagate to the service/route handler
result = fetch_data(key)
```

If you catch to log and re-raise, that's fine — but only in service code, not in libraries:

```python
# OK in a service route handler
try:
    result = await order_service.create_order(request)
except ExternalServiceError as e:
    logger.error('order_creation_failed', error=str(e))
    raise
```

---

### 5. No Bare Except

Never use `except:` or `except Exception:` without re-raising:

```python
# Bad
try:
    data = parse(raw)
except Exception:
    return None  # hides failures

# Good
try:
    data = parse(raw)
except ParseError as e:
    raise ValidationError(f'Failed to parse input: {e}') from e
```

---

## Libraries Raise; Services Catch

| Layer | Responsibility |
|---|---|
| **Library / framework package** | Define and raise domain exceptions. Never log. |
| **Service (FastAPI route, worker)** | Catch domain exceptions, log, and convert to API responses. |

Example in a FastAPI service:

```python
from fastapi import Request
from fastapi.responses import JSONResponse
from my_service.exceptions import NotFoundError, ValidationError


@app.exception_handler(NotFoundError)
async def not_found_handler(request: Request, exc: NotFoundError) -> JSONResponse:
    return JSONResponse(status_code=404, content={'detail': str(exc)})


@app.exception_handler(ValidationError)
async def validation_handler(request: Request, exc: ValidationError) -> JSONResponse:
    return JSONResponse(status_code=422, content={'detail': str(exc)})
```

Register exception handlers at app creation time (for example via `@app.exception_handler(...)` or `app.add_exception_handler(...)`). Do not scatter `try/except` throughout route handlers for expected domain errors.

---

## Exception Naming

- Suffix with `Error` for error conditions: `ConfigError`, `ParseError`, `TimeoutError`.
- Suffix with `Exception` only for the package base class.
- Name after the domain concept, not the implementation: `NotFoundError` not `DatabaseRowMissingError`.

---

## Pydantic Validation Errors

Pydantic raises `pydantic.ValidationError` internally. Always wrap it in a domain exception before it crosses a module boundary:

```python
from pydantic import ValidationError as PydanticValidationError
from mypackage.exceptions import ConfigError


def load_config(data: dict) -> AppConfig:
    """Load and validate application config from a raw dict."""
    try:
        return AppConfig.model_validate(data)
    except PydanticValidationError as e:
        raise ConfigError(f'Invalid config: {e}') from e
```

This ensures callers only ever see your package's exception types, not Pydantic internals.

---

## What NOT to Do

```python
# Never — string matching instead of exception type
if 'not found' in str(err):
    ...

# Never — bare raise with no context
except Exception as e:
    raise AppException('error') from e  # loses original message

# Never — log and swallow in a library
except IOError:
    logger.warning('file error')  # libraries don't log
    return None
```
