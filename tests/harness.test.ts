import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { runHarness, type HarnessName } from '../src/cli/harness.ts';

async function fixture(
  source: string,
  run: (executable: string, cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'verifold-host-')));
  const executable = join(cwd, 'fake-host');
  try {
    await writeFile(executable, `#!${process.execPath}\n${source}`, {
      mode: 0o700,
    });
    await run(executable, cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

for (const host of ['claude', 'codex'] as const) {
  await test(`${host} passes the prompt through stdin and reads the final result`, async () => {
    await fixture(
      `let input = ''; process.stdin.setEncoding('utf8');
       process.stdin.on('data', chunk => input += chunk);
       process.stdin.on('end', () => {
         const text = JSON.stringify({ input, args: process.argv.slice(2), cwd: process.cwd() });
         console.log(JSON.stringify(${host === 'claude' ? '{ result: text, is_error: false }' : "{ type: 'item.completed', item: { type: 'agent_message', text } }"}));
       });`,
      async (executable, cwd) => {
        const result = await runHarness(
          {
            host,
            cwd,
            prompt: 'Research $(must remain literal)\nnext line',
            signal: new AbortController().signal,
          },
          { executable },
        );
        const parsed: unknown = JSON.parse(result.text);
        assert.deepEqual(parsed, {
          input: 'Research $(must remain literal)\nnext line',
          args:
            host === 'claude'
              ? ['-p', '--output-format', 'stream-json', '--verbose']
              : [
                  '--search',
                  'exec',
                  '--skip-git-repo-check',
                  '--color',
                  'never',
                  '--json',
                  '-',
                ],
          cwd,
        });
      },
    );
  });
}

const failures: readonly [HarnessName, string, RegExp][] = [
  ['claude', '{"is_error":true,"result":"private detail"}', /failed request/],
  ['claude', '{"result":""}', /no result text/],
  ['claude', 'not json', /invalid JSON/],
  [
    'codex',
    '{"type":"turn.failed","error":{"message":"private detail"}}',
    /failed request/,
  ],
  ['codex', '{"type":"error","message":"private detail"}', /failed request/],
  ['codex', '{"type":"turn.completed"}', /no result text/],
];
for (const [host, output, expected] of failures) {
  await test(`${host} rejects ${output}`, async () => {
    await fixture(
      `process.stdin.resume(); console.log(${JSON.stringify(output)});`,
      async (executable, cwd) => {
        await assert.rejects(
          runHarness(
            { host, cwd, prompt: '', signal: new AbortController().signal },
            { executable },
          ),
          expected,
        );
      },
    );
  });
}

await test('Codex returns the last agent message and ignores tool events', async () => {
  const events = [
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Interim' },
    },
    {
      type: 'item.completed',
      item: { type: 'command_execution', text: 'Not a result' },
    },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Final' } },
    { type: 'turn.completed' },
  ]
    .map((event) => JSON.stringify(event))
    .join('\n');
  await fixture(
    `process.stdin.resume(); console.log(${JSON.stringify(events)});`,
    async (executable, cwd) => {
      assert.deepEqual(
        await runHarness(
          {
            host: 'codex',
            cwd,
            prompt: '',
            signal: new AbortController().signal,
          },
          { executable },
        ),
        { text: 'Final' },
      );
    },
  );
});

await test('host failures do not expose raw stderr', async () => {
  await fixture(
    "process.stdin.resume(); console.error('private token'); process.exitCode = 7;",
    async (executable, cwd) => {
      await assert.rejects(
        runHarness(
          {
            host: 'claude',
            cwd,
            prompt: '',
            signal: new AbortController().signal,
          },
          { executable },
        ),
        /exited with status 7/,
      );
    },
  );
});

await test('missing executable gives an actionable error', async () => {
  await fixture('', async (_executable, cwd) => {
    await assert.rejects(
      runHarness(
        {
          host: 'claude',
          cwd,
          prompt: '',
          signal: new AbortController().signal,
        },
        { executable: join(cwd, 'absent') },
      ),
      /installed and available/,
    );
  });
});

await test('output limit stops an active child', async () => {
  await fixture(
    "process.stdin.resume(); process.stdout.write('x'.repeat(3 * 1024 * 1024)); setInterval(() => {}, 1000);",
    async (executable, cwd) => {
      await assert.rejects(
        runHarness(
          {
            host: 'claude',
            cwd,
            prompt: '',
            signal: new AbortController().signal,
          },
          { executable },
        ),
        /output exceeds/,
      );
    },
  );
});

await test('timeout stops an active child', async () => {
  await fixture(
    "process.stdin.resume(); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    async (executable, cwd) => {
      await assert.rejects(
        runHarness(
          {
            host: 'claude',
            cwd,
            prompt: '',
            signal: new AbortController().signal,
            timeoutMs: 200,
          },
          { executable },
        ),
        /time limit/,
      );
    },
  );
});

