import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  activityProgress,
  codexOffOptions,
  HarnessTimeoutError,
  runHarness,
  type HarnessName,
} from '../src/core/harness.ts';

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

/**
 * A fake harness whose `mcp list --json` runs `servers` and counts itself in
 * `mcp-count`, and whose call waits `runMs`, then prints its arguments.
 */
function textOnlyHost(servers: string, runMs = 0): string {
  return `const { appendFileSync, writeFileSync } = require('node:fs');
     const args = process.argv.slice(2);
     if (args.includes('mcp')) {
       writeFileSync('mcp-args.json', JSON.stringify(args));
       appendFileSync('mcp-count', 'x');
       ${servers}
     } else {
       writeFileSync('ran', '');
       process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => {
         const text = JSON.stringify(args);
         console.log(JSON.stringify(args[0] === '-p'
           ? { result: text, is_error: false }
           : { type: 'item.completed', item: { type: 'agent_message', text } }));
       }, ${runMs}));
     }`;
}

const appsOff = ['-c', 'features.plugins=false', '-c', 'features.apps=false'];
const codexTextOnlyOptions = [
  '-c',
  'web_search="disabled"',
  '-c',
  'approval_policy="never"',
];
const codexExecTail = [
  'exec',
  '--sandbox',
  'read-only',
  '--skip-git-repo-check',
  '--color',
  'never',
  '--json',
  '-',
];

await test('the -c options that turn off MCP servers name each server, and none when a name is not a plain key', () => {
  assert.deepEqual(codexOffOptions(['github', 'node_repl', 'computer-use']), [
    ...appsOff,
    '-c',
    'mcp_servers.github.enabled=false',
    '-c',
    'mcp_servers.node_repl.enabled=false',
    '-c',
    'mcp_servers.computer-use.enabled=false',
  ]);
  assert.deepEqual(codexOffOptions([]), appsOff);
  // Codex reads a quoted key as a new server, so a name with a dot or a space cannot be turned off this way.
  for (const odd of ['my.server', 'my server', '"github"', ''])
    assert.equal(codexOffOptions(['github', odd]), null);
});

await test('a text-only call gives Claude Code no tools or MCP servers, and Codex no web search, a read-only sandbox with no approvals, and none of the MCP servers, plugins or apps of the person', async () => {
  for (const host of ['claude', 'codex'] as const)
    await fixture(
      textOnlyHost(
        `console.log(JSON.stringify([{ name: 'github', enabled: true }, { name: 'node_repl', enabled: false }, { name: 'computer-use', enabled: false }]));`,
      ),
      async (executable, cwd) => {
        const result = await runHarness(
          {
            host,
            cwd,
            prompt: 'Pick skills.',
            signal: new AbortController().signal,
            textOnly: true,
            outsideText: true,
          },
          { executable },
        );
        assert.deepEqual(
          JSON.parse(result.text),
          host === 'claude'
            ? [
                '-p',
                '--output-format',
                'stream-json',
                '--verbose',
                '--tools',
                '',
                '--strict-mcp-config',
              ]
            : [
                ...appsOff,
                '-c',
                'mcp_servers.github.enabled=false',
                '-c',
                'mcp_servers.node_repl.enabled=false',
                '-c',
                'mcp_servers.computer-use.enabled=false',
                ...codexTextOnlyOptions,
                ...codexExecTail,
              ],
        );
        // Codex lists its MCP servers with plugins and apps off, so the list holds the servers of the configuration.
        if (host === 'codex')
          assert.deepEqual(
            JSON.parse(await readFile(join(cwd, 'mcp-args.json'), 'utf8')),
            [...appsOff, 'mcp', 'list', '--json'],
          );
        else
          await assert.rejects(readFile(join(cwd, 'mcp-args.json')), {
            code: 'ENOENT',
          });
      },
    );
});

await test('a call that may read its own files gives Claude Code only its Read tool, allowed on those paths in dontAsk mode, and Codex the text-only options', async () => {
  for (const host of ['claude', 'codex'] as const)
    await fixture(
      textOnlyHost(
        `console.log(JSON.stringify([{ name: 'github', enabled: true }]));`,
      ),
      async (executable, cwd) => {
        const result = await runHarness(
          {
            host,
            cwd,
            prompt: 'What do you know about the person?',
            signal: new AbortController().signal,
            ownFiles: [
              '/home/me/.claude/CLAUDE.md',
              '/home/me/.claude/projects/*/memory/**',
            ],
            outsideText: true,
          },
          { executable },
        );
        assert.deepEqual(
          JSON.parse(result.text),
          host === 'claude'
            ? [
                '-p',
                '--output-format',
                'stream-json',
                '--verbose',
                '--tools',
                'Read',
                '--strict-mcp-config',
                '--permission-mode',
                'dontAsk',
                '--settings',
                JSON.stringify({
                  permissions: {
                    allow: [
                      'Read(//home/me/.claude/CLAUDE.md)',
                      'Read(//home/me/.claude/projects/*/memory/**)',
                    ],
                  },
                }),
              ]
            : [
                ...appsOff,
                '-c',
                'mcp_servers.github.enabled=false',
                ...codexTextOnlyOptions,
                ...codexExecTail,
              ],
        );
      },
    );
  // A path that a rule cannot hold is refused before any process starts.
  for (const path of [
    'relative/CLAUDE.md',
    '/home/me (work)/CLAUDE.md',
    '/home/me/\nCLAUDE.md',
  ])
    await assert.rejects(
      runHarness(
        {
          host: 'claude',
          cwd: tmpdir(),
          prompt: 'x',
          signal: new AbortController().signal,
          ownFiles: [path],
        },
        { executable: join(tmpdir(), 'no-such-host') },
      ),
      /absolute path without parentheses or control characters/,
    );
});

