import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeWorkspace } from '../src/cli/storage.ts';
import { processStart } from '../src/cli/owner.ts';
import {
  reconcileSessions,
  SessionManager,
  type SessionRecord,
} from '../src/cli/session.ts';
import { reconcileAttempts } from '../src/cli/research.ts';
import { readDeskSnapshot } from '../src/cli/desk-records.ts';
import { renderDesk } from '../src/cli/desk-view.ts';
import { runCli } from '../src/cli/commands.ts';
import type { HarnessRequest, HarnessResult } from '../src/cli/harness.ts';

const posix = process.platform !== 'win32';

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'verifold-recovery-'));
  await changeWorkspace(root, () => ({
    schemaVersion: 1,
    visibility: 'private',
    profile: {
      name: 'Researcher',
      interests: ['Proofs'],
      scholar: '',
      github: '',
      session: '',
    },
    host: 'claude',
    candidates: [],
    selectedId: null,
  }));
  await mkdir(join(root, '.verifold', 'sessions'));
  return root;
}

/** A process that runs until it is stopped, in its own process group. */
function orphan(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
}

function alive(pid: number | undefined): boolean {
  try {
    process.kill(pid ?? 0, 0);
    return true;
  } catch {
    return false;
  }
}

function session(
  id: string,
  status: SessionRecord['status'],
  launch: { ownerId: string; pid: number | null; processStart: string | null },
  events: SessionRecord['events'] = [
    { at: '2026-10-02T12:00:00.000Z', kind: 'you', text: 'Check the page' },
  ],
): SessionRecord {
  return {
    schemaVersion: 2,
    id,
    host: 'claude',
    model: null,
    mode: 'auto',
    reportedMode: null,
    nativeSessionId: randomUUID(),
    status,
    startedAt: '2026-10-02T12:00:00.000Z',
    endedAt: null,
    costUsd: null,
    events,
    commands: [
      {
        id: 'tool-1',
        at: '2026-10-02T12:00:01.000Z',
        tool: 'Bash',
        action: 'curl https://example.com',
        risk: ['Network'],
        auto: true,
        outcome: 'running',
      },
    ],
    requests: [],
    launches: [
      {
        id: 'abcd1234',
        startedAt: '2026-10-02T12:00:00.000Z',
        endedAt: null,
        ...launch,
      },
    ],
  };
}

async function save(root: string, record: SessionRecord): Promise<void> {
  await writeFile(
    join(root, '.verifold', 'sessions', `${record.id}.json`),
    JSON.stringify(record),
  );
}

async function load(root: string, id: string): Promise<SessionRecord> {
  return JSON.parse(
    await readFile(join(root, '.verifold', 'sessions', `${id}.json`), 'utf8'),
  ) as SessionRecord;
}