await test('cancellation stops a child and releases the abort listener', async () => {
  await fixture(
    'process.stdin.resume(); setInterval(() => {}, 1000);',
    async (executable, cwd) => {
      const controller = new AbortController();
      const pending = runHarness(
        { host: 'claude', cwd, prompt: '', signal: controller.signal },
        { executable },
      );
      controller.abort();
      await assert.rejects(pending, /cancelled/);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    },
  );
});

await test('cancellation kills a running child that ignores SIGTERM', async () => {
  await fixture(
    "process.stdin.resume(); process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('ready', String(process.pid)); setInterval(() => {}, 1000);",
    async (executable, cwd) => {
      const controller = new AbortController();
      const pending = runHarness(
        { host: 'claude', cwd, prompt: '', signal: controller.signal },
        { executable },
      );
      const rejected = assert.rejects(pending, /cancelled/);
      let pid: number | undefined;
      try {
        for (let attempt = 0; attempt < 150; attempt += 1) {
          const content = await readFile(join(cwd, 'ready'), 'utf8').catch(
            () => undefined,
          );
          if (content !== undefined) {
            pid = Number(content);
            break;
          }
          await delay(20);
        }
        assert.ok(pid, 'The fixture must start before cancellation.');
      } finally {
        controller.abort();
        await rejected;
      }
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    },
  );
});

await test('already cancelled requests fail before host launch', async () => {
  const controller = new AbortController();
  controller.abort(new Error('Stopped before launch'));
  await assert.rejects(
    runHarness({
      host: 'claude',
      cwd: '/',
      prompt: '',
      signal: controller.signal,
    }),
    /Stopped before launch/,
  );
});

for (const host of ['claude', 'codex'] as const) {
  await test(`${host} resumes an explicit session and returns the host session ID`, async () => {
    const id = '12345678-1234-1234-1234-123456789abc';
    await fixture(
      `process.stdin.resume();
       const text = JSON.stringify(process.argv.slice(2));
       ${host === 'codex' ? `console.log(JSON.stringify({type:'thread.started', thread_id: '${id}'}));` : ''}
       console.log(JSON.stringify(${host === 'claude' ? `{result:text,is_error:false,session_id:'${id}'}` : `{type:'item.completed',item:{type:'agent_message',text}}`}));`,
      async (executable, cwd) => {
        const result = await runHarness(
          {
            host,
            cwd,
            prompt: 'Refine the idea',
            sessionId: id,
            signal: new AbortController().signal,
          },
          { executable },
        );
        assert.equal(result.sessionId, id);
        const args: unknown = JSON.parse(result.text);
        assert.deepEqual(
          args,
          host === 'claude'
            ? [
                '-p',
                '--output-format',
                'stream-json',
                '--verbose',
                '--resume',
                id,
              ]
            : [
                '--search',
                'exec',
                '--skip-git-repo-check',
                '--color',
                'never',
                '--json',
                'resume',
                id,
                '-',
              ],
        );
      },
    );
  });
}

await test('invalid session IDs cannot become host flags', async () => {
  await assert.rejects(
    runHarness({
      host: 'codex',
      cwd: '/',
      prompt: '',
      sessionId: '--last',
      signal: new AbortController().signal,
    }),
    /invalid format/,
  );
});

for (const host of ['claude', 'codex'] as const) {
  for (const resume of [false, true]) {
    await test(`${host} forwards the selected model for ${resume ? 'resumed' : 'new'} sessions`, async () => {
      await fixture(
        `process.stdin.resume();
         const text = JSON.stringify(process.argv.slice(2));
         console.log(JSON.stringify(${host === 'claude' ? '{ result: text }' : "{ type: 'item.completed', item: { type: 'agent_message', text } }"}));`,
        async (executable, cwd) => {
          const model = 'provider/model-v1.2:variant@latest';
          const result = await runHarness(
            {
              host,
              cwd,
              prompt: 'A small research question',
              signal: new AbortController().signal,
              model,
              ...(resume ? { sessionId: 'session-123' } : {}),
            },
            { executable },
          );
          const args: unknown = JSON.parse(result.text);
          assert.deepEqual(
            args,
            host === 'claude'
              ? [
                  '-p',
                  '--output-format',
                  'stream-json',
                  '--verbose',
                  '--model',
                  model,
                  ...(resume ? ['--resume', 'session-123'] : []),
                ]
              : [
                  '--search',
                  'exec',
                  '--skip-git-repo-check',
                  '--color',
                  'never',
                  '--json',
                  ...(resume ? ['resume'] : []),
                  '--model',
                  model,
                  ...(resume ? ['session-123'] : []),
                  '-',
                ],
          );
        },
      );
    });
  }
}

