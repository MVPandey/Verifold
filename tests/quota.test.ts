import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Quota } from '../src/cli/quota.ts';
import {
  claudeLimit,
  claudeLimitResult,
  codexLimit,
} from '../src/cli/session-hosts.ts';
import { SessionManager } from '../src/cli/session.ts';

/** Lines that Claude Code 2.1.303 and Codex 0.160.0 sent in a probe on 2026-10-19. */
const probedClaude = {
  status: 'allowed',
  resetsAt: 1792447800,
  rateLimitType: 'five_hour',
  overageStatus: 'allowed',
  isUsingOverage: false,
  unifiedWindows: {
    five_hour: { utilization: 0.15, resetsAt: 1792447800 },
    seven_day: { utilization: 0.18, resetsAt: 1792630800 },
  },
};
const probedCodex = {
  limitId: 'codex',
  primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1793041645 },
  secondary: null,
  credits: { hasCredits: true, unlimited: false, balance: '62500.0000000000' },
  spendControlReached: null,
  planType: 'pro',
  rateLimitReachedType: null,
};

async function folder(t: test.TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'verifold-quota-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

await test('the harnesses report their usage windows in the probed shapes', () => {
  assert.deepEqual(claudeLimit(probedClaude), {
    exhausted: false,
    resetsAt: '2026-10-19T22:10:00.000Z',
    usedPercent: 15,
    window: 'five_hour',
  });
  assert.equal(
    claudeLimit({ ...probedClaude, status: 'rejected' })?.exhausted,
    true,
  );
  assert.equal(claudeLimit({ resetsAt: 1 }), null);
  // A failed result names the limit. Its reset time can follow a bar.
  assert.deepEqual(
    claudeLimitResult({
      is_error: true,
      result: 'Claude AI usage limit reached|1792447800',
    }),
    {
      exhausted: true,
      resetsAt: '2026-10-19T22:10:00.000Z',
      usedPercent: null,
      window: null,
    },
  );
  assert.equal(
    claudeLimitResult({ is_error: true, result: "You've hit your limit" })
      ?.resetsAt,
    null,
  );
  assert.equal(claudeLimitResult({ is_error: true, result: 'Boom.' }), null);
  assert.equal(
    claudeLimitResult({ is_error: false, result: 'usage limit' }),
    null,
  );
  // Codex: a full window parks an account only when it has no credits.
  assert.deepEqual(codexLimit(probedCodex), {
    exhausted: false,
    resetsAt: '2026-10-26T19:07:25.000Z',
    usedPercent: 0,
    window: '10080 min',
  });
  const full = {
    ...probedCodex,
    primary: { ...probedCodex.primary, usedPercent: 100 },
  };
  assert.equal(codexLimit(full)?.exhausted, false);
  assert.equal(
    codexLimit({ ...full, credits: { hasCredits: false, unlimited: false } })
      ?.exhausted,
    true,
  );
  assert.equal(
    codexLimit({
      ...probedCodex,
      credits: null,
      rateLimitReachedType: 'primary',
    })?.exhausted,
    true,
  );
  assert.equal(codexLimit({ primary: null, secondary: null }), null);
});

await test('a used-up window waits for its reset, or backs off when the reset is unknown, and the record survives a restart', async (t) => {
  const root = await folder(t);
  const quota = new Quota(root);
  const start = Date.parse('2026-10-19T12:00:00.000Z');
  const minutes = (count: number): number => start + count * 60_000;
  const unknown = {
    exhausted: true,
    resetsAt: null,
    usedPercent: null,
    window: null,
  };
  // A known reset: the wait ends 30 s after it.
  quota.record(
    'claude',
    {
      exhausted: true,
      resetsAt: new Date(minutes(60)).toISOString(),
      usedPercent: 100,
      window: 'five_hour',
    },
    start,
  );
  assert.equal(
    quota.parked('claude', start),
    new Date(minutes(60) + 30_000).toISOString(),
  );
  assert.equal(quota.parked('codex', start), null);
  // Another session fails during the wait. The wait stays as it is.
  quota.record('claude', unknown, minutes(5));
  assert.equal(
    quota.parked('claude', minutes(5)),
    new Date(minutes(60) + 30_000).toISOString(),
  );
  // After the wait, the window is still used up and the reset is unknown: 15, 30, 60, then 120 minutes.
  let now = minutes(61);
  for (const wait of [15, 30, 60, 120, 120]) {
    quota.record('claude', unknown, now);
    const until = quota.parked('claude', now);
    assert.equal(until, new Date(now + wait * 60_000).toISOString());
    now += wait * 60_000 + 1000;
  }
  // A turn that worked opens the window and resets the back-off.
  quota.record(
    'claude',
    { exhausted: false, resetsAt: null, usedPercent: 12, window: 'five_hour' },
    now,
  );
  assert.equal(quota.parked('claude', now), null);
  quota.record('claude', unknown, now);
  assert.equal(
    quota.parked('claude', now),
    new Date(now + 15 * 60_000).toISOString(),
  );
  // The file holds the same waits, so a new owner keeps them.
  await quota.settled();
  const later = new Quota(root);
  await later.load();
  assert.equal(
    later.parked('claude', now),
    new Date(now + 15 * 60_000).toISOString(),
  );
  assert.equal(later.view().claude?.backoff, 1);
  // An unreadable record reads as no wait.
  await writeFile(join(root, '.verifold', 'quota.json'), '{"schemaVersion":1,');
  const broken = new Quota(root);
  await broken.load();
  assert.equal(broken.parked('claude', now), null);
});

/**
 * A fake Claude Code whose turn first reports an open window and then fails
 * on a used-up one, as Claude Code reports a usage limit.
 */
const claudeHost = (
  resetsAt: number,
): string => `const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let turn = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'control_request' && message.request.subtype === 'initialize')
    return out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
  if (message.type !== 'user') return;
  turn++;
  out({ type: 'system', subtype: 'init', session_id: 'claude-native' });
  if (turn === 1) {
    out({ type: 'rate_limit_event', rate_limit_info: ${JSON.stringify(probedClaude)} });
    return out({ type: 'result', subtype: 'success' });
  }
  out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: ${resetsAt}, rateLimitType: 'five_hour' } });
  out({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|${resetsAt}' });
});`;

const codexSocket = fileURLToPath(
  new URL('./fixtures/codex-socket.cjs', import.meta.url),
);

/** A fake Codex app-server whose turn reports a full window without credits, then fails on it. */
const codexHost = (
  resetsAt: number,
): string => `const { out, onLine } = require(${JSON.stringify(codexSocket)})(process.argv);
onLine((line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') out({ id: message.id, result: {} });
  if (message.method === 'config/read') out({ id: message.id, result: { config: {} } });
  if (message.method === 'thread/start') out({ id: message.id, result: { thread: { id: 'codex-thread' } } });
  if (message.method === 'turn/start') {
    out({ id: message.id, result: { turn: { id: 'turn-1' } } });
    out({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: ${resetsAt} }, secondary: null, credits: { hasCredits: false, unlimited: false }, rateLimitReachedType: 'primary' } } });
    out({ method: 'error', params: { error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' }, willRetry: false } });
    out({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'failed', error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' } } } });
  }
});`;

async function wait(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 1000 && !check(); tries++) await delay(20);
  assert.ok(check(), 'the expected state did not arrive');
}

