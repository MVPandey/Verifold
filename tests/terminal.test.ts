import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { terminalBanner, terminalPrompt } from '../src/cli/terminal.ts';
import { initializeProject, parseAutonomy } from '../src/cli/initialization.ts';

await test('terminal branding respects noninteractive output and NO_COLOR', () => {
  assert.equal(terminalBanner(false, false), '');
  assert.match(terminalBanner(true, true), /V E R I F O L D/);
  assert.equal(terminalBanner(true, true).includes('\u001b'), false);
  assert.equal(
    terminalBanner(true, false).startsWith('\u001b[38;5;141m'),
    true,
  );
  assert.equal(terminalPrompt('Topic: ', false), 'Topic: ');
  assert.match(terminalPrompt('Topic: ', true), /Topic: /);
  assert.equal(
    terminalPrompt('\u001b[2JApprove?\u001b]0;hidden\u0007', false),
    'Approve?',
  );
});

await test('guided initialization collects a broad topic without launching research', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-initialization-'));
  const answers = [
    'Ada',
    'Mathematics',
    '',
    '',
    '',
    'codex',
    'Formal proof search',
    '',
  ];
  try {
    const result = await initializeProject(
      root,
      root,
      {},
      {
        interactive: true,
        ask: (): Promise<string> => Promise.resolve(answers.shift() ?? ''),
        out: (): void => {
          assert.fail('Initialization must return data to its caller.');
        },
      },
      new AbortController().signal,
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
        { host: 'unknown' },
        {
          ...io,
          ask: (): Promise<string> => Promise.resolve(answers.shift() ?? ''),
        },
        new AbortController().signal,
      ),
      /supports --host claude or --host codex/,
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
