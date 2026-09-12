import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  changeWorkspace,
  loadWorkspace,
  readJson,
} from '../src/cli/storage.ts';
import { runResearch } from '../src/cli/research.ts';
import type { HarnessRequest, HarnessResult } from '../src/cli/harness.ts';
import { runCli } from '../src/cli/commands.ts';
import { object, sourceUrl } from '../src/cli/research-contracts.ts';

const plan = {
  scope: 'Study proof search under fixed compute.',
  personas: [
    { name: 'Historian', task: 'Find prior art.' },
    { name: 'Skeptic', task: 'Find counterexamples.' },
  ],
};
const report = {
  summary: 'Two sources suggest a bounded comparison.',
  delegation: 'Native subagents are unavailable in this fixture.',
  sources: [
    { title: 'Paper A', url: 'https://arxiv.org/abs/2401.00001' },
    { title: 'Paper B', url: 'https://arxiv.org/abs/2401.00002' },
  ],
  candidates: [
    {
      id: 'proof',
      title: 'Compare proof search',
      recommendation:
        'A small reproducible comparison. Novelty remains uncertain.',
      gates: ['A proof kernel accepts each proof.'],
      sources: ['https://arxiv.org/abs/2401.00001'],
    },
  ],
};
const io = {
  interactive: false,
  ask: (): Promise<string> => Promise.reject(new Error('Unexpected prompt')),
  out: (): void => {},
};
const signal = (): AbortSignal => new AbortController().signal;

await test('source links preserve academic HTTP references but reject executable schemes and credentials', () => {
  assert.equal(
    sourceUrl('http://example.edu/paper'),
    'http://example.edu/paper',
  );
  assert.equal(
    sourceUrl('https://example.edu/paper'),
    'https://example.edu/paper',
  );
  assert.throws(() => sourceUrl('javascript:alert(1)'), /HTTP or HTTPS/);
  assert.throws(
    () => sourceUrl('https://user:secret@example.edu/paper'),
    /credentials/,
  );
});

await test('oversized research cannot make the saved workspace unreadable', async () => {
  const root = await project();
  try {
    await assert.rejects(
      changeWorkspace(root, (current) => {
        assert.ok(current);
        return {
          ...current,
          candidates: Array.from({ length: 20 }, (_, index) => ({
            id: `idea-${index}`,
            title: 'Idea',
            recommendation: 'Review this idea.',
            gates: Array.from({ length: 20 }, () => 'x'.repeat(4000)),
          })),
        };
      }),
      /1 MB storage limit/,
    );
    assert.deepEqual((await loadWorkspace(root)).candidates, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'verifold-research-'));
  await changeWorkspace(root, () => ({
    schemaVersion: 1,
    visibility: 'private',
    profile: {
      name: 'Ada',
      interests: ['Math'],
      scholar: '',
      github: '',
      session: '',
    },
    host: 'claude',
    candidates: [],
    selectedId: null,
  }));
  return root;
}

async function savedAttempt(
  root: string,
  id: string,
): Promise<Record<string, unknown>> {
  return object(
    await readJson(join(root, '.verifold', 'runs', id, 'attempt.json')),
  );
}

await test('attempt identity precedes the harness call and survives successful acceptance', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  let id = '';
  let started: Record<string, unknown> = {};
  const workspace = await runResearch(
    root,
    { topic: 'Math' },
    io,
    signal(),
    async () => {
      [id = ''] = await readdir(join(root, '.verifold', 'runs'));
      started = await savedAttempt(root, id);
      assert.deepEqual(started, {
        schemaVersion: 1,
        attemptId: id,
        host: 'claude',
        model: null,
        phase: 'needs-plan',
        requestedSessionId: null,
        nativeSessionId: null,
        startedAt: started.startedAt,
        finishedAt: null,
        status: 'started',
      });
      return { text: JSON.stringify(plan), sessionId: 'native-session' };
    },
  );
  const finished = await savedAttempt(root, id);
  assert.equal(workspace.research?.latestAttempt, id);
  assert.equal(workspace.research.phase, 'awaiting-plan-review');
  assert.ok(
    typeof finished.startedAt === 'string' &&
      Number.isFinite(Date.parse(finished.startedAt)),
  );
  assert.ok(
    typeof finished.finishedAt === 'string' &&
      Date.parse(finished.finishedAt) >= Date.parse(String(finished.startedAt)),
  );
  assert.deepEqual(finished, {
    ...started,
    status: 'succeeded',
    nativeSessionId: 'native-session',
    finishedAt: finished.finishedAt,
  });
  assert.equal(
    (await stat(join(root, '.verifold', 'runs', id, 'attempt.json'))).mode &
      0o777,
    0o600,
  );
});