await test('Verifold stops a Codex call that may read no files at its first command, before Codex reads the output', async () => {
  await fixture(
    `const { writeFileSync } = require('node:fs');
     const args = process.argv.slice(2);
     if (args.includes('mcp')) console.log('[]');
     else {
       process.stdin.resume(); process.stdin.on('end', () => {
         console.log(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'cat ~/.codex/auth.json' } }));
         // A Codex that went on would write this after the command.
         setTimeout(() => { writeFileSync('went-on', ''); console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{}' } })); }, 2000);
       });
     }`,
    async (executable, cwd) => {
      await assert.rejects(
        runHarness(
          {
            host: 'codex',
            cwd,
            prompt: 'What do you know about the person?',
            signal: new AbortController().signal,
            ownFiles: [],
          },
          { executable },
        ),
        /Codex started a command or a tool/,
      );
      await delay(2500);
      await assert.rejects(readFile(join(cwd, 'went-on')), { code: 'ENOENT' });
    },
  );
});

for (const [what, servers] of [
  ['its MCP servers cannot be listed', `process.exit(1);`],
  ['the list is not JSON', `console.log('github  enabled');`],
  [
    'a server name cannot be turned off with -c',
    `console.log(JSON.stringify([{ name: 'my.server', enabled: true }]));`,
  ],
] as const)
  await test(`when ${what}, a text-only Codex call with text from outside does not run, and one without runs with every other limit`, async () => {
    await fixture(textOnlyHost(servers), async (executable, cwd) => {
      const request = {
        host: 'codex' as const,
        cwd,
        prompt: 'Pick skills.',
        signal: new AbortController().signal,
        textOnly: true,
      };
      await assert.rejects(
        runHarness({ ...request, outsideText: true }, { executable }),
        /did not run this request/,
      );
      await assert.rejects(readFile(join(cwd, 'ran')), { code: 'ENOENT' });
      // The person's own text, as in the About-you chat: the call runs, with plugins, apps and web search off and a read-only sandbox.
      const result = await runHarness(request, { executable });
      assert.deepEqual(JSON.parse(result.text), [
        ...appsOff,
        ...codexTextOnlyOptions,
        ...codexExecTail,
      ]);
    });
  });

await test('a list of MCP servers is used again for a minute, and its process reports itself as the call does', async () => {
  await fixture(
    textOnlyHost(
      `console.log(JSON.stringify([{ name: 'github', enabled: true }]));`,
    ),
    async (executable, cwd) => {
      const pids: number[] = [];
      const request = {
        host: 'codex' as const,
        cwd,
        prompt: 'Pick skills.',
        signal: new AbortController().signal,
        textOnly: true,
        outsideText: true,
        onSpawn: (pid: number) => pids.push(pid),
      };
      await runHarness(request, { executable });
      // The listing and the call each report their process.
      assert.equal(pids.length, 2);
      await runHarness(request, { executable });
      assert.equal(await readFile(join(cwd, 'mcp-count'), 'utf8'), 'x');
      assert.equal(pids.length, 3);
    },
  );
});

await test('the listing of MCP servers counts in the time of the call', async () => {
  await fixture(
    textOnlyHost(
      `setTimeout(() => console.log(JSON.stringify([])), 600);`,
      900,
    ),
    async (executable, cwd) => {
      // The call alone takes 900 ms, inside 1200 ms. After a listing of 600 ms, it is not.
      await assert.rejects(
        runHarness(
          {
            host: 'codex',
            cwd,
            prompt: 'Pick skills.',
            signal: new AbortController().signal,
            textOnly: true,
            timeoutMs: 1_200,
          },
          { executable },
        ),
        HarnessTimeoutError,
      );
    },
  );
});

