import json
import sys
from pathlib import Path
from typing import override

from pydantic import SecretStr

from verifold.harnesses.base import ConfigFile, Harness, Invocation, Turn, TurnReport


class Scripted(Harness):
    """A harness that runs a Python script and keeps each output line as the final text."""

    name = 'scripted'
    family = 'test'

    def __init__(self, script: str) -> None:
        self._script = script

    @override
    def invocation(self, turn: Turn) -> Invocation:
        return Invocation(
            argv=(sys.executable, '-c', self._script),
            env=(('AGENT_SECRET', SecretStr('s3cret')),),
            files=(ConfigFile(path=turn.private / 'config.json', content=SecretStr('{"token": "s3cret"}')),),
        )

    @override
    def read(self, report: TurnReport, line: bytes) -> TurnReport:
        return report.model_copy(update={'final_text': report.final_text + line.decode()})


class Recording(Harness):
    """A harness that logs each turn's prompt and session, reports session `s-1`, and exits with `exit_code`."""

    name = 'recording'
    family = 'test'

    def __init__(self, log: Path, exit_code: int = 0) -> None:
        self.log = log
        self._exit_code = exit_code

    @override
    def invocation(self, turn: Turn) -> Invocation:
        script = (
            'import json, sys; '
            f'open({str(self.log)!r}, "a").write(json.dumps(sys.argv[1:]) + "\\n"); '
            f'print("session:s-1"); sys.exit({self._exit_code})'
        )
        return Invocation(argv=(sys.executable, '-c', script, turn.prompt, turn.session or ''))

    @override
    def read(self, report: TurnReport, line: bytes) -> TurnReport:
        text = line.decode().strip()
        return (
            report.model_copy(update={'session': text.removeprefix('session:')})
            if text.startswith('session:')
            else report
        )

    def turns(self) -> list[list[str]]:
        """Return each turn's prompt and session, in order."""
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
