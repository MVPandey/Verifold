import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProject } from '../src/cli/initialization.ts';
import { runResearch } from '../src/cli/research.ts';
import { loadWorkspace } from '../src/cli/storage.ts';
import type { CliIO } from '../src/cli/commands.ts';
import type { HarnessRequest, HarnessResult } from '../src/cli/harness.ts';

function prompts(answers: readonly string[]): {
  io: CliIO;
  questions: string[];
  messages: string[];
  remaining: string[];
} {
  const remaining = [...answers];
  const questions: string[] = [];
  const messages: string[] = [];
  return {
    questions,
    messages,
    remaining,
    io: {
      interactive: true,
      ask: (question): Promise<string> => {
        questions.push(question);
        const answer = remaining.shift();
        assert.notEqual(answer, undefined, `Unexpected prompt: ${question}`);
        return Promise.resolve(answer ?? '');
      },
      out: (message): void => {
        messages.push(message);
      },
      progress: (message): void => {
        messages.push(message);
      },
    },
  };
}

const signal = (): AbortSignal => new AbortController().signal;
const unusedHost = (): Promise<HarnessResult> =>
  Promise.reject(new Error('Personalization must not launch a harness.'));
const brief =
  'Study tiny graph search to understand heuristic failures. CPU only; compare deterministic baselines. Background unknown.';
const readyHost = (): Promise<HarnessResult> =>
  Promise.resolve({ text: JSON.stringify({ question: null, brief }) });
const plan = {
  scope: 'Compare search over a fixed tiny graph.',
  personas: [
    { name: 'Historian', task: 'Find established graph search baselines.' },
    { name: 'Skeptic', task: 'Check whether the comparison adds information.' },
  ],
};

await test('init asks the research question first and carries its adaptive brief into research', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agencyDir = join(root, 'agency');
  const ui = prompts(['Tiny graph search', 'codex', '', 'skip', '', '', '']);
  const initialized = await initializeProject(
    root,
    root,
    { agencyDir },
    ui.io,
    signal(),
    readyHost,
  );
  assert.match(ui.questions[0] ?? '', /^What do you want to work on\? $/);
  assert.doesNotMatch(
    ui.questions.join('\n'),
    /your name|scholar|openreview|github profile/i,
  );
  assert.deepEqual(ui.remaining, []);
  assert.equal(initialized.workspace.host, 'codex');
  assert.equal(initialized.workspace.context, brief);
  assert.equal(initialized.workspace.visibility, 'private');
  assert.deepEqual(initialized.research, {
    topic: 'Tiny graph search',
    autonomy: 'guided',
  });
  assert.deepEqual((await loadWorkspace(root)).profile.interests, [
    'Computational research',
  ]);
  assert.ok(!(await readdir(agencyDir)).includes('USER.md'));
  assert.match(ui.messages.join('\n'), /No personal research context saved/);
  const requests: HarnessRequest[] = [];
  const research = await runResearch(
    root,
    initialized.research ?? {},
    prompts(['n']).io,
    signal(),
    (request) => {
      requests.push(request);
      return Promise.resolve({ text: JSON.stringify(plan) });
    },
  );
  assert.equal(research.research?.phase, 'awaiting-plan-review');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.host, 'codex');
  assert.match(requests[0]?.prompt ?? '', /heuristic failures/);
});

await test('reviewed context and model are reused in another project and reach its harness', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-init-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agencyDir = join(root, 'agency');
  const first = join(root, 'first');
  const second = join(root, 'second');
  await mkdir(first);
  await mkdir(second);
  const context =
    'I study graph algorithms and prefer small deterministic experiments.';
  const onboarding = prompts(['claude', 'sonnet', 'write', context, 'yes']);
  await initializeProject(
    first,
    root,
    { agencyDir, setupOnly: true },
    onboarding.io,
    signal(),
    unusedHost,
  );
  assert.deepEqual(onboarding.remaining, []);
  assert.equal(await readFile(join(agencyDir, 'USER.md'), 'utf8'), context);
  assert.match(onboarding.messages.join('\n'), /Full profile:/);
  const returning = prompts(['Tiny graph search', '', '', '', '', 'guided']);
  const initialized = await initializeProject(
    second,
    root,
    { agencyDir },
    returning.io,
    signal(),
    (request) => {
      assert.ok(request.prompt.includes(context));
      return Promise.resolve({
        text: JSON.stringify({ question: null, brief: context }),
      });
    },
  );
  assert.deepEqual(returning.remaining, []);
  assert.match(returning.questions[1] ?? '', /\[claude\]/);
  assert.match(returning.questions[2] ?? '', /\[sonnet\]/);
  assert.doesNotMatch(returning.questions.join('\n'), /Personalize/);
  assert.equal(initialized.workspace.context, context);
  assert.equal(initialized.workspace.model, 'sonnet');
  const requests: HarnessRequest[] = [];
  await runResearch(
    second,
    initialized.research ?? {},
    prompts(['n']).io,
    signal(),
    (request) => {
      requests.push(request);
      return Promise.resolve({ text: JSON.stringify(plan) });
    },
  );
  assert.equal(requests[0]?.host, 'claude');
  assert.equal(requests[0]?.model, 'sonnet');
  assert.ok(requests[0]?.prompt.includes(context));
  assert.match(requests[0]?.prompt ?? '', /background only, not authorization/);
});