await test('a text-only Codex call cancelled while it lists the MCP servers stops as a cancelled call does', async () => {
  await fixture(
    textOnlyHost(`setTimeout(() => {}, 10_000);`),
    async (executable, cwd) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      await assert.rejects(
        runHarness(
          {
            host: 'codex',
            cwd,
            prompt: 'Pick skills.',
            signal: controller.signal,
            textOnly: true,
          },
          { executable },
        ),
        /Harness request was cancelled/,
      );
      await assert.rejects(readFile(join(cwd, 'ran')), { code: 'ENOENT' });
    },
  );
});

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

await test('a line above the limit stops an active child', async () => {
  await fixture(
    "process.stdin.resume(); process.stdout.write('x'.repeat(9 * 1024 * 1024)); setInterval(() => {}, 1000);",
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

await test('the ceiling stops a child that keeps sending', async () => {
  await fixture(
    "process.stdin.resume(); process.on('SIGTERM', () => {}); setInterval(() => console.log(JSON.stringify({ type: 'system' })), 20);",
    async (executable, cwd) => {
      await assert.rejects(
        runHarness(
          {
            host: 'claude',
            cwd,
            prompt: '',
            signal: new AbortController().signal,
            timeoutMs: 500,
            idleMs: 5000,
          },
          { executable },
        ),
        (error: unknown) =>
          error instanceof HarnessTimeoutError &&
          /ran for 1 second, the longest that one call can run/.test(
            error.message,
          ),
      );
    },
  );
});

await test('a quiet child stops after the idle limit', async () => {
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
            idleMs: 200,
          },
          { executable },
        ),
        (error: unknown) =>
          error instanceof HarnessTimeoutError &&
          /sent nothing for 1 second/.test(error.message),
      );
    },
  );
});

await test('each line of output starts the idle limit again', async () => {
  await fixture(
    `process.stdin.resume(); let n = 0;
     console.log(JSON.stringify({ type: 'system' }));
     const timer = setInterval(() => {
       n += 1;
       if (n < 5) return console.log(JSON.stringify({ type: 'system' }));
       clearInterval(timer);
       console.log(JSON.stringify({ result: 'done', is_error: false }));
       process.exit(0);
     }, 1000);`,
    async (executable, cwd) => {
      // Five quiet periods of 1 s add up to more than the 4 s idle limit. A slow start of the child under load has 4 s.
      const result = await runHarness(
        {
          host: 'claude',
          cwd,
          prompt: '',
          signal: new AbortController().signal,
          idleMs: 4000,
        },
        { executable },
      );
      assert.equal(result.text, 'done');
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
      const notices: string[] = [];
      const result = await runHarness(
        {
          host: 'claude',
          cwd,
          prompt: '',
          signal: new AbortController().signal,
          onActivity: (message, kind) => {
            messages.push(message);
            if (kind === 'notice') notices.push(message);
          },
        },
        { executable },
      );
      // Only denials need the person. The terminal shows notices and leaves events to the desk.
      assert.ok(notices.length > 0);
      assert.ok(notices.every((message) => message.includes('denied')));
      const printed: string[] = [];
      const progress = activityProgress((value, source) => {
        if (source !== 'tool') printed.push(value);
      });
      for (const message of messages)
        progress(message, notices.includes(message) ? 'notice' : 'event');
      assert.deepEqual(printed, notices);
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

await test('a harness gets neither the session variables of a parent Claude Code nor RunPod variables', async () => {
  await fixture(
    `process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ result: JSON.stringify({ child: process.env.CLAUDE_CODE_CHILD_SESSION ?? null, token: process.env.CLAUDE_CODE_MESSAGING_TOKEN ?? null, runpod: Object.keys(process.env).filter((name) => name.startsWith('RUNPOD_')), kept: process.env.VERIFOLD_KEEP ?? null }) })));`,
    async (executable, cwd) => {
      const saved = { ...process.env };
      process.env.CLAUDE_CODE_CHILD_SESSION = '1';
      process.env.CLAUDE_CODE_MESSAGING_TOKEN = 'parent-token';
      process.env.RUNPOD_API_KEY = 'test-runpod-key';
      process.env.RUNPOD_POD_ID = 'pod-1';
      process.env.VERIFOLD_KEEP = 'yes';
      try {
        const result = await runHarness(
          {
            host: 'claude',
            cwd,
            prompt: '',
            signal: new AbortController().signal,
          },
          { executable },
        );
        assert.deepEqual(JSON.parse(result.text), {
          child: null,
          token: null,
          runpod: [],
          kept: 'yes',
        });
      } finally {
        for (const name of [
          'CLAUDE_CODE_CHILD_SESSION',
          'CLAUDE_CODE_MESSAGING_TOKEN',
          'RUNPOD_API_KEY',
          'RUNPOD_POD_ID',
          'VERIFOLD_KEEP',
        ])
          if (saved[name] === undefined) delete process.env[name];
          else process.env[name] = saved[name];
      }
    },
  );
});
