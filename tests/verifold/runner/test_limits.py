import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

import pytest
from acp import schema
from pydantic import JsonValue

from verifold.harnesses.catalog import CATALOG, CLAUDE_LIMITS, CODEX_LIMITS, catalog_with
from verifold.protocol.settings import HarnessSettings
from verifold.protocol.usage import CommandLimits, LimitWindow, MetaLimits, SeatLimits
from verifold.runner.limits import MAX_WINDOWS, crossed, from_meta, from_text, material, merged
from verifold.runner.session import SessionHooks, _Client

FIXTURES = Path(__file__).parent / 'fixtures'
NOW = datetime(2026, 11, 19, 18, tzinfo=UTC)


def _fixture(name: str) -> dict[str, JsonValue]:
    return json.loads((FIXTURES / name).read_text())


def _updates(name: str) -> list[object]:
    return cast('list[object]', _fixture(name)['updates'])


def _update(raw: object) -> object:
    return schema.SessionNotification.model_validate({'sessionId': 's', 'update': raw}).update


async def _refuse(_: object) -> str | None:
    return None


async def _heard(client: _Client, updates: list[object]) -> list[SeatLimits]:
    heard: list[SeatLimits] = []

    async def keep(limits: SeatLimits) -> None:
        heard.append(limits)

    client._hooks = SessionHooks(permissions=_refuse, limits=keep)
    for raw in updates:
        await client.session_update('s', _update(raw))
    return heard


async def test_the_claude_entry_turns_a_rate_limit_event_into_windows_and_a_status() -> None:
    client = _Client(SessionHooks(permissions=_refuse), limits=CATALOG['claude-code'].limits)

    heard = await _heard(client, [_fixture('claude-rate-limit.json')['update']])

    five = LimitWindow(label='5-hour', used_percent=82, resets_at=datetime.fromtimestamp(1795140600, UTC))
    week = LimitWindow(label='weekly', used_percent=41, resets_at=datetime.fromtimestamp(1795600800, UTC))
    assert heard == [SeatLimits(windows=(five, week), status='warning')]
    assert client.limits == heard[-1]


async def test_a_captured_turn_of_each_adapter_reports_no_limits_in_its_updates() -> None:
    for harness, name in (('claude-code', 'claude-turn.json'), ('codex', 'codex-turn.json')):
        client = _Client(SessionHooks(permissions=_refuse), limits=CATALOG[harness].limits)

        heard = await _heard(client, _updates(name))

        assert (heard, client.limits) == ([], None)
    # The Codex adapter lists its command, so Verifold can ask it between two turns.
    assert 'status' in client.commands


def test_the_codex_entry_reads_the_windows_of_its_answer_to_status() -> None:
    status = str(_fixture('codex-turn.json')['status'])

    limits = from_text(CODEX_LIMITS, status, NOW)

    local = NOW.astimezone()
    assert limits == SeatLimits(
        windows=(
            LimitWindow(
                label='weekly', used_percent=74, resets_at=local.replace(month=11, day=25, hour=21, minute=23, second=0)
            ),
        )
    )


def test_a_clock_time_without_a_date_is_the_next_one_and_a_date_in_the_past_is_next_year() -> None:
    later = NOW.astimezone() + timedelta(hours=1)
    earlier = NOW.astimezone() - timedelta(hours=1)
    text = (
        f'**codex 5h limit:** 38% left (resets {later:%H:%M})  \n'
        f'**Weekly limit:** 90.5% left (resets {earlier:%H:%M})  \n'
        '**codex 1d limit:** 10% left (resets 09:00 on 3 Jan)  \n'
        '**codex 7d limit:** 10% left (resets 25:99)  \n'
        '**Limits:** data not available yet'
    )

    limits = from_text(CODEX_LIMITS, text, NOW)

    assert limits is not None
    shown = {window.label: window for window in limits.windows}
    assert set(shown) == {'5-hour', 'weekly', '1-day', '7-day'}
    assert shown['5-hour'].used_percent == 62
    assert shown['5-hour'].resets_at == later.replace(second=0, microsecond=0)
    assert shown['weekly'].used_percent == pytest.approx(9.5)
    assert shown['weekly'].resets_at == (earlier + timedelta(days=1)).replace(second=0, microsecond=0)
    january = shown['1-day'].resets_at
    assert january is not None
    assert (january.year, january.month, january.day) == (2027, 1, 3)
    assert shown['7-day'].resets_at is None


def test_text_without_a_window_gives_no_limits() -> None:
    assert from_text(CODEX_LIMITS, '**Limits:** data not available yet', NOW) is None
    used = CommandLimits(command='/limits', line=r'(?P<name>\w+): (?P<used>\d+)% used(?: on (?P<date>\w+ \d+))?')
    assert from_text(used, 'session: 12% used on Xyz 40', NOW) == SeatLimits(
        windows=(LimitWindow(label='session', used_percent=12),)
    )