for (const outcome of ['accept', 'reject', 'decline', 'failure'] as const) {
  await test(`normal onboarding profile import: ${outcome}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'verifold-init-import-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const agencyDir = join(root, 'agency');
    const source = join(root, 'memory.txt');
    const background = 'I prefer deterministic graph experiments.';
    // A declined source stays absent, so an attempted read would fail.
    if (outcome !== 'decline') await writeFile(source, background);
    const ui = prompts([
      'Graph search',
      'codex',
      'chosen-model',
      'import',
      source,
      outcome === 'decline' ? 'no' : 'yes',
      ...(outcome === 'accept' || outcome === 'reject'
        ? [outcome === 'accept' ? 'yes' : 'no']
        : []),
      '',
      '',
      'guided',
    ]);
    const requests: HarnessRequest[] = [];
    const initialized = await initializeProject(
      root,
      root,
      { agencyDir },
      ui.io,
      signal(),
      (request) => {
        requests.push(request);
        if (outcome !== 'decline' && requests.length === 1) {
          assert.ok(request.prompt.includes(background));
          assert.equal(request.model, 'chosen-model');
          if (outcome === 'failure')
            return Promise.reject(new Error('PRIVATE_SOURCE_CONTENT'));
          return Promise.resolve({ text: background });
        }
        assert.equal(request.prompt.includes(background), outcome === 'accept');
        return Promise.resolve({
          text: JSON.stringify({
            question: null,
            brief: outcome === 'accept' ? `${brief} ${background}` : brief,
          }),
        });
      },
    );
    assert.deepEqual(ui.remaining, []);
    assert.match(ui.questions[0] ?? '', /^What do you want to work on\?/);
    assert.doesNotMatch(
      ui.questions.join('\n'),
      /Build a profile with my agent/,
    );
    assert.equal(requests.length, outcome === 'decline' ? 1 : 2);
    assert.doesNotMatch(ui.messages.join('\n'), /PRIVATE_SOURCE_CONTENT/);
    if (outcome === 'accept') {
      assert.equal(
        await readFile(join(agencyDir, 'USER.md'), 'utf8'),
        background,
      );
      await runResearch(
        root,
        initialized.research ?? {},
        prompts(['n']).io,
        signal(),
        (request) => {
          assert.ok(request.prompt.includes(background));
          return Promise.resolve({ text: JSON.stringify(plan) });
        },
      );
    } else {
      await assert.rejects(readFile(join(agencyDir, 'USER.md')), {
        code: 'ENOENT',
      });
      assert.equal(initialized.workspace.context, brief);
      if (outcome === 'decline')
        assert.doesNotMatch(
          ui.messages.join('\n'),
          /Profile setup did not finish/,
        );
      if (outcome === 'failure')
        assert.match(ui.messages.join('\n'), /continue research without it/);
    }
  });
}

await test('a failed memory import leaves a usable project without leaking the host error', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-init-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agencyDir = join(root, 'agency');
  const source = join(root, 'selected-memory.md');
  await writeFile(source, 'I prefer reproducible graph benchmarks.');
  const ui = prompts(['claude', '', 'import', source, 'yes']);
  let calls = 0;
  const initialized = await initializeProject(
    root,
    root,
    { agencyDir, setupOnly: true },
    ui.io,
    signal(),
    () => {
      calls++;
      return Promise.reject(new Error('PRIVATE_SOURCE_CONTENT'));
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(ui.remaining, []);
  assert.equal(initialized.workspace.context, undefined);
  assert.equal(initialized.research, null);
  assert.ok(!(await readdir(agencyDir)).includes('USER.md'));
  assert.match(ui.messages.join('\n'), /No new memory was adopted/);
  assert.doesNotMatch(ui.messages.join('\n'), /PRIVATE_SOURCE_CONTENT/);
  assert.equal((await loadWorkspace(root)).host, 'claude');
});

await test('invalid model is rejected before creating agency or workspace state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-init-model-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agencyDir = join(root, 'agency');
  await assert.rejects(
    initializeProject(
      root,
      root,
      {
        agencyDir,
        host: 'codex',
        model: '--unsafe flag',
        setupOnly: true,
      },
      { ...prompts([]).io, interactive: false },
      signal(),
      unusedHost,
    ),
    /valid identifier/,
  );
  assert.deepEqual(await readdir(root), []);
});

await test('legacy JSON profile imports never create or inspect the agency directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-init-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agencyDir = join(root, 'agency-must-stay-a-file');
  await writeFile(agencyDir, 'Unrelated data');
  const profile = {
    name: 'Ada',
    interests: ['Math'],
    scholar: '',
    github: '',
    session: '',
  };
  await writeFile(join(root, 'profile.json'), JSON.stringify(profile));
  const initialized = await initializeProject(
    root,
    root,
    {
      agencyDir,
      profile: 'profile.json',
      setupOnly: true,
    },
    { ...prompts([]).io, interactive: false },
    signal(),
    unusedHost,
  );
  assert.deepEqual(initialized.workspace.profile, profile);
  assert.equal(initialized.research, null);
  assert.equal(await readFile(agencyDir, 'utf8'), 'Unrelated data');
});

await test('adaptive onboarding creates a selected nested project and preserves existing folder contents', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'verifold-adaptive-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'research projects', 'graph');
  await mkdir(join(root, 'literature'), { recursive: true });
  await writeFile(join(root, 'literature', 'existing.md'), 'Prior notes');
  const ui = prompts([
    'Graph search',
    'codex',
    'chosen-model',
    'skip',
    'Understand heuristic failures',
    'CPU only',
    '',
    'research projects/graph',
    'guided',
  ]);
  const requests: HarnessRequest[] = [];
  const initialized = await initializeProject(
    base,
    base,
    { agencyDir: join(base, 'agency') },
    ui.io,
    signal(),
    (request) => {
      requests.push(request);
      return Promise.resolve({
        sessionId: 'interview-session',
        text: JSON.stringify({
          question:
            requests.length === 1
              ? 'Why does graph search matter to you?'
              : requests.length === 2
                ? 'What resources can test those failures?'
                : null,
          brief,
        }),
      });
    },
  );
  assert.equal(initialized.root, root);
  assert.equal(requests[1]?.sessionId, 'interview-session');
  assert.match(requests[1]?.prompt ?? '', /Understand heuristic failures/);
  assert.match(requests[2]?.prompt ?? '', /CPU only/);
  assert.equal(requests[0]?.model, 'chosen-model');
  assert.deepEqual(ui.remaining, []);
  for (const name of [
    'literature',
    'experiments',
    'results',
    'figures',
    'docs',
    'agents',
  ])
    assert.ok((await stat(join(root, name))).isDirectory());
  assert.equal(
    await readFile(join(root, 'literature', 'existing.md'), 'utf8'),
    'Prior notes',
  );
  assert.match(
    await readFile(join(root, '.verifold.md'), 'utf8'),
    /heuristic failures/,
  );
  assert.match(
    await readFile(join(root, '.gitignore'), 'utf8'),
    /\/\.verifold\.md/,
  );
  assert.equal((await stat(join(root, '.verifold.md'))).mode & 0o777, 0o600);
  await assert.rejects(loadWorkspace(base), /ENOENT/);
  await assert.rejects(
    initializeProject(
      root,
      base,
      {
        host: 'codex',
        topic: 'Other',
        agencyDir: join(base, 'agency'),
        workspaceSpecified: true,
      },
      prompts([]).io,
      signal(),
      unusedHost,
    ),
    /already exists/,
  );
});

for (const collision of ['.verifold.md', 'experiments']) {
  await test(`init refuses an existing ${collision} file before calling the harness`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'verifold-collision-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, collision), 'Keep this');
    await assert.rejects(
      initializeProject(
        root,
        root,
        { host: 'codex', setupOnly: true, agencyDir: join(root, 'agency') },
        { ...prompts([]).io, interactive: false },
        signal(),
        unusedHost,
      ),
      /refusing to overwrite/,
    );
    assert.equal(await readFile(join(root, collision), 'utf8'), 'Keep this');
  });
}

await test('scaffold refuses directory symlinks without modifying their targets', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'verifold-link-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project');
  const target = join(base, 'target');
  await mkdir(root);
  await mkdir(target);
  await symlink(target, join(root, 'agents'));
  await assert.rejects(
    initializeProject(
      root,
      base,
      { host: 'codex', setupOnly: true },
      { ...prompts([]).io, interactive: false },
      signal(),
      unusedHost,
    ),
    /real directory/,
  );
  assert.deepEqual(await readdir(target), []);
});

await test('the CLI researches in the interactively selected directory using the accepted brief', async (t) => {
  const { runCli } = await import('../src/cli/commands.ts');
  const base = await mkdtemp(join(tmpdir(), 'verifold-full-init-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'chosen project');
  const ui = prompts([
    'Tiny graph search',
    'codex',
    '',
    'skip',
    '',
    'chosen project',
    'autonomous',
  ]);
  const requests: HarnessRequest[] = [];
  await runCli(
    ['init', '--agency-dir', join(base, 'agency')],
    base,
    ui.io,
    signal(),
    (request) => {
      requests.push(request);
      if (requests.length === 1) return readyHost();
      assert.equal(request.cwd, root);
      assert.ok(request.prompt.includes(brief));
      return Promise.resolve({
        text: JSON.stringify(
          requests.length === 2
            ? plan
            : {
                summary: 'Compare heuristics against a deterministic baseline.',
                delegation: 'Fixture; no native delegation.',
                sources: [
                  { title: 'A', url: 'https://example.org/a' },
                  { title: 'B', url: 'https://example.org/b' },
                ],
                candidates: [
                  {
                    id: 'graph',
                    title: 'Graph search comparison',
                    recommendation: 'Bounded CPU comparison',
                    gates: ['Match the exact solution'],
                    sources: ['https://example.org/a'],
                  },
                ],
              },
        ),
        sessionId: 'research-session',
      });
    },
  );
  assert.equal(requests.length, 3);
  assert.deepEqual(ui.remaining, []);
  assert.ok(
    ui.messages.some((message) =>
      message.includes(`Private workspace: ${root}`),
    ),
  );
  assert.equal((await loadWorkspace(root)).research?.phase, 'directions');
  assert.equal((await loadWorkspace(root)).candidates[0]?.id, 'graph');
  assert.equal(requests[2]?.sessionId, 'research-session');
});

await test('concurrent project creation has one winner with an intact scaffold', async (t) => {
  const { createProject } = await import('../src/cli/project.ts');
  const base = await mkdtemp(join(tmpdir(), 'verifold-concurrent-init-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project');
  const workspace = {
    schemaVersion: 1,
    visibility: 'private',
    profile: {
      name: 'Researcher',
      interests: ['Graphs'],
      scholar: '',
      github: '',
      session: '',
    },
    host: 'codex',
    candidates: [],
    selectedId: null,
  } as const;
  const results = await Promise.allSettled([
    createProject(root, workspace, 'First', 'First brief', signal()),
    createProject(root, workspace, 'Second', 'Second brief', signal()),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  assert.equal((await loadWorkspace(root)).host, 'codex');
  assert.ok(
    (await readFile(join(root, '.verifold.md'), 'utf8')).includes('brief'),
  );
  for (const name of [
    'literature',
    'experiments',
    'results',
    'figures',
    'docs',
    'agents',
  ])
    assert.ok((await stat(join(root, name))).isDirectory());
});

await test('failed preparation rolls back before releasing the workspace lock', async (t) => {
  const { changeWorkspace } = await import('../src/cli/storage.ts');
  const base = await mkdtemp(join(tmpdir(), 'verifold-rollback-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const marker = join(base, '.verifold.md');
  await assert.rejects(
    changeWorkspace(
      base,
      () => ({
        schemaVersion: 1,
        visibility: 'private',
        profile: {
          name: 'Researcher',
          interests: ['Graphs'],
          scholar: '',
          github: '',
          session: '',
        },
        host: 'codex',
        candidates: [],
        selectedId: null,
      }),
      {
        apply: async () => {
          await writeFile(marker, 'Partial draft');
          throw new Error('Preparation interrupted');
        },
        rollback: async () => {
          assert.ok(
            (await stat(join(base, '.verifold', 'write.lock'))).isFile(),
          );
          await rm(marker);
        },
      },
    ),
    /Preparation interrupted/,
  );
  await assert.rejects(loadWorkspace(base), /ENOENT/);
  await assert.rejects(stat(marker), /ENOENT/);
  await assert.rejects(stat(join(base, '.verifold', 'write.lock')), /ENOENT/);
});

await test('an invalid onboarding response does not create project state or scaffold', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'verifold-bad-interview-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'project');
  await assert.rejects(
    initializeProject(
      root,
      base,
      {
        host: 'codex',
        model: 'default',
        topic: 'Graphs',
        workspaceSpecified: true,
        agencyDir: join(base, 'agency'),
      },
      prompts(['skip']).io,
      signal(),
      () => Promise.resolve({ text: 'invalid JSON' }),
    ),
  );
  await assert.rejects(stat(root), /ENOENT/);
});
