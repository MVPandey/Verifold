"""
What a harness reports about its provider's usage limits, read as data, and when the record keeps a change.

The harness's catalog entry says where the limits are: in the `_meta` of its ACP session updates, or in its answer to
one of its own commands. The words and numbers are the harness's, so this reads them as data, and a value that does
not fit is left out.
"""

import re
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta

from pydantic import JsonValue

from verifold.protocol.agents import one_line
from verifold.protocol.usage import CommandLimits, LimitWindow, MetaLimits, SeatLimits

THRESHOLDS = (50, 80, 95)
"""The percents of a window that the record keeps at once when a window passes them, also during a turn."""

_SPANS = ((10_080, 'weekly'), (1_440, '1-day'))
_HOUR = 60
_MONTHS = ('jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec')
_DAY_MONTH = re.compile(r'(\d{1,2})\s+([A-Za-z]{3})|([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})')
_EARLIEST = datetime(2020, 1, 1, tzinfo=UTC)
_LATEST = datetime(2100, 1, 1, tzinfo=UTC)
_LABEL = 40


def from_meta(source: MetaLimits, meta: Mapping[str, JsonValue] | None) -> SeatLimits | None:
    """Return the limits in the `_meta` of one session update, or `None` when it holds none under the source's key."""
    value = meta.get(source.key) if meta else None
    if not isinstance(value, dict):
        return None
    windows: list[LimitWindow] = []
    for path in source.windows:
        found = _at(value, path)
        if not isinstance(found, dict):
            continue
        if source.used in found:
            windows.extend(_meta_window(source, found, None))
        else:
            for name, inner in found.items():
                if isinstance(inner, dict):
                    windows.extend(_meta_window(source, inner, name))
    word = _at(value, source.status) if source.status else None
    status = source.statuses.get(word) if isinstance(word, str) else None
    kept = _unique(windows)
    return SeatLimits(windows=kept, status=status) if kept or status else None


def from_text(source: CommandLimits, text: str, now: datetime) -> SeatLimits | None:
    """
    Return the limits in a harness's answer to its command, or `None` when the answer holds no window.

    `now` dates a clock time without a date: the next such time on this computer's clock.
    """
    windows: list[LimitWindow] = []
    for match in re.finditer(source.line, text):
        groups = match.groupdict()
        name = groups.get('name')
        used, left = _number(groups.get('used')), _number(groups.get('left'))
        percent = used if used is not None else None if left is None else 100 - left
        if not name or percent is None:
            continue
        resets = _clock(groups.get('time'), groups.get('date'), now)
        windows.extend(_window(source.labels.get(name, name), percent, resets))
    kept = _unique(windows)
    return SeatLimits(windows=kept) if kept else None


def merged(earlier: SeatLimits | None, later: SeatLimits) -> SeatLimits:
    """
    Return the limits after a later report: its windows over the earlier ones, and its status when it has one.

    A window of the later report replaces the earlier window with the same label. A harness can report one window
    at a time, so a window that the later report leaves out stays as it was, and so does the status.
    """
    if earlier is None:
        return later
    labels = {window.label for window in later.windows}
    kept = tuple(window for window in earlier.windows if window.label not in labels)
    return SeatLimits(windows=(*kept, *later.windows), status=later.status or earlier.status)


def material(kept: SeatLimits | None, now: SeatLimits | None) -> bool:
    """
    Return whether the limits differ from the ones that the record keeps by more than the noise of a report.

    They do when the status or the windows differ, when a window's whole percent differs, or when its reset time
    moved by a minute or more.
    """
    if now is None:
        return False
    if kept is None or kept.status != now.status:
        return True
    before = {window.label: window for window in kept.windows}
    if set(before) != {window.label for window in now.windows}:
        return True
    return any(_moved(before[window.label], window) for window in now.windows)