await test(
  'a killed research owner leaves an unfinished record without inventing an outcome',
  { timeout: 10000 },
  async (t) => {
    const root = await project();
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '-e',
        `
    import { runResearch } from ${JSON.stringify(new URL('../src/cli/research.ts', import.meta.url).href)};
    await runResearch(${JSON.stringify(root)}, { topic: 'Math' },
      { interactive: false, ask: async () => '', out: () => {} },
      new AbortController().signal, async () => {
        process.stdout.write('ready');
        await new Promise(() => setInterval(() => {}, 1000));
      });
  `,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const closed = once(child, 'close');
    t.after(async () => {
      child.kill('SIGKILL');
      await closed;
      await rm(root, { recursive: true, force: true });
    });
    await Promise.race([
      once(child.stdout, 'data', { signal: t.signal }),
      closed.then(() => {
        throw new Error('Research fixture exited before readiness.');
      }),
    ]);
    child.kill('SIGKILL');
    await closed;
    const [id = ''] = await readdir(join(root, '.verifold', 'runs'));
    const record = await savedAttempt(root, id);
    assert.equal(record.status, 'started');
    assert.equal(record.finishedAt, null);
    assert.ok(
      (await readdir(join(root, '.verifold'))).includes('research.lock'),
    );
    assert.equal((await loadWorkspace(root)).research?.phase, 'needs-plan');
  },
);

await test('a display error cannot mark accepted research as failed', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  await assert.rejects(
    runResearch(
      root,
      { topic: 'Math', autonomy: 'autonomous' },
      {
        ...io,
        progress: (message) => {
          if (message.includes(report.summary))
            throw new Error('Display unavailable');
        },
      },
      signal(),
      () =>
        Promise.resolve({
          text: JSON.stringify(++calls === 1 ? plan : report),
        }),
    ),
    /Display unavailable/,
  );
  const workspace = await loadWorkspace(root);
  assert.equal(workspace.research?.phase, 'directions');
  const id = workspace.research.latestAttempt ?? '';
  assert.equal((await savedAttempt(root, id)).status, 'succeeded');
  assert.ok(
    !(await readdir(join(root, '.verifold', 'runs', id))).includes(
      'failure.txt',
    ),
  );
});

