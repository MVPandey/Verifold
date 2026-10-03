import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeUpdates,
  codexAppUpdates,
  codexExecUpdates,
  TranscriptFile,
  TranscriptLog,
  TranscriptWriter,
  withTranscript,
  type TranscriptEntry,
  type TranscriptUpdate,
} from '../src/cli/transcript.ts';
import { runHarness, type HarnessRequest } from '../src/cli/harness.ts';

/** The event shapes that Claude Code 2.1.288 sent for one subagent run (probe, 2026-10-02). */
const claudeRun = [
  { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5' },
  {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_agent',
          name: 'Agent',
          input: {
            description: 'Run echo probe-sub',
            subagent_type: 'general-purpose',
            prompt: 'Run `echo probe-sub` and report the output.',
          },
        },
      ],
    },
  },
  { type: 'system', subtype: 'task_started', tool_use_id: 'toolu_agent' },
  {
    type: 'user',
    parent_tool_use_id: 'toolu_agent',
    message: {
      content: [
        { type: 'text', text: 'Run `echo probe-sub` and report the output.' },
      ],
    },
  },
  {
    type: 'assistant',
    parent_tool_use_id: 'toolu_agent',
    message: {
      content: [
        { type: 'thinking', thinking: 'I run the command.' },
        {
          type: 'tool_use',
          id: 'toolu_bash',
          name: 'Bash',
          input: { command: 'echo probe-sub', description: 'Print' },
        },
      ],
    },
  },
  {
    type: 'user',
    parent_tool_use_id: 'toolu_agent',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_bash',
          content: 'probe-sub',
          is_error: false,
        },
      ],
    },
  },
  {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_agent',
          content: [{ type: 'text', text: 'The output was probe-sub.' }],
        },
      ],
    },
  },
  {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      content: [{ type: 'text', text: 'The subagent printed **probe-sub**.' }],
    },
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 9100,
    result: 'Done',
  },
];

function entries(log: TranscriptLog): readonly TranscriptEntry[] {
  return log.page(null, 0, Infinity).entries;
}

/** Entries in creation order, the order that the page shows. */
function ordered(log: TranscriptLog): TranscriptEntry[] {
  return [...entries(log)].sort((a, b) => a.order - b.order);
}

await test('Claude Code events become a nested transcript with full tool input and output', () => {
  const log = new TranscriptLog();
  const apply = log.run();
  for (const event of claudeRun)
    for (const update of claudeUpdates(event)) apply(update);
  const list = ordered(log);
  assert.deepEqual(
    list.map((entry) => [entry.kind, entry.name ?? entry.text?.slice(0, 20)]),
    [
      ['note', 'Claude Code session '],
      ['tool', 'Agent'],
      ['request', 'Run `echo probe-sub`'],
      ['thinking', 'I run the command.'],
      ['tool', 'Bash'],
      ['text', 'The subagent printed'],
      ['note', 'The turn ended after'],
    ],
  );
  const [, agent, prompt, thinking, bash] = list;
  // Subagent work nests under the Agent call. The ID prefix is the same for one run.
  assert.equal(agent?.parent, null);
  for (const child of [prompt, thinking, bash])
    assert.equal(child?.parent, agent?.id);
  assert.equal(bash?.title, 'echo probe-sub');
  assert.match(bash?.input ?? '', /"command": "echo probe-sub"/);
  assert.equal(bash?.output, 'probe-sub');
  assert.equal(bash?.status, 'done');
  assert.equal(agent?.output, 'The output was probe-sub.');
  assert.equal(agent?.title, 'Run echo probe-sub');
  assert.match(list.at(-1)?.text ?? '', /after 9 s/);
});