def crossed(kept: SeatLimits | None, now: SeatLimits) -> bool:
    """
    Return whether a window passed one of the `THRESHOLDS` since the limits that the record keeps.

    A change of the status counts too. A window that started again counts from zero.
    """
    if kept is None:
        return now.status is not None or any(window.used_percent >= THRESHOLDS[0] for window in now.windows)
    if kept.status != now.status and now.status is not None:
        return True
    before = {window.label: window for window in kept.windows}
    for window in now.windows:
        old = before.get(window.label)
        start = 0.0 if old is None or old.resets_at != window.resets_at else old.used_percent
        if any(start < mark <= window.used_percent for mark in THRESHOLDS):
            return True
    return False


def _moved(old: LimitWindow, new: LimitWindow) -> bool:
    if round(old.used_percent) != round(new.used_percent):
        return True
    if (old.resets_at is None) != (new.resets_at is None):
        return True
    return bool(old.resets_at and new.resets_at and abs(old.resets_at - new.resets_at) >= timedelta(minutes=1))


def _at(value: dict[str, JsonValue], path: str) -> JsonValue:
    found: JsonValue = value
    for name in path.split('.') if path else ():
        found = found.get(name) if isinstance(found, dict) else None
    return found


def _meta_window(source: MetaLimits, window: dict[str, JsonValue], key: str | None) -> list[LimitWindow]:
    named = _at(window, source.name) if source.name else None
    minutes = _number(_at(window, source.minutes)) if source.minutes else None
    name = named if isinstance(named, str) and named else key or (_span(minutes) if minutes else None)
    used = _number(_at(window, source.used))
    if not name or used is None:
        return []
    resets = _time(_at(window, source.resets)) if source.resets else None
    return _window(source.labels.get(name, name), used * 100 / source.scale, resets)


def _window(label: str, percent: float, resets: datetime | None) -> list[LimitWindow]:
    text = one_line(label)[:_LABEL]
    return [LimitWindow(label=text, used_percent=min(max(percent, 0.0), 100.0), resets_at=resets)] if text else []


def _unique(windows: list[LimitWindow]) -> tuple[LimitWindow, ...]:
    # One window for each label: the first that the report holds, in the report's order.
    first: dict[str, LimitWindow] = {}
    for window in windows:
        first.setdefault(window.label, window)
    return tuple(first.values())


def _span(minutes: float) -> str:
    whole = round(minutes)
    named = next((name for length, name in _SPANS if whole == length), None)
    if named:
        return named
    return f'{whole // _HOUR}-hour' if whole % _HOUR == 0 else f'{whole}-minute'


def _number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _time(value: JsonValue) -> datetime | None:
    # Unix seconds, or an ISO time with its zone. A time that no window can have is left out.
    found: datetime | None = None
    if isinstance(value, int | float) and not isinstance(value, bool):
        try:
            found = datetime.fromtimestamp(value, UTC)
        except (OverflowError, OSError, ValueError):
            return None
    elif isinstance(value, str):
        try:
            found = datetime.fromisoformat(value)
        except ValueError:
            return None
    if found is None or found.tzinfo is None:
        return None
    return found if _EARLIEST <= found <= _LATEST else None


def _clock(time: str | None, date: str | None, now: datetime) -> datetime | None:
    # A clock time on this computer's clock, on its date, or else the next such time.
    hours, _, minutes = (time or '').partition(':')
    day = _day(date) if date else None
    try:
        local = now.astimezone().replace(hour=int(hours), minute=int(minutes), second=0, microsecond=0)
        if not date:
            return local if local > now else local + timedelta(days=1)
        if day is None:
            return None
        dated = local.replace(month=day[0], day=day[1])
        # A date without a year is the next one: a reset that lies more than a day back is in the next year.
        return dated if dated >= now - timedelta(days=1) else dated.replace(year=dated.year + 1)
    except ValueError:
        return None


def _day(date: str) -> tuple[int, int] | None:
    match = _DAY_MONTH.search(date)
    if match is None:
        return None
    day, month = (match[1], match[2]) if match[1] else (match[4], match[3])
    name = month.lower()[:3]
    return (_MONTHS.index(name) + 1, int(day)) if name in _MONTHS else None
