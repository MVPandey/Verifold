import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterProcess,
  helpersAfter,
  lostLine,
  parseHelper,
} from '../src/core/lab/helpers.ts';
import type { Helper } from '../src/core/lab/schema.ts';
import { HelperStore } from '../src/core/lab/helper-store.ts';
import { readingLimits } from '../src/core/lab-tools.ts';
import {
  claudeUpdates,
  codexAppUpdates,
  codexHelperEnds,
  helperEvent,
  type TranscriptUpdate,
} from '../src/core/transcript.ts';
import { helperLine } from '../src/app/helpers.ts';

const at = '2026-11-01T10:00:00.000Z';

const fold = (
  updates: readonly TranscriptUpdate[],
  from: readonly Helper[] = [],
  launch = 'run-1',
): readonly Helper[] =>
  updates.reduce((helpers, update) => {
    const event = helperEvent(update);
    return event
      ? helpersAfter(helpers, event, 'agent-3', launch, at)
      : helpers;
  }, from);

/** An Agent call as Claude Code streams it. */
const agentCall = (id: string, background = false): unknown => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: {
    content: [
      {
        type: 'tool_use',
        id,
        name: 'Agent',
        input: {
          description: 'Find the prior work',
          prompt: 'Find the prior work on this idea.',
          ...(background ? { run_in_background: true } : {}),
        },
      },
    ],
  },
});

const agentResult = (id: string, content: string, error = false): unknown => ({
  type: 'user',
  parent_tool_use_id: null,
  message: {
    content: [
      { type: 'tool_result', tool_use_id: id, content, is_error: error },
    ],
  },
});

const helperWork = (parent: string): unknown => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: {
    content: [
      { type: 'tool_use', id: `in-${parent}`, name: 'WebSearch', input: {} },
    ],
  },
});

const notification = (id: string, status: string): unknown => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: 'a123',
  tool_use_id: id,
  status,
  output_file: '',
  summary: 'It ended.',
});

const events = (...list: readonly unknown[]): readonly TranscriptUpdate[] =>
  list.flatMap((event) => claudeUpdates(event));

await test('a helper in the foreground ends with its tool result', () => {
  const running = fold(events(agentCall('t1'), helperWork('t1')));
  assert.deepEqual(
    running.map(({ label, title, state }) => [label, title, state]),
    [['agent-3.1', 'Find the prior work', 'running']],
  );
  assert.equal(
    fold(events(agentResult('t1', 'Three papers.')), running)[0]?.state,
    'done',
  );
});

await test('a foreground helper with an error or an empty result stopped with no result', () => {
  const running = fold(events(agentCall('t1')));
  assert.equal(
    fold(events(agentResult('t1', 'It broke.', true)), running)[0]?.state,
    'lost',
  );
  assert.equal(fold(events(agentResult('t1', '')), running)[0]?.state, 'lost');
});

await test('a helper in the background goes on after its tool result, until its task notification', () => {
  const launched = fold(
    events(
      agentCall('t1', true),
      agentResult('t1', 'Async agent launched successfully.\nagentId: a123'),
    ),
  );
  assert.equal(launched[0]?.state, 'running');
  assert.equal(
    fold(events(notification('t1', 'completed')), launched)[0]?.state,
    'done',
  );
  for (const status of ['failed', 'stopped'])
    assert.equal(
      fold(events(notification('t1', status)), launched)[0]?.state,
      'lost',
    );
});

await test('updates of other tools, and of unknown helpers, change nothing', () => {
  const running = fold(events(agentCall('t1')));
  for (const update of [
    ...events(notification('other', 'failed')),
    ...events(agentResult('other', 'x')),
    { id: 'x', kind: 'tool' as const, name: 'Bash', title: 'ls' },
    { kind: 'text' as const, text: 'I started 9 helpers.' },
  ])
    assert.equal(fold([update], running), running);
});

await test('labels count up for each agent, and the bound takes helpers that ended first', () => {
  const start = (count: number, from = 0): readonly unknown[] =>
    Array.from({ length: count }, (_, index) => agentCall(`t${from + index}`));
  const ended = fold(
    events(
      ...start(readingLimits.helpers),
      agentResult('t0', 'Done.'),
      agentResult('t1', 'Done.'),
    ),
  );
  const next = fold(events(agentCall('new')), ended);
  assert.equal(next.length, readingLimits.helpers);
  assert.equal(next.at(-1)?.label, `agent-3.${readingLimits.helpers + 1}`);
  // The helper that ended went, and the other that ended is next.
  assert.ok(!next.some((helper) => helper.id === 't0'));
  assert.ok(next.some((helper) => helper.id === 't1'));
});

