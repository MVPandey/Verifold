import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli/commands.ts';
import { parseCandidates } from '../src/cli/contracts.ts';

await test('bare noninteractive launch requires an explicit command and does not create files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-launch-pipe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    runCli([], root, {
      interactive: false,
      ask: () => Promise.reject(new Error('Unexpected prompt')),
      out: () => {},
    }),
    /explicit command/,
  );
  await assert.rejects(readFile(join(root, '.verifold', 'workspace.json')), {
    code: 'ENOENT',
  });
});

await test('private CLI workflow preserves explicit selection and host ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-cli-'));
  const results: string[] = [];
  const io = {
    interactive: false,
    ask: (): Promise<string> => {
      return Promise.reject(new Error('Unexpected prompt'));
    },
    out: (text: string): void => {
      results.push(text);
    },
  };
  try {
    await assert.rejects(
      runCli(['init', '--setup-only'], root, io),
      /requires --host/,
    );
    await writeFile(
      join(root, 'profile.json'),
      JSON.stringify({
        name: 'Researcher',
        interests: ['Math', 'Security'],
        scholar: '',
        github: '',
        session: '',
      }),
    );
    await runCli(
      [
        'init',
        '--setup-only',
        '--profile',
        'profile.json',
        '--host',
        'my-host',
      ],
      root,
      io,
    );
    const state = await readFile(
      join(root, '.verifold', 'workspace.json'),
      'utf8',
    );
    assert.match(state, /"visibility": "private"/);
    assert.match(
      await readFile(join(root, '.gitignore'), 'utf8'),
      /\/\.verifold\//,
    );
    await assert.rejects(
      runCli(['init', '--setup-only', '--profile', 'profile.json'], root, io),
      /already exists/,
    );
    await assert.rejects(runCli(['handoff'], root, io), /Select an idea/);
    await assert.rejects(runCli(['literature'], root, io), /Select an idea/);
    await writeFile(
      join(root, 'ideas.json'),
      JSON.stringify([
        {
          id: 'proof',
          title: 'Proof search',
          recommendation: 'Try a bounded formalization pilot',
          gates: ['Proof kernel checks the theorem; no seed requirement'],
        },
      ]),
    );
    await runCli(['ideas', '--from', 'ideas.json'], root, io);
    await assert.rejects(runCli(['select'], root, io), /requires --id/);
    await assert.rejects(
      runCli(['select', '--id', 'missing'], root, io),
      /Choose an ID/,
    );
    await runCli(['select', '--id', 'proof'], root, io);
    await runCli(['literature'], root, io);
    assert.match(results.at(-1) ?? '', /literature-retention-request/);
    await runCli(['handoff'], root, io);
    assert.match(results.at(-1) ?? '', /"executionAuthorized":false/);
    await runCli(['literature', '--memory'], root, io);
    assert.match(results.at(-1) ?? '', /pdfs-and-markdown-context/);
    assert.match(results.at(-1) ?? '', /"executionStarted":false/);
    assert.match(
      results.at(-1) ?? '',
      /Link each Markdown file to its local PDF/,
    );
    await runCli(['view'], root, io);
    assert.match(
      await readFile(join(root, '.verifold', 'workspace.html'), 'utf8'),
      /Proof search/,
    );
    await assert.rejects(
      runCli(['ideas', '--from', 'ideas.json'], root, io),
      /selected idea already exists/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
await test('host recommendations require unique IDs and gates', () => {
  assert.throws(
    () =>
      parseCandidates([
        { id: 'x', title: 'x', recommendation: 'x', gates: [] },
      ]),
    /verification gates/,
  );
  const item = { id: 'x', title: 'x', recommendation: 'x', gates: ['check'] };
  assert.throws(() => parseCandidates([item, item]), /unique/);
});
await test('harness-first onboarding and recommendation choice use injected prompts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-prompts-'));
  const answers = ['claude', '', 'skip'];
  const messages: string[] = [];
  try {
    await runCli(
      [
        'init',
        '--setup-only',
        '--agency-dir',
        join(root, '.verifold', 'agency'),
      ],
      root,
      {
        interactive: true,
        ask: (): Promise<string> => Promise.resolve(answers.shift() ?? ''),
        out: (message): void => {
          messages.push(message);
        },
      },
    );
    assert.equal(answers.length, 0);
    assert.match(messages.join('\n'), /Private workspace:/);
    assert.match(messages.join('\n'), /Harness: claude/);
    assert.doesNotMatch(messages.join('\n'), /schemaVersion|scholar/);
    await writeFile(
      join(root, 'ideas.json'),
      JSON.stringify([
        {
          id: 'a',
          title: 'Theorem',
          recommendation: 'Mechanically checkable',
          gates: ['Kernel acceptance'],
        },
      ]),
    );
    await runCli(['ideas', '--from', 'ideas.json'], root, {
      interactive: false,
      ask: (): Promise<string> => Promise.resolve(''),
      out: (): void => {},
    });
    await runCli(['select'], root, {
      interactive: true,
      ask: (prompt): Promise<string> => {
        assert.match(prompt, /Mechanically checkable/);
        return Promise.resolve('a');
      },
      out: (): void => {},
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
