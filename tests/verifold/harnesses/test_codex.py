from pathlib import Path

from pydantic import SecretStr

from verifold.harnesses.base import Turn, TurnReport
from verifold.harnesses.codex import TOKEN_VARIABLE, Codex


def turn(tmp_path: Path, **fields: str | tuple[str, ...] | None) -> Turn:
    return Turn.model_validate(
        {
            'prompt': 'Work on the question.',
            'folder': tmp_path,
            'private': tmp_path / 'private',
            'mcp_url': 'http://127.0.0.1:8123/mcp',
            'token': SecretStr('secret-token'),
        }
        | fields
    )


def test_config_options_come_before_exec_and_the_token_stays_in_the_environment(tmp_path: Path) -> None:
    invocation = Codex().invocation(turn(tmp_path, model='gpt-6-sol'))
    argv = invocation.argv
    exec_at = argv.index('exec')
    options = [argv[index + 1] for index in range(exec_at) if argv[index] == '-c']

    assert argv[exec_at:] == ('exec', '--json', 'Work on the question.')
    assert 'approval_policy="never"' in options
    assert 'sandbox_workspace_write.network_access=false' in options
    assert 'mcp_servers.verifold.url="http://127.0.0.1:8123/mcp"' in options
    assert f'mcp_servers.verifold.bearer_token_env_var="{TOKEN_VARIABLE}"' in options
    assert 'model="gpt-6-sol"' in options
    assert 'secret-token' not in ' '.join(argv)
    assert [(name, value.get_secret_value()) for name, value in invocation.env] == [(TOKEN_VARIABLE, 'secret-token')]


def test_network_domains_turn_on_the_sandbox_network_and_a_later_turn_resumes(tmp_path: Path) -> None:
    argv = Codex().invocation(turn(tmp_path, network=('pypi.org',), session='thread-9')).argv

    assert 'sandbox_workspace_write.network_access=true' in argv
    assert argv[-3:] == ('resume', 'thread-9', 'Work on the question.')


def test_the_stream_gives_the_thread_the_answer_and_the_summed_usage() -> None:
    harness = Codex()
    lines = [
        b'{"type": "thread.started", "thread_id": "thread-9"}',
        b'{"type": "item.completed", "item": {"type": "command_execution", "command": "ls"}}',
        b'{"type": "item.completed", "item": {"type": "agent_message", "text": "Posted the result."}}',
        b'{"type": "turn.completed", "usage": {"input_tokens": 900, "cached_input_tokens": 700, "output_tokens": 40}}',
        b'{"type": "turn.completed", "usage": {"input_tokens": 100, "cached_input_tokens": 0, "output_tokens": 10}}',
        b'garbage',
    ]
    report = TurnReport()
    for line in lines:
        report = harness.read(report, line)

    assert (report.session, report.final_text, report.error) == ('thread-9', 'Posted the result.', None)
    assert (report.usage.input_tokens, report.usage.cached_input_tokens, report.usage.output_tokens) == (1_000, 700, 50)


def test_failures_are_reported() -> None:
    failed = b'{"type": "turn.failed", "error": {"message": "Usage limit reached."}}'
    stream_error = b'{"type": "error", "message": "Reconnecting."}'

    assert Codex().read(TurnReport(), failed).error == 'Usage limit reached.'
    assert Codex().read(TurnReport(), stream_error).error == 'Reconnecting.'
