from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import acp
import pytest

from verifold.runner.retry import MAX_ERROR, error_text, provider_limit, reset_at

NOW = datetime(2026, 11, 18, 12, tzinfo=UTC)


@pytest.mark.parametrize(
    'text',
    [
        'Claude AI usage limit reached|1795003200',
        'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
        "You've hit your usage limit. Upgrade to Pro, or try again in 2 hours.",
        'Quota exceeded for this project.',
        'stream error: exceeded retry limit, last status: 429 Too Many Requests',
        '5-hour limit reached ∙ resets 3pm',
        'RESOURCE_EXHAUSTED: you are rate-limited',
    ],
)
def test_the_words_of_a_providers_limit_mark_the_error(text: str) -> None:
    assert provider_limit(text)


@pytest.mark.parametrize('text', ['BrokenPipeError: The harness closed its stdin.', 'RequestError: Internal error'])
def test_another_error_is_no_providers_limit(text: str) -> None:
    assert not provider_limit(text)


@pytest.mark.parametrize(
    ('text', 'at'),
    [
        (f'Claude AI usage limit reached|{int((NOW + timedelta(hours=3)).timestamp())}', NOW + timedelta(hours=3)),
        ('try again in 2 days 3 hours 25 minutes.', NOW + timedelta(days=2, hours=3, minutes=25)),
        ('Please retry after 2 minutes', NOW + timedelta(minutes=2)),
        ('429 Too Many Requests, Retry-After: 120', NOW + timedelta(seconds=120)),
        ('{"error": {"resets_in_seconds": 600}}', NOW + timedelta(seconds=600)),
        ('Your quota resets at 2026-11-18T14:20:00Z.', datetime(2026, 11, 18, 14, 20, tzinfo=UTC)),
        (
            'Usage limit reached, resets 3pm (America/Los_Angeles)',
            datetime(2026, 11, 18, 15, tzinfo=ZoneInfo('America/Los_Angeles')),
        ),
        # The clock time passed today, so it is tomorrow's.
        ('limit reached, resets at 11:30am (UTC)', datetime(2026, 11, 19, 11, 30, tzinfo=UTC)),
    ],
)
def test_a_reset_time_in_the_error_is_when_the_limit_resets(text: str, at: datetime) -> None:
    assert reset_at(text, NOW) == at


@pytest.mark.parametrize(
    'text',
    [
        'rate limit',
        # A time that passed, a time beyond a week and a day, and a clock time that no clock shows name no reset.
        f'usage limit reached|{int((NOW - timedelta(hours=1)).timestamp())}',
        'try again in 30 days',
        'rate limit, resets 13pm',
    ],
)
def test_an_error_without_a_reset_time_to_come_names_none(text: str) -> None:
    assert reset_at(text, NOW) is None


def test_a_clock_time_in_a_zone_that_this_computer_does_not_know_is_in_the_computers_own_zone() -> None:
    local = NOW.astimezone()
    nine = local.replace(hour=21, minute=0, second=0, microsecond=0)

    assert reset_at('rate limit, resets 9pm (Nowhere/Land)', NOW) == (
        nine if nine > local else nine + timedelta(days=1)
    )


def test_the_record_keeps_what_an_acp_error_carries_after_its_kind_and_no_more_than_its_limit() -> None:
    limited = acp.RequestError(-32603, 'Internal error', {'details': 'Claude AI usage limit reached|1795003200'})

    assert error_text(limited) == (
        'RequestError: Internal error {"details": "Claude AI usage limit reached|1795003200"}'
    )
    assert error_text(BrokenPipeError('closed')) == 'BrokenPipeError: closed'
    assert len(error_text(ValueError('x' * 10_000))) == MAX_ERROR