def test_a_harness_of_the_persons_settings_states_its_limits_as_data() -> None:
    # A harness that reports its windows under one field, each with its length in minutes, as some adapters do.
    source = MetaLimits(
        key='example/limits',
        windows=('rateLimits.primary', 'rateLimits.secondary'),
        minutes='windowDurationMins',
        used='usedPercent',
        resets='resetsAt',
    )
    entry = HarnessSettings(command=('example-acp',), family='example', limits=source)
    meta: dict[str, JsonValue] = {
        'example/limits': {
            'rateLimits': {
                'primary': {'usedPercent': 62, 'windowDurationMins': 300, 'resetsAt': '2026-11-19T19:10:00+00:00'},
                'secondary': {'usedPercent': 12.5, 'windowDurationMins': 10_080, 'resetsAt': 'soon'},
            }
        }
    }

    added = catalog_with({'example': entry})['example'].limits
    assert isinstance(added, MetaLimits)
    limits = from_meta(added, meta)

    assert limits == SeatLimits(
        windows=(
            LimitWindow(label='5-hour', used_percent=62, resets_at=datetime(2026, 11, 19, 19, 10, tzinfo=UTC)),
            LimitWindow(label='weekly', used_percent=12.5),
        )
    )


@pytest.mark.parametrize(
    'value',
    [
        None,
        'allowed',
        {'status': 'unknown'},
        {'utilization': True, 'rateLimitType': 'five_hour'},
        {'utilization': 'much', 'rateLimitType': 'five_hour'},
        {'utilization': 0.5},
        {'utilization': 0.5, 'rateLimitType': 'five_hour', 'resetsAt': 10**20},
    ],
)
def test_a_value_that_does_not_fit_gives_no_window(value: JsonValue) -> None:
    limits = from_meta(CLAUDE_LIMITS, {'_claude/rateLimit': value})

    assert limits is None or limits.windows == () or limits.windows[0].resets_at is None


def test_a_share_above_all_counts_as_the_whole_window_and_minutes_name_a_window() -> None:
    source = MetaLimits(key='k', minutes='mins', used='used', resets='at')
    meta: dict[str, JsonValue] = {'k': {'used': 130, 'mins': 90, 'at': -5}}

    limits = from_meta(source, meta)

    assert limits == SeatLimits(windows=(LimitWindow(label='90-minute', used_percent=100),))
    assert from_meta(source, {'k': {'used': '40', 'mins': 120}}) == SeatLimits(
        windows=(LimitWindow(label='2-hour', used_percent=40),)
    )


def test_a_report_of_one_window_keeps_the_others_and_the_status() -> None:
    five = LimitWindow(label='5-hour', used_percent=40)
    week = LimitWindow(label='weekly', used_percent=20)
    earlier = SeatLimits(windows=(five, week), status='allowed')

    later = merged(earlier, SeatLimits(windows=(five.model_copy(update={'used_percent': 55}),)))

    assert later == SeatLimits(windows=(week, LimitWindow(label='5-hour', used_percent=55)), status='allowed')
    assert merged(None, earlier) == earlier


def test_the_record_keeps_a_change_that_is_more_than_noise() -> None:
    at = datetime(2026, 11, 19, 19, tzinfo=UTC)
    kept = SeatLimits(windows=(LimitWindow(label='5-hour', used_percent=40.2, resets_at=at),), status='allowed')

    def now(**change: object) -> SeatLimits:
        return SeatLimits(windows=(kept.windows[0].model_copy(update=change),), status='allowed')

    assert not material(kept, None)
    assert material(None, kept)
    assert not material(kept, now(used_percent=40.4, resets_at=at + timedelta(seconds=20)))
    assert material(kept, now(used_percent=41))
    assert material(kept, now(resets_at=at + timedelta(hours=5)))
    assert material(kept, now(resets_at=None))
    assert material(kept, kept.model_copy(update={'status': 'warning'}))
    assert material(kept, SeatLimits(windows=(), status='allowed'))


def test_a_window_that_passes_50_80_or_95_percent_is_kept_at_once() -> None:
    at = datetime(2026, 11, 19, 19, tzinfo=UTC)

    def limits(percent: float, resets: datetime = at, status: str | None = None) -> SeatLimits:
        return SeatLimits.model_validate(
            {'windows': [{'label': '5-hour', 'used_percent': percent, 'resets_at': resets}], 'status': status}
        )

    assert not crossed(None, limits(30))
    assert crossed(None, limits(50))
    assert crossed(None, limits(10, status='allowed'))
    assert not crossed(limits(51), limits(79))
    assert crossed(limits(79), limits(80))
    assert crossed(limits(90), limits(96))
    assert not crossed(limits(96), limits(99))
    # A window that started again counts from zero.
    assert crossed(limits(96), limits(60, at + timedelta(hours=5)))
    assert crossed(limits(60), limits(60, status='reached'))
    assert not crossed(limits(60, status='reached'), limits(60))


def test_a_report_gives_a_seat_eight_windows_at_most() -> None:
    meta: dict[str, JsonValue] = {'k': {'windows': {f'w{number}': {'used': number} for number in range(12)}}}

    limits = from_meta(MetaLimits(key='k', windows=('windows',), used='used'), meta)

    assert limits is not None
    assert [window.label for window in limits.windows] == [f'w{number}' for number in range(MAX_WINDOWS)]
