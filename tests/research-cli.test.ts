import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeWorkspace, loadWorkspace } from '../src/cli/storage.ts';
import { runResearch } from '../src/cli/research.ts';
import type { HarnessRequest, HarnessResult } from '../src/cli/harness.ts';
import { runCli } from '../src/cli/commands.ts';

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