await test('invalid models fail before launching a host', async () => {
  for (const model of [
    '',
    '--last',
    'two words',
    'opus\n',
    'opus\r',
    'a\u0000b',
    'a\u001bb',
    'a'.repeat(201),
  ]) {
    await assert.rejects(
      runHarness(
        {
          host: 'codex',
          cwd: '/',
          prompt: '',
          signal: new AbortController().signal,
          model,
        },
        { executable: '/missing-verifold-host' },
      ),
      /Harness model must be a valid identifier/,
    );
  }
});

await test('Claude streams observed activity and denials without private tool payloads', async () => {
  const events = [
    {
      type: 'system',
      subtype: 'init',
      session_id: 'session-123',
      model: 'claude-fixture-model',
    },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'private model thoughts' },
          {
            type: 'tool_use',
            name: 'WebSearch',
            input: { query: 'private query' },
          },
          { type: 'tool_use', name: '\u001b[31mprivate tool name', input: {} },
        ],
      },
    },
    {
      type: 'assistant',
      parent_tool_use_id: 'call-1',
      message: {
        content: [
          {
            type: 'tool_use',
            name: 'Read',
            input: { file_path: '/private/path' },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: 'private tool result',
          },
        ],
      },
    },
    {
      type: 'user',
      parent_tool_use_id: 'call-1',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-2',
            is_error: true,
            content: 'private error',
          },
        ],
      },
    },
    {
      type: 'result',
      result: 'A reviewed answer',
      session_id: 'session-123',
      permission_denials: [
        { tool_name: 'Bash', tool_input: { command: 'private command' } },
      ],
    },
  ];
  await fixture(
    `process.stdin.resume();
     const events = ${JSON.stringify(events)};
     console.log(JSON.stringify(events.shift()));
     const timer = setInterval(() => {
       const event = events.shift();
       if (!event) { clearInterval(timer); return; }
       const line = JSON.stringify(event);
       process.stdout.write(line.slice(0, 13));
       process.stdout.write(line.slice(13) + (events.length ? '\\n' : ''));
     }, 10);`,
    async (executable, cwd) => {
      const messages: string[] = [];
      const result = await runHarness(
        {
          host: 'claude',
          cwd,
          prompt: '',
          signal: new AbortController().signal,
          onActivity: (message) => messages.push(message),
        },
        { executable },
      );
      assert.deepEqual(result, {
        text: 'A reviewed answer',
        sessionId: 'session-123',
      });
      assert.ok(messages.some((message) => message.includes('WebSearch')));
      assert.ok(
        messages.some((message) => message.includes('native subagent')),
      );
      assert.ok(messages.some((message) => message.includes('denied 1')));
      assert.ok(
        messages.some((message) =>
          message.includes(
            'Model: claude-fixture-model. Session: session-123.',
          ),
        ),
      );
      assert.ok(messages.includes('Claude Code tool returned a result.'));
      assert.ok(
        messages.includes(
          'Claude Code tool returned an error in a native subagent.',
        ),
      );
      assert.doesNotMatch(messages.join('\n'), /private/);
      assert.ok(!messages.join('\n').includes('\u001b'));
    },
  );
});

await test('Codex reports native tool activity without command or search content', async () => {
  const events = [
    { type: 'thread.started', thread_id: 'session-123' },
    {
      type: 'item.started',
      item: { type: 'web_search', query: 'private query' },
    },
    {
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'private command',
        aggregated_output: 'private output',
      },
    },
    { type: 'item.completed', item: { type: 'agent_message', text: 'Done' } },
  ];
  await fixture(
    `process.stdin.resume(); for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));`,
    async (executable, cwd) => {
      const messages: string[] = [];
      const result = await runHarness(
        {
          host: 'codex',
          cwd,
          prompt: '',
          signal: new AbortController().signal,
          onActivity: (message) => messages.push(message),
        },
        { executable },
      );
      assert.equal(result.text, 'Done');
      assert.deepEqual(messages, [
        'Codex session connected.',
        'Codex started web search.',
        'Codex finished a command.',
      ]);
    },
  );
});

await test('activity is delivered before completion and callback failures stop the child', async () => {
  await fixture(
    `process.stdin.resume(); console.log(JSON.stringify({type: 'system', subtype: 'init'})); setInterval(() => {}, 1000);`,
    async (executable, cwd) => {
      await assert.rejects(
        runHarness(
          {
            host: 'claude',
            cwd,
            prompt: '',
            signal: new AbortController().signal,
            timeoutMs: 2000,
            onActivity: () => {
              throw new Error('private callback failure');
            },
          },
          { executable },
        ),
        /Could not report harness activity/,
      );
    },
  );
});