await test('Codex items from exec and app-server merge by ID and keep failures', () => {
  const log = new TranscriptLog();
  const apply = log.run();
  const exec = [
    { type: 'thread.started', thread_id: 'thread-1' },
    {
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'error',
        message: 'Skill descriptions were shortened.',
      },
    },
    {
      type: 'item.started',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: "/bin/zsh -lc 'echo hello'",
        aggregated_output: '',
        exit_code: null,
        status: 'in_progress',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: "/bin/zsh -lc 'echo hello'",
        aggregated_output: 'hello\n',
        exit_code: 0,
        status: 'completed',
      },
    },
    {
      type: 'item.completed',
      item: { id: 'item_2', type: 'agent_message', text: 'Said hello.' },
    },
    { type: 'turn.failed' },
  ];
  for (const event of exec)
    for (const update of codexExecUpdates(event)) apply(update);
  const list = ordered(log);
  assert.deepEqual(
    list.map((entry) => entry.kind),
    ['note', 'tool', 'text', 'note'],
  );
  assert.equal(list[1]?.status, 'done');
  assert.equal(list[1]?.output, 'hello\n');
  assert.equal(list[1]?.title, "/bin/zsh -lc 'echo hello'");

  const app = new TranscriptLog();
  const next = app.run();
  for (const update of [
    ...codexAppUpdates(
      'item/completed',
      {
        id: 'c1',
        type: 'commandExecution',
        command: 'false',
        aggregatedOutput: 'no',
        exitCode: 1,
      },
      null,
    ),
    ...codexAppUpdates(
      'item/completed',
      { id: 'w1', type: 'webSearch', query: 'proof search' },
      'parent-call',
    ),
    ...codexAppUpdates(
      'item/completed',
      {
        id: 'r1',
        type: 'reasoning',
        summary: ['Plan the search.'],
        content: [],
      },
      null,
    ),
    ...codexAppUpdates('item/started', { id: 'u1', type: 'userMessage' }, null),
  ])
    next(update);
  const items = ordered(app);
  assert.equal(items[0]?.status, 'failed');
  assert.equal(items[1]?.name, 'Web search');
  assert.match(items[1]?.parent ?? '', /\.parent-call$/);
  assert.equal(items[2]?.text, 'Plan the search.');
  assert.equal(items.length, 3);
});

await test('runs get their own ID prefix, and long fields are cut visibly', () => {
  const log = new TranscriptLog();
  for (const apply of [log.run(), log.run()])
    apply({
      id: 'item_1',
      kind: 'tool',
      name: 'Command',
      input: 'x'.repeat(70 * 1024),
    });
  const list = entries(log);
  assert.equal(list.length, 2);
  assert.notEqual(list[0]?.id, list[1]?.id);
  for (const update of claudeUpdates({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'y'.repeat(70 * 1024) }] },
  })) {
    assert.ok((update.text?.length ?? 0) < 66 * 1024);
    assert.match(update.text ?? '', /Verifold cut 6144 more bytes here/);
  }
});

await test('a page holds each entry once, in update order, and restarts on a new epoch', () => {
  const log = new TranscriptLog();
  const apply = log.run();
  apply({ id: 'a', kind: 'tool', name: 'Bash', status: 'running' });
  apply({ kind: 'text', text: 'Between' });
  const first = log.page(null, 0);
  assert.equal(first.entries.length, 2);
  apply({ id: 'a', output: 'done', status: 'done' });
  const second = log.page(first.epoch, first.last);
  assert.deepEqual(
    second.entries.map((entry) => [entry.name, entry.status, entry.output]),
    [['Bash', 'done', 'done']],
  );
  // An unknown epoch means the page has nothing of this log.
  assert.equal(log.page('0000', second.last).entries.length, 2);
  // Big entries split into more pages.
  for (let index = 0; index < 20; index++)
    apply({ kind: 'text', text: 'z'.repeat(60 * 1024) });
  const big = log.page(null, 0, 500_000);
  assert.equal(big.more, true);
  const rest = log.page(big.epoch, big.last, 10_000_000);
  assert.equal(big.entries.length + rest.entries.length, 22);
  assert.equal(rest.more, false);
});

