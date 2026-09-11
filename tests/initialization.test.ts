import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
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
const plan = {
  scope: 'Compare search over a fixed tiny graph.',
  personas: [
    { name: 'Historian', task: 'Find established graph search baselines.' },
    { name: 'Skeptic', task: 'Check whether the comparison adds information.' },
  ],
};

await test('init starts with harness choice and permits research without personal context', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agencyDir = join(root, 'agency');
  const ui = prompts(['codex', '', 'skip', 'Tiny graph search', '']);
  const initialized = await initializeProject(
    root,
    root,
    { agencyDir },
    ui.io,
    signal(),
    unusedHost,
  );
  assert.match(ui.questions[0] ?? '', /agent harness/);
  assert.doesNotMatch(
    ui.questions.join('\n'),
    /your name|scholar|openreview|github profile/i,
  );
  assert.deepEqual(ui.remaining, []);
  assert.equal(initialized.workspace.host, 'codex');
  assert.equal(initialized.workspace.context, undefined);
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
  assert.match(requests[0]?.prompt ?? '', /No personal context provided/);
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
  const returning = prompts(['', '', 'Tiny graph search', 'guided']);
  const initialized = await initializeProject(
    second,
    root,
    { agencyDir },
    returning.io,
    signal(),
    unusedHost,
  );
  assert.deepEqual(returning.remaining, []);
  assert.match(returning.questions[0] ?? '', /\[claude\]/);
  assert.match(returning.questions[1] ?? '', /\[sonnet\]/);
  assert.doesNotMatch(returning.questions.join('\n'), /import\/write\/skip/);
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

await test('a failed memory import leaves a usable project without leaking the host error', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-init-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agencyDir = join(root, 'agency');
  const source = join(root, 'selected-memory.md');
  await writeFile(source, 'I prefer reproducible graph benchmarks.');
  const ui = prompts([
    'claude',
    '',
    'import',
    source,
    'yes',
    'Graph search',
    '',
  ]);
  let calls = 0;
  const initialized = await initializeProject(
    root,
    root,
    { agencyDir },
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
  assert.equal(initialized.research?.topic, 'Graph search');
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
