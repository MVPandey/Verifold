import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextFiles } from '../src/cli/context-files.ts';
import { investigateProject } from '../src/cli/project-context.ts';
import { personalize, loadMemory } from '../src/cli/agency.ts';
import type { CliIO } from '../src/cli/commands.ts';
const signal = (): AbortSignal => new AbortController().signal;
function ui(answers: string[]): CliIO {
  return {
    interactive: true,
    out: () => {},
    progress: () => {},
    ask: () => {
      const answer = answers.shift();
      assert.notEqual(answer, undefined, 'Unexpected prompt');
      return Promise.resolve(answer ?? '');
    },
  };
}

await test('project evidence excludes hidden files, code, links, and nested content', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'README.md'), 'Known project purpose');
  await writeFile(join(root, '.env'), 'PRIVATE_ENV');
  await writeFile(join(root, 'main.ts'), 'PRIVATE_CODE');
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested', 'README.md'), 'PRIVATE_NESTED');
  await symlink(join(root, '.env'), join(root, 'AGENTS.md'));
  const evidence = await contextFiles(root, 'project', signal());
  assert.match(evidence, /Known project purpose/);
  assert.doesNotMatch(evidence, /PRIVATE_/);
  await assert.rejects(contextFiles(root, 'project', AbortSignal.abort()));
});

await test('chat import is consented, bounded, reviewed, and reused as a profile', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-chat-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'chats');
  const agency = join(root, 'agency');
  let calls = 0;
  assert.equal(
    await personalize(
      agency,
      root,
      { host: 'claude' },
      ui(['history', source, 'no']),
      signal(),
      () => {
        assert.fail('Declining must not invoke the host');
      },
    ),
    undefined,
  );
  await mkdir(source);
  for (let i = 0; i < 12; i++)
    await writeFile(
      join(source, `${i}.jsonl`),
      JSON.stringify({ role: 'user', content: 'I work on graph algorithms.' }),
    );
  await writeFile(join(source, 'huge.txt'), 'x'.repeat(256001));
  const result = await personalize(
    agency,
    root,
    { host: 'claude' },
    ui(['history', source, 'yes', 'yes']),
    signal(),
    (request) => {
      calls++;
      assert.match(request.prompt, /graph algorithms/);
      assert.match(request.prompt, /10 files/);
      assert.doesNotMatch(request.prompt, /x{100}/);
      return Promise.resolve({
        text: 'Works on graph algorithms. Other preferences remain unknown.',
      });
    },
  );
  assert.equal(calls, 1);
  assert.equal(await loadMemory(agency), result);
  await personalize(
    agency,
    root,
    { host: 'claude' },
    ui(['history', source, 'yes', 'no']),
    signal(),
    () => Promise.resolve({ text: 'Unapproved replacement' }),
  );
  assert.equal(await loadMemory(agency), result);
});

await test('existing project investigation requires consent and review and preserves the brief on failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-project-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'README.md'),
    'A library for attribution stability.',
  );
  const original = '# Research brief\n\nStudy J-Lens/SHAPley.';
  const agency = { host: 'claude' } as const;
  assert.equal(
    await investigateProject(
      root,
      original,
      agency,
      ui(['no']),
      signal(),
      () => {
        assert.fail('No consent');
      },
    ),
    original,
  );
  const draft =
    '# Research brief\n\nStudy attribution stability in J-Lens/SHAPley.';
  for (const accepted of ['yes', 'no']) {
    const result = await investigateProject(
      root,
      original,
      agency,
      ui(['yes', accepted]),
      signal(),
      (request) => {
        assert.equal(request.cwd, root);
        assert.match(request.prompt, /native read tools/);
        assert.match(request.prompt, /web search and native subagents/);
        assert.match(request.prompt, /Do not edit files, install software/);
        assert.match(request.prompt, /attribution stability/);
        assert.match(request.prompt, /J-Lens\/SHAPley/);
        return Promise.resolve({ text: draft });
      },
    );
    assert.equal(result, accepted === 'yes' ? draft : original);
  }
  assert.equal(
    await investigateProject(
      root,
      original,
      agency,
      ui(['yes']),
      signal(),
      () => Promise.reject(new Error('PRIVATE_FAILURE')),
    ),
    original,
  );
});

await test('a project without top-level documentation can still ask its harness to inspect existing work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-code-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'paper'));
  await writeFile(join(root, 'paper', 'main.tex'), 'Paper evidence');
  let called = false;
  const draft = 'The paper needs a causal control.';
  assert.equal(
    await investigateProject(
      root,
      'Find a pilot',
      { host: 'claude' },
      ui(['yes', 'yes']),
      signal(),
      (request) => {
        called = true;
        assert.equal(request.cwd, root);
        assert.match(request.prompt, /native read tools/);
        return Promise.resolve({ text: draft });
      },
    ),
    draft,
  );
  assert.equal(called, true);
});

await test('native chat evidence retains user text and excludes model and tool messages', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-user-chat-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'session.jsonl'),
    [
      {
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'I prefer small deterministic tests.' },
            { type: 'tool_result', content: 'PRIVATE_TOOL_RESULT' },
          ],
        },
      },
      { message: { role: 'assistant', content: 'INVENTED_BIOGRAPHY' } },
      {
        type: 'response_item',
        payload: {
          role: 'user',
          content: [{ type: 'input_text', text: 'I work in TypeScript.' }],
        },
      },
      {
        type: 'response_item',
        payload: { role: 'tool', content: 'PRIVATE_TOOL_OUTPUT' },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n'),
  );
  await mkdir(join(root, 'subagents'));
  await writeFile(
    join(root, 'subagents', 'agent.jsonl'),
    JSON.stringify({ message: { role: 'user', content: 'PRIVATE_SUBAGENT' } }),
  );
  const evidence = await contextFiles(root, 'chats', signal());
  assert.match(evidence, /deterministic tests/);
  assert.match(evidence, /TypeScript/);
  assert.doesNotMatch(evidence, /PRIVATE_|INVENTED_/);
});