await test('a session passes its harness usage windows to the quota, and its record says once that the window is used up', async (t) => {
  const root = await folder(t);
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  await mkdir(join(root, '.verifold'), { recursive: true });
  for (const [name, host] of [
    ['fake-claude', claudeHost(resetsAt)],
    ['fake-codex', codexHost(resetsAt)],
  ] as const)
    await writeFile(join(root, name), `#!${process.execPath}\n${host}`, {
      mode: 0o700,
    });
  const quota = new Quota(root);
  const manager = (): SessionManager => {
    const made = new SessionManager(root, {
      clientVersion: 'test',
      ownerId: 'owner-1',
      executables: {
        claude: join(root, 'fake-claude'),
        codex: join(root, 'fake-codex'),
      },
      onLimit: (host, signal) => quota.record(host, signal),
    });
    t.after(() => made.close());
    return made;
  };
  const claude = manager();
  await claude.start({ host: 'claude', mode: 'ask', prompt: 'One.' });
  await wait(() => claude.view()?.record.status === 'idle');
  assert.equal(quota.view().claude?.exhausted, false);
  assert.equal(quota.view().claude?.usedPercent, 15);
  claude.send('Two.');
  await wait(() => quota.parked('claude') !== null);
  assert.equal(
    quota.parked('claude'),
    new Date(resetsAt * 1000 + 30_000).toISOString(),
  );
  await wait(() => claude.view()?.record.status === 'idle');
  const lines = claude
    .view()
    ?.record.events.filter((event) => /usage window/.test(event.text));
  assert.deepEqual(
    lines?.map((event) => event.text),
    [
      'Claude Code reports that its usage window is used up. Its turns fail until the window resets.',
    ],
  );
  const codex = manager();
  await codex.start({ host: 'codex', mode: 'ask', prompt: 'One.' });
  await wait(() => quota.parked('codex') !== null);
  assert.equal(
    quota.parked('codex'),
    new Date(resetsAt * 1000 + 30_000).toISOString(),
  );
  await quota.settled();
  const saved = JSON.parse(
    await readFile(join(root, '.verifold', 'quota.json'), 'utf8'),
  ) as Record<string, { exhausted: boolean }>;
  assert.equal(saved.claude?.exhausted, true);
  assert.equal(saved.codex?.exhausted, true);
});
