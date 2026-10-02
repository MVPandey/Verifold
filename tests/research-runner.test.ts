import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { changeWorkspace, loadWorkspace } from '../src/cli/storage.ts';
import { ResearchRunner } from '../src/cli/research-runner.ts';
import type { HarnessRequest, HarnessResult } from '../src/cli/harness.ts';
import { SessionManager } from '../src/cli/session.ts';
import { terminalInput } from '../src/cli/commands.ts';
import { startDesk } from '../src/cli/desk.ts';

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
      recommendation: 'A small reproducible comparison.',
      gates: ['A proof kernel accepts each proof.'],
      sources: ['https://arxiv.org/abs/2401.00001'],
    },
  ],
};

/** Plans first, then reports. Each call reports one observed tool event. */
function harness(request: HarnessRequest): Promise<HarnessResult> {
  request.onActivity?.('Claude Code requested WebSearch.');
  return Promise.resolve({
    text: JSON.stringify(
      request.prompt.includes('Approved plan:') ? report : plan,
    ),
    sessionId: 'native-1',
  });
}

let slowCalls = 0;

/** Waits until the step is cancelled. */
function slow(request: HarnessRequest): Promise<HarnessResult> {
  slowCalls++;
  request.onActivity?.('Claude Code requested WebSearch.');
  return new Promise((_resolve, reject) => {
    request.signal.addEventListener(
      'abort',
      () => reject(new DOMException('Cancelled.', 'AbortError')),
      { once: true },
    );
  });
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'verifold-research-runner-'));
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
  return root;
}

function setup(
  root: string,
  options: {
    readonly harness?: typeof harness;
    readonly busy?: () => string | null;
  } = {},
): { runner: ResearchRunner; lines: string[]; running: boolean[] } {
  const lines: string[] = [];
  const running: boolean[] = [];
  const runner = new ResearchRunner(root, {
    signal: new AbortController().signal,
    io: {
      interactive: true,
      ask: () => Promise.reject(new Error('No prompts')),
      out: () => {},
      progress: (line) => lines.push(line),
    },
    harness: options.harness ?? harness,
    busy: options.busy ?? (() => null),
    onRunning: (value) => running.push(value),
  });
  return { runner, lines, running };
}

await test('research runs in the owner, records observed activity, and waits for decisions', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runner, lines, running } = setup(root);
  await assert.rejects(runner.start({}), /Write the question/);
  await assert.rejects(runner.start({ approve: true }), /No plan waits/);
  await runner.start({ topic: 'Proof search', autonomy: 'guided' });
  await assert.rejects(runner.start({ topic: 'Again' }), /already running/);
  await runner.settled();
  const planned = runner.view();
  assert.equal(planned.running, false);
  assert.equal(planned.step, 'Planning research roles and scope');
  assert.deepEqual(
    planned.events.map((event) => event.kind),
    ['status', 'tool', 'status'],
  );
  assert.match(planned.events.at(-1)?.text ?? '', /plan is ready/);
  assert.deepEqual(running, [true, false]);
  assert.ok(lines.some((line) => line.includes('/approve')));
  assert.equal(
    (await loadWorkspace(root)).research?.phase,
    'awaiting-plan-review',
  );

  await assert.rejects(runner.start({ feedback: ' ' }), /between 1 and 4000/);
  await runner.start({ approve: true });
  assert.equal(
    runner.view().step,
    'Searching sources and comparing directions',
  );
  await runner.settled();
  assert.match(runner.view().events.at(-1)?.text ?? '', /directions are ready/);
  await assert.rejects(runner.select('missing'), /Choose an ID/);
  await runner.select('proof');
  assert.equal((await loadWorkspace(root)).selectedId, 'proof');
  await assert.rejects(
    runner.start({ feedback: 'More sources' }),
    /direction is chosen/,
  );
});

