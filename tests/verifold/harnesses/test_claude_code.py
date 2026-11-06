import json
from pathlib import Path

from pydantic import SecretStr

from verifold.harnesses.base import Turn, TurnReport
from verifold.harnesses.claude_code import CREDENTIAL_PATHS, ClaudeCode


def turn(tmp_path: Path, **fields: str | None) -> Turn:
    return Turn.model_validate(
        {
            'prompt': 'Work on the question.',
            'folder': tmp_path / 'folder',
            'private': tmp_path / 'private',
            'mcp_url': 'http://127.0.0.1:8123/mcp',
            'token': SecretStr('secret-token'),
            'network': ('pypi.org',),
        }
        | fields
    )


def test_the_first_turn_runs_print_mode_with_private_settings(tmp_path: Path) -> None:
    invocation = ClaudeCode().invocation(turn(tmp_path, model='opus'))
    files = {file.path.name: json.loads(file.content.get_secret_value()) for file in invocation.files}

    assert invocation.argv[:3] == ('claude', '-p', 'Work on the question.')
    assert invocation.argv[invocation.argv.index('--permission-mode') + 1] == 'dontAsk'
    assert '--strict-mcp-config' in invocation.argv
    assert invocation.argv[-2:] == ('--model', 'opus')
    assert 'secret-token' not in ' '.join(invocation.argv)
    assert all(file.path.parent == tmp_path / 'private' for file in invocation.files)
    server = files['claude-mcp.json']['mcpServers']['verifold']
    assert server == {
        'type': 'http',
        'url': 'http://127.0.0.1:8123/mcp',
        'headers': {'Authorization': 'Bearer secret-token'},
    }
    sandbox = files['claude-settings.json']['sandbox']
    assert sandbox['failIfUnavailable'] is True
    assert sandbox['network']['allowedDomains'] == ['pypi.org']
    assert sandbox['filesystem']['denyRead'] == list(CREDENTIAL_PATHS)
    permissions = files['claude-settings.json']['permissions']
    assert 'mcp__verifold' in permissions['allow']
    assert {'Read(~/.ssh)', 'Read(~/.ssh/**)'} <= set(permissions['deny'])


def test_a_later_turn_resumes_the_session(tmp_path: Path) -> None:
    argv = ClaudeCode('/opt/claude').invocation(turn(tmp_path, session='abc-123')).argv

    assert argv[0] == '/opt/claude'
    assert argv[-2:] == ('--resume', 'abc-123')
    assert '--model' not in argv


def test_the_stream_gives_the_session_the_answer_and_the_usage() -> None:
    harness = ClaudeCode()
    lines = [
        b'{"type": "system", "subtype": "init", "session_id": "s-1", "tools": []}',
        b'not json',
        b'{"type": "assistant", "message": {"content": []}}',
        json.dumps(
            {
                'type': 'result',
                'subtype': 'success',
                'is_error': False,
                'result': 'Posted the plan.',
                'session_id': 's-1',
                'total_cost_usd': 0.42,
                'usage': {
                    'input_tokens': 10,
                    'output_tokens': 50,
                    'cache_read_input_tokens': 1_000,
                    'cache_creation_input_tokens': 200,
                },
            }
        ).encode(),
    ]
    report = TurnReport()
    for line in lines:
        report = harness.read(report, line)

    assert (report.session, report.final_text, report.cost_usd, report.error) == ('s-1', 'Posted the plan.', 0.42, None)
    assert (report.usage.input_tokens, report.usage.cached_input_tokens, report.usage.output_tokens) == (
        1_210,
        1_000,
        50,
    )


def test_an_error_result_is_reported() -> None:
    line = b'{"type": "result", "subtype": "error_max_turns", "is_error": true, "session_id": "s-1"}'

    assert ClaudeCode().read(TurnReport(), line).error == 'error_max_turns'