await test('the bound never drops a helper that runs, or a lost one that its agent has not heard of', () => {
  const full = fold(
    events(
      ...Array.from({ length: readingLimits.helpers }, (_, index) =>
        agentCall(`t${index}`),
      ),
    ),
  );
  // Every one runs, so the list takes no new one, and it stays bounded.
  assert.equal(fold(events(agentCall('new')), full), full);
  const lost = afterProcess(full, null, at);
  assert.equal(fold(events(agentCall('new')), lost), lost);
  // A lost helper that its agent heard of can go.
  const told = lost.map((helper, index) =>
    index === 3 ? { ...helper, told: true as const } : helper,
  );
  const next = fold(events(agentCall('new')), told);
  assert.equal(next.length, readingLimits.helpers);
  assert.ok(!next.some((helper) => helper.id === 't3'));
  assert.ok(next.some((helper) => helper.id === 'new'));
});

await test("a helper that runs when its agent's process ends stopped with no result", () => {
  const running = fold(events(agentCall('t1'), agentCall('t2')));
  const ended = fold(events(agentResult('t2', 'Done.')), running);
  // The same process runs on: nothing changes.
  assert.equal(afterProcess(ended, 'run-1', at), ended);
  const stopped = afterProcess(ended, null, at);
  assert.deepEqual(
    stopped.map((helper) => helper.state),
    ['lost', 'done'],
  );
  // A new process does not hold it either.
  assert.equal(afterProcess(ended, 'run-2', at)[0]?.state, 'lost');
  assert.match(
    lostLine(stopped[0] as Helper),
    /^Your helper agent-3\.1 "Find the prior work" stopped with no result\./,
  );
});

await test('an agent can resume a lost helper in a new process, and it shows as running', () => {
  const lost = afterProcess(fold(events(agentCall('t1', true))), null, at);
  const told = lost.map((helper) => ({ ...helper, told: true as const }));
  const resumed = fold(events(helperWork('t1')), told, 'run-2');
  assert.equal(resumed[0]?.state, 'running');
  assert.equal(resumed[0]?.launch, 'run-2');
  // It can be lost again, and its agent hears again.
  assert.equal(resumed[0]?.told, undefined);
});

await test('a done helper stays done', () => {
  const done = fold(events(agentCall('t1'), agentResult('t1', 'Done.')));
  assert.equal(
    fold(events(notification('t1', 'stopped')), done)[0]?.state,
    'done',
  );
});

await test("Codex's spawn starts a helper, and its report of the spawn does not end it", () => {
  const collab = (status: string): Record<string, unknown> => ({
    type: 'collabAgentToolCall',
    id: 'collab-1',
    tool: 'spawnAgent',
    prompt: 'Check the README',
    receiverThreadIds: ['child-1'],
    status,
  });
  const started = fold(
    codexAppUpdates('item/started', collab('inProgress'), null),
  );
  assert.equal(started[0]?.title, 'Check the README');
  const spawned = fold(
    codexAppUpdates('item/completed', collab('completed'), null),
    started,
  );
  assert.equal(spawned[0]?.state, 'running');
  // A later call that names the helper is not a new one.
  const wait = codexAppUpdates(
    'item/completed',
    { ...collab('completed'), id: 'collab-2', tool: 'wait', prompt: null },
    null,
  );
  assert.equal(wait[0]?.name, 'Agents');
  assert.equal(fold(wait, spawned).length, 1);
  const threads = new Map([['child-1', 'collab-1']]);
  assert.equal(
    fold(
      codexHelperEnds({ 'child-1': { status: 'completed' } }, threads),
      spawned,
    )[0]?.state,
    'done',
  );
  assert.equal(
    fold(
      codexHelperEnds({ 'child-1': { status: 'errored' } }, threads),
      spawned,
    )[0]?.state,
    'lost',
  );
  assert.deepEqual(
    codexHelperEnds({ 'child-1': { status: 'running' } }, threads),
    [],
  );
  assert.deepEqual(codexHelperEnds(undefined, threads), []);
  // A spawn that failed never ran.
  assert.equal(
    fold(codexAppUpdates('item/completed', collab('failed'), null), started)[0]
      ?.state,
    'lost',
  );
});