await test('a transcript file grows by runs, and the desk follows it line by line', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-transcript-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'transcript.jsonl');
  const follower = new TranscriptFile(file);
  await follower.refresh();
  assert.equal(follower.found, false);

  const writer = await TranscriptWriter.open(file);
  const first = writer.run();
  first({ kind: 'request', text: 'Plan the research ✓' });
  first({ id: 'item_1', kind: 'tool', name: 'Command', status: 'running' });
  await writer.flushed();
  await follower.refresh();
  assert.equal(follower.found, true);
  assert.equal(entries(follower.log).length, 2);

  // A later launch continues the same file. Its IDs cannot match the first launch.
  const again = await TranscriptWriter.open(file);
  const second = again.run();
  second({ id: 'item_1', kind: 'tool', name: 'Command', status: 'done' });
  first({ id: 'item_1', output: 'ok', status: 'done' });
  await again.flushed();
  await writer.flushed();
  // A half-written line waits for its end.
  await appendFile(
    file,
    '{"id":"half","at":"2026-10-02T00:00:00.000Z","kind":"note",',
  );
  await follower.refresh();
  assert.deepEqual(
    ordered(follower.log).map((entry) => [
      entry.kind,
      entry.status,
      entry.output,
    ]),
    [
      ['request', undefined, undefined],
      ['tool', 'done', 'ok'],
      ['tool', 'done', undefined],
    ],
  );
  await appendFile(file, '"text":"Now complete"}\nnot json\n{"id":5}\n');
  await follower.refresh();
  assert.equal(ordered(follower.log).at(-1)?.text, 'Now complete');
  assert.match(ordered(follower.log)[0]?.text ?? '', /✓/);
  if (process.platform !== 'win32')
    assert.equal((await stat(file)).mode & 0o777, 0o600);

  // A symbolic link is never followed or written.
  const link = join(root, 'link.jsonl');
  await symlink(file, link);
  const linked = new TranscriptFile(link);
  await linked.refresh();
  assert.equal(linked.found, false);
  const before = await readFile(file, 'utf8');
  const blocked = await TranscriptWriter.open(link);
  blocked.run()({ kind: 'note', text: 'Must not appear' });
  await blocked.flushed();
  assert.equal(await readFile(file, 'utf8'), before);
});

await test('a transcript stops at 16 MB with a note', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-transcript-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'transcript.jsonl');
  const writer = await TranscriptWriter.open(file);
  const apply = writer.run();
  const big = 'b'.repeat(60 * 1024);
  for (let index = 0; index < 300; index++) apply({ kind: 'text', text: big });
  await writer.flushed();
  const text = await readFile(file, 'utf8');
  assert.ok(Buffer.byteLength(text) <= 16 * 1024 * 1024 + 1000);
  assert.match(
    text.trimEnd().split('\n').at(-1) ?? '',
    /stopped recording this transcript at 16 MB/,
  );
  const follower = new TranscriptFile(file);
  for (let reads = 0; reads < 6; reads++) await follower.refresh();
  assert.match(ordered(follower.log).at(-1)?.text ?? '', /16 MB/);
});

await test('runHarness sends the prompt and each event to the transcript as it arrives', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-transcript-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'fake-claude');
  // Events, then more than 2 MiB of output in many lines, then the result.
  await writeFile(
    executable,
    `#!${process.execPath}
process.stdin.resume();
process.stdin.on('end', () => {
  for (const event of ${JSON.stringify(claudeRun.slice(0, -1))}) console.log(JSON.stringify(event));
  const filler = JSON.stringify({ type: 'rate_limit_event', note: 'f'.repeat(1000) });
  for (let index = 0; index < 3000; index++) console.log(filler);
  console.log(JSON.stringify({ type: 'result', result: 'Final', session_id: 'abc-1', is_error: false }));
});`,
    { mode: 0o700 },
  );
  const updates: TranscriptUpdate[] = [];
  const sink = new TranscriptLog();
  const request: HarnessRequest = {
    host: 'claude',
    cwd: root,
    prompt: 'Find prior work',
    signal: new AbortController().signal,
    onTranscript: (update) => updates.push(update),
  };
  const result = await withTranscript(
    (next: HarnessRequest) => runHarness(next, { executable }),
    sink,
  )(request);
  assert.deepEqual(result, { text: 'Final', sessionId: 'abc-1' });
  assert.deepEqual(updates[0], {
    kind: 'request',
    parent: null,
    text: 'Find prior work',
  });
  assert.ok(updates.some((update) => update.name === 'Bash'));
  // The sink got the same run, with its own prefix.
  assert.ok(entries(sink).every((entry) => /^[a-f0-9]{8}\./.test(entry.id)));
  assert.equal(
    ordered(sink).filter((entry) => entry.kind === 'tool').length,
    2,
  );
});
