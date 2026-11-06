# Logging

Logging is owned by the **service**, not by reusable packages.

This is the most important logging rule: **library and framework packages must not log**.

---

## The Core Rule

| Code type | Logging allowed? |
|---|---|
| Library / framework package | ❌ Never |
| Service (FastAPI app, worker, CLI) | ✅ Yes — at boundaries |

---

## Why Libraries Must Not Log

Libraries are shared across services that have different logging backends, formats, and verbosity requirements. Embedding `logger.info(...)` in a library:

- Forces log noise on every consumer regardless of their log level.
- Ties the library to a logging library the service may not use.
- Makes unit testing verbose — captured log output is not the library's contract.

A library's communication mechanism is **return values and exceptions**. If something goes wrong, raise an exception. If there's a result, return it. Let the service decide what to record.

---

## What Libraries Must NOT Do

```python
# Bad — library logging
import logging

logger = logging.getLogger(__name__)

def load_config(path: str) -> dict:
    logger.info('Loading config from %s', path)  # ❌ do not log
    ...

# Bad — any output
def parse(raw: bytes) -> dict:
    print('Parsing...')  # ❌ do not print
    ...
```

---

## Service-Level Logging

Follow your repository or platform's logging standard. When unspecified, use Python's stdlib `logging` module configured for structured output.

### Python Standard Logging

Use Python's stdlib `logging` module as the foundation. Configure it with structured output:

```python
import logging

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(name)s %(message)s',
)
logger = logging.getLogger(__name__)
```

Most structured-logging integrations layer on top of stdlib `logging` via handlers, so this pattern is always correct as a base.

### Log at Boundaries

Log when something crosses a system boundary:

- Incoming request received
- Outgoing external call made / response received
- Error caught and handled
- Background job started / completed

```python
logger.info(
    'order_request_received',
    extra={'customer_id': request.customer_id, 'item_count': len(request.items)},
)

try:
    order = await fulfillment_client.submit(order_data)
except ExternalServiceError as e:
    logger.error(
        'fulfillment_failed',
        extra={'order_id': order_id, 'error': str(e)},
    )
    raise
```

### Prefer Structured, Machine-Parseable Messages

Avoid embedding variable data directly in log message strings using f-strings when you want the fields to be queryable. Keep the static message template separate from variable data:

```python
# Less structured — harder to query by field
logger.info(f'Order {order_id} created for customer {customer_id}')

# More structured — static event name + extra context
logger.info('order_created', extra={'order_id': order_id, 'customer_id': customer_id})
```

If your logging integration supports keyword arguments or structured extras, prefer that form.

### Log Message Style

Write the human-readable portion of a log message as proper English, not as code-style key=value soup. Variable identifiers in the source (e.g. `prompt_tokens`, `image_url`) should not leak into the prose verbatim — translate them.

- **Capitalize** the first word; end full sentences with a period (or use parenthetical context naturally).
- **Spell things out** — use "prompt tokens" not `prompt_tokens`, "model" not `model_id`, "image (elided)" not `image_url=<elided>`.
- **Reserve `key=value` syntax** for stable, machine-parseable identifiers in structured-logging contexts (event names, trace IDs, IDs that downstream queries pivot on). The same goes for `extra=` / structured kwargs — those *should* use the underscored field name.
- **Avoid abbreviations** in message templates: `Request message %d` reads better than `request msg[%d]`.

```python
# Bad — code-y, lowercase, mirrors variable names
logger.info('completion done model=%s prompt_tokens=%d completion_tokens=%d', m, p, c)
logger.debug('request msg[0] role=%s text=%r', role, text)

# Good — proper English in the template; structured fields stay underscored if used
logger.info('Completion finished (model: %s, prompt tokens: %d, completion tokens: %d).', m, p, c)
logger.debug('Request message 0 (role: %s): %r', role, text)
```

The rule applies to the **prose template**, not to `extra={}` keys, dict keys, or other machine-targeted data — those keep their snake_case identifiers so queries and dashboards remain stable.

---

## Log Levels

| Level | When to use |
|---|---|
| `DEBUG` | Internal state useful for debugging — disable in production |
| `INFO` | Normal lifecycle events: start, stop, major state transitions |
| `WARNING` | Something unexpected but recoverable happened |
| `ERROR` | A failure that impacts a specific request or operation |
| `CRITICAL` | System-level failure that may halt the application |

Avoid excessive `DEBUG` logs in production — they create noise and impact performance.

---

## Never Log Sensitive Data

Do not log:
- Passwords, API keys, tokens, secrets.
- `SecretStr` values — Pydantic masks them in `__repr__`, but don't explicitly log `.get_secret_value()`.
- PII: names, email addresses, card numbers, SSNs.
- Full request bodies containing any of the above.

```python
# Bad — logs a secret value
logger.info('connecting', extra={'db_url': settings.db_url})  # may contain password

# Good — log only non-sensitive metadata
logger.info('db_pool_initialized', extra={'pool_size': pool.max_size})
```

---

## Observability Integration

Apply the logging and observability stack required by your platform or repository. A typical structured-observability setup provides:

- Structured, OTel-compatible log ingestion
- Dashboard and alerting configuration
- Business-level metric derivation from log events
- Distributed tracing via OpenTelemetry
