import { object } from '../src/cli/research-contracts.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli, type CliIO } from '../src/cli/commands.ts';
import { ensureGlobalProfile } from '../src/cli/profile.ts';
import { saveAgencyFile } from '../src/cli/agency.ts';
import type { runHarness } from '../src/cli/harness.ts';

function parseObject(value: string): Record<string, unknown> {
  return object(JSON.parse(value));
}

const signal = (): AbortSignal => new AbortController().signal;
const noHost: typeof runHarness = () =>
  assert.fail('Unexpected model invocation');
function io(answers?: string[], output: string[] = []): CliIO {
  return {
    interactive: answers !== undefined,
    ask: () => {
      const answer = answers?.shift();
      assert.notEqual(answer, undefined, 'Unexpected profile prompt');
      return Promise.resolve(answer ?? '');
    },
    out: (text) => {
      output.push(text);
    },
  };
}
async function temporary(
  run: (root: string, agency: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'verifold-profile-cli-'));
  try {
    await run(root, join(root, 'agency'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await test('profile inspection needs no workspace and creates no files or model calls', async () => {
  await temporary(async (root, agency) => {
    const output: string[] = [];
    await runCli(
      ['profile', '--agency-dir', agency],
      root,
      io(undefined, output),
      signal(),
      noHost,
    );
    assert.deepEqual(parseObject(output[0] ?? ''), {
      path: join(agency, 'USER.md'),
      status: 'not-offered',
      lastSetup: null,
      agency: null,
      markdown: null,
    });
    assert.deepEqual(await readdir(root), []);
  });
});

await test('explicit profile setup saves reviewed global context without initializing a workspace', async () => {
  await temporary(async (root, agency) => {
    await runCli(
      ['profile', '--setup', '--agency-dir', agency, '--host', 'codex'],
      root,
      io(['write', 'I prefer reproducible CPU experiments.', 'yes']),
      signal(),
      noHost,
    );
    assert.equal(
      await readFile(join(agency, 'USER.md'), 'utf8'),
      'I prefer reproducible CPU experiments.',
    );
    assert.deepEqual(await readdir(root), ['agency']);
    const output: string[] = [];
    await runCli(
      ['profile', '--agency-dir', agency],
      root,
      io(undefined, output),
      signal(),
      noHost,
    );
    assert.equal(parseObject(output[0] ?? '').status, 'accepted');
  });
});

for (const outcome of ['rejected', 'failed'] as const) {
  await test(`profile refresh ${outcome} preserves approved memory`, async () => {
    await temporary(async (root, agency) => {
      await saveAgencyFile(
        agency,
        'settings.json',
        JSON.stringify({ host: 'codex' }),
      );
      await saveAgencyFile(agency, 'USER.md', 'Previously approved context.');
      const answers =
        outcome === 'rejected'
          ? ['write', 'Replacement context.', 'no']
          : ['import', 'missing.txt', 'yes'];
      await runCli(
        ['profile', '--setup', '--agency-dir', agency],
        root,
        io(answers),
        signal(),
        noHost,
      );
      const output: string[] = [];
      await runCli(
        ['profile', '--agency-dir', agency],
        root,
        io(undefined, output),
        signal(),
        noHost,
      );
      const result = parseObject(output[0] ?? '');
      assert.equal(result.markdown, 'Previously approved context.');
      assert.equal(result.status, 'accepted');
      assert.equal(
        result.lastSetup,
        outcome === 'rejected' ? 'skipped' : 'failed',
      );
    });
  });
}

await test('noninteractive profile setup rejects before any file creation', async () => {
  await temporary(async (root, agency) => {
    await assert.rejects(
      runCli(
        ['profile', '--setup', '--host', 'codex', '--agency-dir', agency],
        root,
        io(),
        signal(),
        noHost,
      ),
      /interactive terminal/,
    );
    assert.deepEqual(await readdir(root), []);
  });
});

await test('skipped global setup is reused by existing-project launch and a new init', async () => {
  await temporary(async (root, agency) => {
    await runCli(
      ['profile', '--setup', '--host', 'codex', '--agency-dir', agency],
      root,
      io(['skip']),
      signal(),
      noHost,
    );
    await ensureGlobalProfile(
      agency,
      root,
      { host: 'claude' },
      io([]),
      signal(),
      noHost,
    );
    await runCli(
      [
        'init',
        '--setup-only',
        '--host',
        'codex',
        '--model',
        'default',
        '--agency-dir',
        agency,
      ],
      root,
      io([]),
      signal(),
      noHost,
    );
    assert.equal(
      parseObject(await readFile(join(agency, 'profile-state.json'), 'utf8'))
        .status,
      'skipped',
    );
    assert.equal(
      parseObject(
        await readFile(join(root, '.verifold', 'workspace.json'), 'utf8'),
      ).host,
      'codex',
    );
  });
});

await test('legacy approved USER.md is reused without history import or lifecycle migration', async () => {
  await temporary(async (root, agency) => {
    await saveAgencyFile(agency, 'USER.md', 'Existing research preferences.');
    await ensureGlobalProfile(
      agency,
      root,
      { host: 'claude' },
      io([]),
      signal(),
      noHost,
    );
    assert.equal(
      await readFile(join(agency, 'USER.md'), 'utf8'),
      'Existing research preferences.',
    );
    await assert.rejects(readFile(join(agency, 'profile-state.json')), {
      code: 'ENOENT',
    });
    const output: string[] = [];
    await runCli(
      ['profile', '--agency-dir', agency],
      root,
      io(undefined, output),
      signal(),
      noHost,
    );
    assert.equal(parseObject(output[0] ?? '').status, 'accepted');
  });
});

await test('malformed setup state blocks inspection and automatic setup without overwriting it', async () => {
  await temporary(async (root, agency) => {
    await saveAgencyFile(
      agency,
      'settings.json',
      JSON.stringify({ host: 'codex' }),
    );
    const malformed = '{"schemaVersion":1,"status":"invented"}';
    await writeFile(join(agency, 'profile-state.json'), malformed);
    await assert.rejects(
      runCli(['profile', '--agency-dir', agency], root, io(), signal(), noHost),
      /Invalid profile setup state/,
    );
    await assert.rejects(
      ensureGlobalProfile(
        agency,
        root,
        { host: 'claude' },
        io([]),
        signal(),
        noHost,
      ),
      /Invalid profile setup state/,
    );
    assert.equal(
      await readFile(join(agency, 'profile-state.json'), 'utf8'),
      malformed,
    );
  });
});

await test('linked global profile directories are rejected without changing the target', async () => {
  await temporary(async (root, agency) => {
    await saveAgencyFile(agency, 'USER.md', 'Keep this context.');
    const linked = join(root, 'linked-agency');
    await symlink(agency, linked);
    await assert.rejects(
      runCli(
        ['profile', '--setup', '--host', 'codex', '--agency-dir', linked],
        root,
        io([]),
        signal(),
        noHost,
      ),
      /symbolic link/,
    );
    assert.equal(
      await readFile(join(agency, 'USER.md'), 'utf8'),
      'Keep this context.',
    );
    await assert.rejects(readFile(join(agency, 'settings.json')), {
      code: 'ENOENT',
    });
  });
});

await test('a competing profile setup cannot replace the active owner harness', async () => {
  await temporary(async (root, agency) => {
    let entered: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: (answer: string) => void = () => {};
    const answer = new Promise<string>((resolve) => {
      release = resolve;
    });
    const first = runCli(
      ['profile', '--setup', '--host', 'codex', '--agency-dir', agency],
      root,
      {
        interactive: true,
        out: () => {},
        ask: () => {
          entered();
          return answer;
        },
      },
      signal(),
      noHost,
    );
    try {
      await waiting;
      await assert.rejects(
        runCli(
          ['profile', '--setup', '--host', 'claude', '--agency-dir', agency],
          root,
          io([]),
          signal(),
          noHost,
        ),
        /locked/,
      );
      assert.equal(
        parseObject(await readFile(join(agency, 'settings.json'), 'utf8')).host,
        'codex',
      );
    } finally {
      release('skip');
      await first;
    }
  });
});

await test('deleted approved memory is reported missing without automatic import or setup', async () => {
  await temporary(async (root, agency) => {
    await runCli(
      ['profile', '--setup', '--host', 'codex', '--agency-dir', agency],
      root,
      io(['write', 'Approved context to remove.', 'yes']),
      signal(),
      noHost,
    );
    await rm(join(agency, 'USER.md'));
    const settings = await readFile(join(agency, 'settings.json'), 'utf8');
    const source = join(root, 'source.txt');
    await writeFile(source, 'Private source must stay unchanged.');
    const output: string[] = [];
    await runCli(
      ['profile', '--agency-dir', agency],
      root,
      io(undefined, output),
      signal(),
      noHost,
    );
    assert.equal(parseObject(output[0] ?? '').status, 'missing');
    assert.equal(parseObject(output[0] ?? '').markdown, null);
    await ensureGlobalProfile(
      agency,
      root,
      { host: 'claude' },
      io([]),
      signal(),
      noHost,
    );
    await assert.rejects(readFile(join(agency, 'USER.md')), { code: 'ENOENT' });
    assert.equal(
      await readFile(join(agency, 'settings.json'), 'utf8'),
      settings,
    );
    assert.equal(
      await readFile(source, 'utf8'),
      'Private source must stay unchanged.',
    );
  });
});

await test('cancelling the profile interview preserves the previous setup outcome', async () => {
  await temporary(async (root, agency) => {
    await saveAgencyFile(
      agency,
      'settings.json',
      JSON.stringify({ host: 'codex' }),
    );
    await saveAgencyFile(
      agency,
      'profile-state.json',
      JSON.stringify({ schemaVersion: 1, status: 'skipped' }),
    );
    await assert.rejects(
      runCli(
        ['profile', '--setup', '--agency-dir', agency],
        root,
        io(['chat', 'Graphs', 'yes', '/cancel']),
        signal(),
        () => Promise.resolve({ text: 'Why does this question matter?' }),
      ),
      { name: 'AbortError' },
    );
    assert.equal(
      object(
        JSON.parse(await readFile(join(agency, 'profile-state.json'), 'utf8')),
      ).status,
      'skipped',
    );
    await assert.rejects(readFile(join(agency, 'USER.md')), { code: 'ENOENT' });
    assert.ok(!(await readdir(agency)).includes('profile.lock'));
  });
});