await test('guided exploration saves checkpoints, resumes host, and needs no PDFs', async () => {
  const root = await project();
  const calls: HarnessRequest[] = [];
  const host = (request: HarnessRequest): Promise<HarnessResult> => {
    calls.push(request);
    return Promise.resolve({
      text: JSON.stringify(calls.length === 1 ? plan : report),
      sessionId: 'coordinator-1',
    });
  };
  try {
    const first = await runResearch(
      root,
      { topic: 'Proof search' },
      io,
      signal(),
      host,
    );
    assert.equal(first.research?.phase, 'awaiting-plan-review');
    assert.equal(calls.length, 1);
    const result = await runResearch(
      root,
      { approve: true },
      io,
      signal(),
      host,
    );
    assert.equal(calls[1]?.sessionId, 'coordinator-1');
    assert.match(calls[1]?.prompt ?? '', /Do not download PDFs/);
    assert.equal(result.research?.phase, 'directions');
    assert.deepEqual(
      result.candidates[0]?.sources,
      report.candidates[0]?.sources,
    );
    assert.equal(result.selectedId, null);
    assert.ok(!(await readdir(join(root, '.verifold'))).includes('papers'));
    await runResearch(root, {}, io, signal(), host);
    assert.equal(
      calls.length,
      2,
      'A completed phase must not repeat without feedback.',
    );
    await runResearch(
      root,
      { feedback: 'Focus on deterministic baselines.' },
      io,
      signal(),
      host,
    );
    assert.match(calls[2]?.prompt ?? '', /Focus on deterministic baselines/);
    assert.equal((await readdir(join(root, '.verifold', 'runs'))).length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('plan feedback requires a new guided approval', async () => {
  const root = await project();
  let count = 0;
  const host = (): Promise<HarnessResult> => {
    count++;
    return Promise.resolve({ text: JSON.stringify(plan) });
  };
  try {
    await runResearch(root, { topic: 'Math' }, io, signal(), host);
    await assert.rejects(
      runResearch(
        root,
        { feedback: 'Revise', approve: true },
        io,
        signal(),
        host,
      ),
      /separately/,
    );
    const revised = await runResearch(
      root,
      { feedback: 'Add a prior-art constraint' },
      io,
      signal(),
      host,
    );
    assert.equal(revised.research?.phase, 'awaiting-plan-review');
    assert.equal(count, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('invalid report preserves checkpoint and session without replacing ideas', async () => {
  const root = await project();
  let count = 0;
  const host = (): Promise<HarnessResult> => {
    count++;
    return Promise.resolve({
      text: JSON.stringify(count === 1 ? plan : { ...report, sources: [] }),
      sessionId: 'saved-session',
    });
  };
  try {
    await assert.rejects(
      runResearch(
        root,
        { topic: 'Math', autonomy: 'autonomous' },
        io,
        signal(),
        host,
      ),
      /web sources/,
    );
    const state = await loadWorkspace(root);
    assert.equal(state.research?.phase, 'needs-research');
    assert.equal(state.research.sessionId, 'saved-session');
    assert.deepEqual(state.candidates, []);
    assert.equal(
      (await savedAttempt(root, state.research.latestAttempt ?? '')).status,
      'failed',
    );
    assert.match(
      await readFile(
        join(
          root,
          '.verifold',
          'runs',
          state.research.latestAttempt ?? '',
          'failure.txt',
        ),
        'utf8',
      ),
      /web sources/,
    );
    assert.ok(
      !(await readdir(join(root, '.verifold'))).includes('research.lock'),
    );
    const result = await runResearch(root, {}, io, signal(), () =>
      Promise.resolve({ text: JSON.stringify(report) }),
    );
    assert.equal(result.research?.phase, 'directions');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('an invalid plan retains the response and records the failed attempt', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    runResearch(root, { topic: 'Math' }, io, signal(), () =>
      Promise.resolve({ text: JSON.stringify({ ...plan, personas: [] }) }),
    ),
    /personas/,
  );
  const state = await loadWorkspace(root);
  assert.equal(state.research?.phase, 'needs-plan');
  const directory = join(
    root,
    '.verifold',
    'runs',
    state.research?.latestAttempt ?? '',
  );
  assert.match(
    await readFile(join(directory, 'response.json'), 'utf8'),
    /personas/,
  );
  assert.match(
    await readFile(join(directory, 'failure.txt'), 'utf8'),
    /personas/,
  );
  assert.ok(
    !(await readdir(join(root, '.verifold'))).includes('research.lock'),
  );
});

await test('research cancellation retains the brief and releases its lock', async () => {
  const root = await project();
  const controller = new AbortController();
  try {
    await assert.rejects(
      runResearch(root, { topic: 'Math' }, io, controller.signal, () => {
        controller.abort();
        return Promise.reject(new Error('Cancelled host'));
      }),
      /Cancelled host/,
    );
    const attempts = await readdir(join(root, '.verifold', 'runs'));
    assert.equal(attempts.length, 1);
    assert.equal(
      (await savedAttempt(root, attempts[0] ?? '')).status,
      'cancelled',
    );
    assert.match(
      await readFile(
        join(root, '.verifold', 'runs', attempts[0] ?? '', 'brief.md'),
        'utf8',
      ),
      /Math/,
    );
    assert.ok(
      !(await readdir(join(root, '.verifold'))).includes('research.lock'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('selected ideas cannot be replaced by research', async () => {
  const root = await project();
  try {
    await changeWorkspace(root, (current) => {
      assert.ok(current);
      return { ...current, candidates: report.candidates, selectedId: 'proof' };
    });
    await assert.rejects(
      runResearch(root, { topic: 'Math' }, io, signal(), () =>
        Promise.reject(new Error('Must not launch')),
      ),
      /already selected/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('a concurrent idea import is not overwritten by research', async () => {
  const root = await project();
  let count = 0;
  try {
    await assert.rejects(
      runResearch(
        root,
        { topic: 'Math', autonomy: 'autonomous' },
        io,
        signal(),
        async () => {
          count++;
          if (count === 1) return { text: JSON.stringify(plan) };
          await changeWorkspace(root, (current) => {
            assert.ok(current);
            return {
              ...current,
              candidates: [
                {
                  ...report.candidates[0],
                  id: 'imported',
                  title: 'Imported idea',
                  recommendation: 'Keep this user import.',
                  gates: ['Check proof.'],
                },
              ],
            };
          });
          return { text: JSON.stringify(report) };
        },
      ),
      /idea list changed/,
    );
    assert.equal((await loadWorkspace(root)).candidates[0]?.id, 'imported');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('selection rejects an idea revised after it was displayed', async () => {
  const root = await project();
  try {
    await changeWorkspace(root, (current) => {
      assert.ok(current);
      return { ...current, candidates: report.candidates };
    });
    await assert.rejects(
      runCli(['select'], root, {
        ...io,
        interactive: true,
        ask: async () => {
          await changeWorkspace(root, (current) => {
            assert.ok(current);
            return {
              ...current,
              candidates: current.candidates.map((idea) => ({
                ...idea,
                recommendation: 'A changed proposal.',
              })),
            };
          });
          return 'proof';
        },
      }),
      /ideas changed/,
    );
    assert.equal((await loadWorkspace(root)).selectedId, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
