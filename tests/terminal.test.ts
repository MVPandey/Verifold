import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { terminalBanner, tint, terminalMessage } from '../src/cli/terminal.ts';
import { visibleWidth } from '../src/cli/terminal-layout.ts';
import { paragraph, terminalMenu } from '../src/cli/terminal.ts';
import { initializeProject, parseAutonomy } from '../src/cli/initialization.ts';

await test('terminal branding respects noninteractive output and NO_COLOR', () => {
  assert.equal(terminalBanner(false, false), '');
  assert.match(terminalBanner(true, true), /verifold/);
  assert.equal(terminalBanner(true, true).includes('\u001b'), false);
  assert.equal(
    terminalBanner(true, false).includes('\u001b[38;2;124;58;237m'),
    true,
  );
  assert.equal(tint('Topic: ', false), 'Topic: ');
  assert.match(tint('Topic: ', true), /Topic: /);
  assert.equal(
    tint('\u001b[2JApprove?\u001b]0;hidden\u0007', false),
    'Approve?',
  );
});

await test('terminal messages distinguish headings and success without trusting escape sequences', () => {
  const message = '# Research brief\n\nPlain body\n✓ Accepted\u001b[2J';
  assert.equal(terminalMessage(message, false).includes('\u001b'), false);
  const styled = terminalMessage(message, true);
  assert.match(styled, /96;165;250/);
  assert.match(styled, /52;211;153/);
  assert.equal(styled.includes('\u001b[2J'), false);
  for (const line of terminalMessage(message, true, 24).split('\n'))
    assert.ok(visibleWidth(line) < 24);
});

await test('guided initialization collects a broad topic without launching research', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-initialization-'));
  const answers = ['codex', '', 'skip', '', 'Formal proof search', '', ''];
  try {
    const result = await initializeProject(
      root,
      root,
      { agencyDir: join(root, 'agency') },
      {
        interactive: true,
        ask: (): Promise<string> => Promise.resolve(answers.shift() ?? ''),
        out: (): void => {
          assert.fail('Initialization must return data to its caller.');
        },
      },
      new AbortController().signal,
      () =>
        Promise.resolve({
          text: '{"question":null,"brief":"Formal proof search with explicit unknowns."}',
        }),
    );
    assert.equal(answers.length, 0);
    assert.equal(result.workspace.host, 'codex');
    assert.deepEqual(result.research, {
      topic: 'Formal proof search',
      autonomy: 'guided',
    });
    assert.equal(result.workspace.selectedId, null);
    assert.equal(result.workspace.visibility, 'private');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('invalid harness and cancellation do not create a workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-initialization-'));
  const io = {
    interactive: true,
    ask: (): Promise<string> => Promise.resolve('Ada'),
    out: (): void => {},
  };
  try {
    const cancelled = AbortSignal.abort();
    await assert.rejects(initializeProject(root, root, {}, io, cancelled), {
      name: 'AbortError',
    });
    const answers = ['Ada', 'Math', '', '', ''];
    await assert.rejects(
      initializeProject(
        root,
        root,
        { host: 'unknown', agencyDir: join(root, 'agency') },
        {
          ...io,
          ask: (): Promise<string> => Promise.resolve(answers.shift() ?? ''),
        },
        new AbortController().signal,
      ),
      /Choose claude or codex/,
    );
    await assert.rejects(access(join(root, '.verifold')));
    assert.equal(parseAutonomy(undefined), 'guided');
    assert.throws(() => parseAutonomy('unlimited'), /guided or autonomous/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('noninteractive research requires explicit launch settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-initialization-'));
  try {
    await assert.rejects(
      initializeProject(
        root,
        root,
        { profile: 'profile.json' },
        {
          interactive: false,
          ask: (): Promise<string> =>
            Promise.reject(new Error('Unexpected prompt')),
          out: (): void => {},
        },
        new AbortController().signal,
      ),
      /requires --topic, --host claude\|codex, and --autonomy autonomous/,
    );
    await assert.rejects(access(join(root, '.verifold')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('welcome and paragraphs fit narrow and wide terminal widths', () => {
  for (const columns of [20, 39, 40, 60, 80, 120]) {
    for (const line of terminalBanner(true, false, columns).split('\n'))
      assert.ok(visibleWidth(line) < columns, line);
    for (const line of paragraph(
      '研究 👩‍💻 ' + 'long-path/'.repeat(30),
      columns,
    ).split('\n'))
      assert.ok(visibleWidth(line) < columns, line);
  }
  assert.ok(terminalBanner(true, true, 80).split('\n').length <= 12);
});

await test('menus fit short viewports and keep the current choice in place', () => {
  const choices = [
    {
      value: 'a',
      label: 'Claude Code',
      description: 'Uses your existing native harness tools and permissions.',
    },
    {
      value: 'b',
      label: 'Codex',
      description: 'Uses your existing native harness tools and permissions.',
    },
  ];
  for (const columns of [20, 40, 80])
    for (const rows of [6, 12, 24]) {
      const output = terminalMenu(
        'Choose your agent harness',
        choices,
        1,
        true,
        columns,
        rows,
      );
      assert.ok(output.split('\n').length <= rows - 2);
      for (const line of output.split('\n'))
        assert.ok(visibleWidth(line) < columns);
      assert.match(output, /Codex/);
    }
  const output = terminalMenu('Choose your agent harness', choices, 1, false);
  assert.match(output, /○ Claude Code\n {2}◆ Codex/);
  assert.ok(
    terminalBanner(true, true).split('\n').length + output.split('\n').length <=
      24,
  );
});
