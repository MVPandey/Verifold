"""
What Verifold reads in the error of a harness that failed.

That is the text that the record keeps, whether the provider limits the harness, and when such a limit resets. The words are the provider's and the harness's, so this reads them as data. A text that names a rate limit, a usage
limit, a quota, or the HTTP status 429 is a provider's limit. A reset time in it is one of the forms that harnesses
print: a Unix time after a bar, an ISO time, "in 2 hours 5 minutes", "after 30 seconds", or a clock time such as
"resets 3pm (Europe/Berlin)".
"""

import json
import re
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import acp

MAX_ERROR = 2_000
"""The most characters of a harness's error that the record keeps."""

MAX_RESET = timedelta(days=8)
"""The latest reset that Verifold waits for. A provider's longest usage limit is a week."""

_LIMIT = re.compile(
    r'rate[ _-]?limit|usage[ _-]?limit|\bquota\b|\b429\b|too many requests|limit (?:reached|exceeded)|hit your limit'
    r'|resource[ _]exhausted',
    re.IGNORECASE,
)

_UNITS = {'d': 86_400, 'h': 3_600, 'm': 60, 's': 1}
_HALF_DAY = 12
_HOUR = 60
_SPAN = r'\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b'
_IN = re.compile(rf'(?:again|retry|resets?)\s+(?:in|after)\s+((?:{_SPAN}[\s,]*(?:and\s+)?)+)', re.IGNORECASE)
_SECONDS = re.compile(
    r'(?:retry[ _-]after|resets?_in_seconds|retry_after_seconds)"?\s*[:=]?\s*"?(\d+)(?:\s*(?:s|secs?|seconds?)\b)?',
    re.IGNORECASE,
)
_EPOCH = re.compile(r'(?:\||resets?_?at"?\s*[:=]\s*"?)(\d{10})(?!\d)', re.IGNORECASE)
_ISO = re.compile(r'\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})')
_CLOCK = re.compile(
    r'(?:resets?|again)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)(?:\s*\(([A-Za-z_]+(?:/[A-Za-z_+-]+)*)\))?',
    re.IGNORECASE,
)


def error_text(error: BaseException) -> str:
    """
    Return a harness's failure as the record keeps it: the error's type and text, cut to `MAX_ERROR` characters.

    An ACP error's text is often only its kind, such as "Internal error", and its data holds what the harness said.
    So the data comes after the text.
    """
    text = f'{type(error).__name__}: {error}'
    if isinstance(error, acp.RequestError) and error.data is not None:
        text = f'{text} {json.dumps(error.data, default=str, ensure_ascii=False)}'
    return text[:MAX_ERROR]


def provider_limit(text: str) -> bool:
    """Return whether an error's text says that the provider limits the harness."""
    return bool(_LIMIT.search(text))


def reset_at(text: str, now: datetime) -> datetime | None:
    """
    Return when a provider's limit resets, by the error's text, or `None` when it names no time that is to come.

    `now` dates a span such as "in 2 hours". A reset later than `MAX_RESET` from now does not count.
    """
    found = _found(text, now)
    return found if found and now < found <= now + MAX_RESET else None


def _found(text: str, now: datetime) -> datetime | None:
    # The first form that the text holds, in this order.
    if match := _EPOCH.search(text):
        return datetime.fromtimestamp(int(match[1]), UTC)
    if match := _IN.search(text):
        spans = re.findall(r'(\d+)\s*([a-z])', match[1], re.IGNORECASE)
        return now + timedelta(seconds=sum(int(count) * _UNITS[unit.lower()] for count, unit in spans))
    if match := _SECONDS.search(text):
        return now + timedelta(seconds=int(match[1]))
    if match := _ISO.search(text):
        return _iso(match[0])
    match = _CLOCK.search(text)
    return _clock(match, now) if match else None


def _iso(text: str) -> datetime | None:
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _clock(match: re.Match[str], now: datetime) -> datetime | None:
    # A clock time without a date is the next such time: today, or tomorrow when it passed. Without a zone, it is
    # this computer's.
    hour, minute = int(match[1]), int(match[2] or 0)
    if not 1 <= hour <= _HALF_DAY or minute >= _HOUR:
        return None
    hour = hour % _HALF_DAY + (_HALF_DAY if match[3].lower().startswith('p') else 0)
    try:
        zone = ZoneInfo(match[4]) if match[4] else None
    except (ZoneInfoNotFoundError, ValueError):
        zone = None
    local = now.astimezone(zone)
    at = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    return at if at > local else at + timedelta(days=1)