await test('a new owner stops harness processes that outlived the old owner and marks their sessions interrupted', async (t) => {
  const root = await project();
  const survivor = orphan();
  const reused = orphan();
  t.after(async () => {
    for (const child of [survivor, reused])
      if (alive(child.pid)) process.kill(-(child.pid ?? 0), 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  });
  const survivorStart = await processStart(survivor.pid ?? 0);
  await save(
    root,
    session('20261002T120000000Z-aaaaaaaa', 'running', {
      ownerId: 'dead-owner',
      pid: survivor.pid ?? null,
      processStart: survivorStart,
    }),
  );
  // A live PID with another start time is a different process. It must survive.
  await save(
    root,
    session('20261002T120001000Z-bbbbbbbb', 'idle', {
      ownerId: 'dead-owner',
      pid: reused.pid ?? null,
      processStart: 'Thu Jan  1 00:00:00 1970',
    }),
  );
  await save(
    root,
    session('20261002T120002000Z-cccccccc', 'running', {
      ownerId: 'new-owner',
      pid: null,
      processStart: null,
    }),
  );
  await save(
    root,
    session('20261002T120003000Z-dddddddd', 'ended', {
      ownerId: 'dead-owner',
      pid: null,
      processStart: null,
    }),
  );
  const result = await reconcileSessions(root, 'new-owner');
  assert.deepEqual(result, { interrupted: 2, stopped: posix ? 1 : 0 });
  if (posix) assert.equal(alive(survivor.pid), false);
  assert.equal(alive(reused.pid), true);
  const stopped = await load(root, '20261002T120000000Z-aaaaaaaa');
  assert.equal(stopped.status, 'interrupted');
  assert.equal(stopped.commands[0]?.outcome, 'unknown');
  assert.match(stopped.events.at(-1)?.text ?? '', /outcome is unknown/);
  if (posix) assert.match(stopped.events.at(-1)?.text ?? '', /stopped it/);
  assert.equal(
    (await load(root, '20261002T120001000Z-bbbbbbbb')).status,
    'interrupted',
  );
  assert.equal(
    (await load(root, '20261002T120002000Z-cccccccc')).status,
    'running',
  );
  assert.equal(
    (await load(root, '20261002T120003000Z-dddddddd')).status,
    'ended',
  );
  // Without an observed harness event, the Claude Code session starts again instead of resuming.
  const manager = new SessionManager(root, {
    clientVersion: 'test',
    ownerId: 'new-owner',
  });
  await manager.load();
  assert.deepEqual(
    manager.paused().map((entry) => [entry.status, entry.restart]),
    [
      ['interrupted', true],
      ['interrupted', true],
    ],
  );
});

await test('research attempts of a stopped owner become interrupted and stop blocking research', async (t) => {
  const root = await project();
  const survivor = orphan();
  t.after(async () => {
    if (alive(survivor.pid)) process.kill(-(survivor.pid ?? 0), 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  });
  const attempt = async (
    observedAt: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> => {
    const id = randomUUID();
    await mkdir(join(root, '.verifold', 'runs', id), { recursive: true });
    await writeFile(
      join(root, '.verifold', 'runs', id, 'attempt.json'),
      JSON.stringify({
        schemaVersion: 1,
        attemptId: id,
        host: 'claude',
        model: null,
        phase: 'needs-research',
        requestedSessionId: null,
        nativeSessionId: null,
        startedAt: '2026-10-02T12:00:00.000Z',
        status: 'started',
        observedAt,
        finishedAt: null,
        ...extra,
      }),
    );
    return id;
  };
  const stale = await attempt('2026-10-02T12:00:00.000Z', {
    pid: survivor.pid,
    processStart: await processStart(survivor.pid ?? 0),
  });
  const fresh = await attempt(new Date().toISOString());
  const lock = join(root, '.verifold', 'research.lock');
  await writeFile(lock, '');
  // A fresh attempt can belong to an older Verifold that does not take the owner lock.
  assert.deepEqual(await reconcileAttempts(root), {
    interrupted: 1,
    stopped: posix ? 1 : 0,
  });
  assert.ok(existsSync(lock));
  if (posix) assert.equal(alive(survivor.pid), false);
  const record = JSON.parse(
    await readFile(
      join(root, '.verifold', 'runs', stale, 'attempt.json'),
      'utf8',
    ),
  ) as { status: string; finishedAt: unknown; reconciledAt: unknown };
  assert.equal(record.status, 'interrupted');
  assert.equal(record.finishedAt, null);
  assert.equal(typeof record.reconciledAt, 'string');
  const html = renderDesk(
    await readDeskSnapshot(root),
    stale,
    null,
    undefined,
    { view: 'records', panel: 'attempt' },
  ).html;
  assert.match(html, /Interrupted, outcome unknown/);
  assert.match(html, /Continue research to run the step again/);

  // Once no attempt looks live, the stale lock goes, and research runs again.
  await rm(join(root, '.verifold', 'runs', fresh), { recursive: true });
  await changeWorkspace(root, (state) => ({
    ...state!,
    research: {
      topic: 'Proof search',
      autonomy: 'guided',
      phase: 'awaiting-plan-review',
      plan: {
        scope: 'Study proof search.',
        personas: [
          { name: 'Historian', task: 'Find prior art.' },
          { name: 'Skeptic', task: 'Find counterexamples.' },
        ],
      },
    },
  }));
  await attempt('2026-10-02T12:00:00.000Z');
  const progress: string[] = [];
  const harness = (request: HarnessRequest): Promise<HarnessResult> =>
    Promise.resolve({
      text: JSON.stringify({
        summary: 'Two sources.',
        delegation: 'None.',
        sources: [
          { title: 'Paper A', url: 'https://arxiv.org/abs/2401.00001' },
          { title: 'Paper B', url: 'https://arxiv.org/abs/2401.00002' },
        ],
        candidates: [
          {
            id: 'proof',
            title: 'Compare proof search',
            recommendation: 'A small comparison.',
            gates: ['A kernel accepts each proof.'],
            sources: ['https://arxiv.org/abs/2401.00001'],
          },
        ],
      }),
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });
  await runCli(
    ['research', '--approve'],
    root,
    {
      interactive: false,
      ask: () => Promise.reject(new Error('No prompts')),
      out: () => {},
      progress: (value) => progress.push(value),
    },
    new AbortController().signal,
    harness,
  );
  assert.ok(progress.some((line) => line.includes('stopped earlier')));
  assert.equal(existsSync(lock), false);
});