await test('a saved helper keeps what is valid and drops what is not', () => {
  const helper = {
    id: 't1',
    label: 'agent-3.1',
    title: 'Find it',
    state: 'lost',
    at,
    launch: 'run-1',
    told: true,
  };
  assert.deepEqual(parseHelper(helper), helper);
  for (const bad of [
    null,
    { ...helper, state: 'gone' },
    { ...helper, label: 'x' },
    { ...helper, at: 'never' },
    { ...helper, launch: 7 },
  ])
    assert.equal(parseHelper(bad), null);
});

await test('the store tells an agent once of a helper that stopped with no result', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'verifold-helpers-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const path = join(base, 'helpers.json');
  const store = new HelperStore(path, () => false);
  const told: { agent: string; line: string }[] = [];
  const tell = (agent: string, line: string): boolean => {
    told.push({ agent, line });
    return true;
  };
  for (const update of events(agentCall('t1', true)))
    store.heard('a-3', 'agent-3', 'run-1', update, at);
  assert.equal(store.helping('a-3'), true);
  // It runs while its process runs.
  store.sweep(() => 'run-1', tell);
  assert.equal(told.length, 0);
  store.sweep(() => null, tell);
  assert.equal(told.length, 1);
  assert.equal(told[0]?.agent, 'a-3');
  assert.match(told[0]?.line ?? '', /agent-3\.1/);
  assert.equal(store.helping('a-3'), false);
  store.sweep(() => null, tell);
  assert.equal(told.length, 1);
  // Its harness can say so too: the agent hears only of the new one.
  for (const update of events(
    agentCall('t2', true),
    notification('t2', 'failed'),
  ))
    store.heard('a-3', 'agent-3', 'run-1', update, at);
  store.sweep(() => 'run-1', tell);
  assert.equal(told.length, 2);
  await store.flush();
  const again = new HelperStore(path, () => false);
  await again.load(true);
  again.sweep(() => null, tell);
  assert.equal(told.length, 2);
  assert.equal(again.helpersOf('a-3').length, 2);
});

await test('a notice that does not reach the agent stays untold, and comes again', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'verifold-helpers-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const store = new HelperStore(join(base, 'helpers.json'), () => false);
  for (const update of events(agentCall('t1', true)))
    store.heard('a-3', 'agent-3', 'run-1', update, at);
  let tries = 0;
  store.sweep(
    () => null,
    () => {
      tries += 1;
      return false;
    },
  );
  assert.equal(tries, 1);
  assert.equal(store.helpersOf('a-3')[0]?.state, 'lost');
  assert.equal(store.helpersOf('a-3')[0]?.told, undefined);
  store.sweep(
    () => null,
    () => {
      tries += 1;
      return true;
    },
  );
  assert.equal(tries, 2);
  assert.equal(store.helpersOf('a-3')[0]?.told, true);
});

await test('a broken helper file leaves a store that works', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'verifold-helpers-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const path = join(base, 'helpers.json');
  await writeFile(
    path,
    JSON.stringify({
      helpers: [
        { agent: '../evil', helpers: [] },
        { agent: 'a-1', helpers: [{ id: 'x' }, 7] },
      ],
    }),
  );
  const store = new HelperStore(path, () => false);
  await store.load(true);
  assert.deepEqual(store.helpersOf('a-1'), []);
  assert.deepEqual(store.helpersOf('../evil'), []);
});

await test("an agent's row says one line of its helpers", () => {
  const helper = (
    state: Helper['state'],
  ): Pick<Helper, 'label' | 'title' | 'state'> => ({
    label: 'agent-3.1',
    title: 'x',
    state,
  });
  assert.equal(helperLine([]), null);
  assert.equal(helperLine([helper('done')]), null);
  assert.equal(helperLine([helper('running')]), '1 helper');
  assert.equal(helperLine([helper('running'), helper('running')]), '2 helpers');
  assert.equal(
    helperLine([helper('running'), helper('lost')]),
    '1 helper stopped with no result',
  );
  assert.equal(
    helperLine([helper('lost'), helper('lost')]),
    '2 helpers stopped with no result',
  );
});