await test('a busy owner refuses research, and a cancel keeps the attempt evidence', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  let busy: string | null = 'A harness session is running.';
  const { runner } = setup(root, { harness: slow, busy: () => busy });
  await assert.rejects(
    runner.start({ topic: 'Proof search' }),
    /session is running/,
  );
  busy = null;
  const calls = slowCalls;
  await runner.start({ topic: 'Proof search' });
  await assert.rejects(runner.select('proof'), /Wait for research/);
  // Cancel after the harness starts, so the attempt has a record.
  for (let tries = 0; tries < 100 && slowCalls === calls; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  runner.cancel();
  await runner.settled();
  assert.match(runner.view().events.at(-1)?.text ?? '', /was cancelled/);
  assert.throws(() => runner.cancel(), /No research step/);
  const attempt = (await loadWorkspace(root)).research?.latestAttempt ?? '';
  const record = JSON.parse(
    await readFile(
      join(root, '.verifold', 'runs', attempt, 'attempt.json'),
      'utf8',
    ),
  ) as { status: string };
  assert.equal(record.status, 'cancelled');
});

await test('terminal commands and desk actions call the same research operations', async (t) => {
  const root = await project();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { runner } = setup(root, { harness: slow });
  const sessions = new SessionManager(root, {
    clientVersion: 'test',
    ownerId: 'test-owner',
  });
  const messages: string[] = [];
  const io = {
    interactive: true,
    ask: () => Promise.reject(new Error('No prompts')),
    out: () => {},
    progress: (value: string) => messages.push(value),
  };
  const controls = { host: 'claude', open: () => {}, research: runner };
  const calls = slowCalls;
  terminalInput(sessions, '/research Proof search', io, controls);
  // Cancel only after the harness runs. An early cancel would leave the fake harness waiting.
  for (let tries = 0; tries < 200 && slowCalls === calls; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runner.running, true);
  terminalInput(sessions, '/cancel', io, controls);
  await runner.settled();
  assert.match(runner.view().events.at(-1)?.text ?? '', /was cancelled/);

  const assets = join(root, 'assets');
  await mkdir(join(assets, 'cli', 'vendor'), { recursive: true });
  await mkdir(join(assets, 'ui'));
  for (const name of [
    'desk.css',
    'desk-client.js',
    'manrope.ttf',
    'symbol.webp',
  ])
    await writeFile(join(assets, 'cli', name), 'fixture asset');
  await writeFile(join(assets, 'cli', 'vendor', 'purify.js'), 'fixture');
  await writeFile(join(assets, 'ui', 'dom.js'), 'fixture module');
  const owner = new AbortController();
  const deskResearch = setup(root).runner;
  const desk = await startDesk(
    root,
    owner.signal,
    pathToFileURL(`${assets}/cli/`),
    sessions,
    deskResearch,
  );
  t.after(async () => {
    owner.abort();
    await desk.closed;
  });
  const url = new URL(desk.url);
  const post = async (body: unknown): Promise<[number, unknown]> => {
    const response = await fetch(`${url.origin}/api/action`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${url.hash.slice(1)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return [response.status, await response.json()];
  };
  const view = async (): Promise<string> =>
    (
      (await (
        await fetch(`${url.origin}/api/view`, {
          headers: { Authorization: `Bearer ${url.hash.slice(1)}` },
        })
      ).json()) as { html: string }
    ).html;
  assert.deepEqual(await post({ action: 'cancel-research' }), [
    409,
    { error: 'No research step is running.' },
  ]);
  assert.match(await view(), /Continue research/);
  assert.equal((await post({ action: 'research' }))[0], 200);
  await deskResearch.settled();
  const html = await view();
  assert.match(html, /Review the plan/);
  assert.match(html, /data-research="approve"/);
  assert.match(html, /Verifold saw/);
  assert.equal((await post({ action: 'research', approve: true }))[0], 200);
  await deskResearch.settled();
  assert.match(await view(), /data-action="select" data-idea="proof"/);
  assert.equal((await post({ action: 'select', idea: 'proof' }))[0], 200);
  assert.equal((await loadWorkspace(root)).selectedId, 'proof');
});
