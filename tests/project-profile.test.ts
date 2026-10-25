import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agencyDirectory,
  cardMarkdown,
  loadMemory,
  loadSettings,
  saveAgencyFile,
  writeSettings,
} from '../src/core/agency.ts';
import { Compute, profileMoneyDefaults } from '../src/core/compute.ts';
import { KeyStore } from '../src/core/credentials.ts';
import type { HarnessStatus } from '../src/core/detect.ts';
import {
  draftFolder,
  ownProfileFolder,
  profileDenial,
  projectProfile,
  seedDraft,
} from '../src/core/project-profile.ts';
import { changeWorkspace, loadWorkspace } from '../src/core/storage.ts';
import type { Workspace } from '../src/core/contracts.ts';
import { createProject, defaultProfile } from '../src/cli/project.ts';
import { FirstRun, StartFirstRun } from '../src/server/setup.ts';

const signal = new AbortController().signal;

async function folder(t: test.TestContext, name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `verifold-${name}-`));
  t.after(async () => {
    // Skill copies are read-only, so their folders open again before the removal.
    await chmodTree(path);
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

async function chmodTree(path: string): Promise<void> {
  if (!existsSync(path)) return;
  await chmod(path, 0o700).catch(() => {});
  for (const entry of await readdir(path, { withFileTypes: true }).catch(
    () => [],
  ))
    if (entry.isDirectory()) await chmodTree(join(path, entry.name));
    else await chmod(join(path, entry.name), 0o600).catch(() => {});
}

/** A global profile: agents, GPU limits with a monthly one, every step done, a card, an added skill, the month's records, and a held lock. */
async function globalProfile(agency: string): Promise<void> {
  await writeSettings(agency, () => ({
    agency: { host: 'claude', model: 'opus[1m]', helper: 'codex' },
    money: { ...profileMoneyDefaults, limitUsd: 40, monthUsd: 200 },
    unreadMoney: null,
    steps: { agents: 'done', about: 'done', skills: 'done', money: 'done' },
  }));
  await saveAgencyFile(
    agency,
    'USER.md',
    cardMarkdown({ workOn: 'Probes', explore: 'SAEs', talk: 'Short.' }),
  );
  await saveAgencyFile(
    agency,
    'skills.json',
    JSON.stringify({ schemaVersion: 1, added: [] }),
  );
  const skill = join(agency, 'skills', 'owner', 'repo', 'a'.repeat(40), 'id');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '---\nname: probe\n---\n');
  await chmod(skill, 0o555);
  await mkdir(join(agency, 'gpu'));
  await writeFile(join(agency, 'gpu', '0123456789abcdef.json'), '{}');
  await writeFile(join(agency, 'profile.lock'), '123\n');
}

const workspace: Workspace = {
  schemaVersion: 1,
  visibility: 'private',
  profile: defaultProfile,
  host: 'claude',
  candidates: [],
  selectedId: null,
};

await test("an isolated project's draft is a copy of the global profile with every step to do and no monthly limit, without the month's records, the lock, or the marker's copy", async (t) => {
  const base = await folder(t, 'draft-seed');
  const global = join(base, 'agency');
  await globalProfile(global);
  const here = join(base, 'here');
  await mkdir(here);
  const draft = await draftFolder(global, here);
  assert.match(draft, /\/agency\/drafts\/[0-9a-f]{16}$/);
  // The same folder, by any path to it, has the same draft.
  assert.equal(await draftFolder(global, join(here, '.')), draft);
  await seedDraft(global, draft);
  const settings = await loadSettings(draft);
  assert.deepEqual(settings.agency, {
    host: 'claude',
    model: 'opus[1m]',
    helper: 'codex',
  });
  assert.equal(settings.money?.limitUsd, 40);
  assert.equal(settings.money?.monthUsd, null);
  assert.deepEqual(settings.steps, {});
  assert.match((await loadMemory(draft)) ?? '', /Probes/);
  assert.equal(
    await readFile(
      join(draft, 'skills', 'owner', 'repo', 'a'.repeat(40), 'id', 'SKILL.md'),
      'utf8',
    ),
    '---\nname: probe\n---\n',
  );
  const names = await readdir(draft);
  for (const left of ['gpu', 'profile.lock', 'drafts'])
    assert.equal(names.includes(left), false, left);
  assert.equal(
    (await readFile(join(draft, '.verifold-agency'), 'utf8')).trim(),
    'Verifold agency v1',
  );
  // The global profile does not change.
  assert.deepEqual((await loadSettings(global)).steps, {
    agents: 'done',
    about: 'done',
    skills: 'done',
    money: 'done',
  });
  // A draft that exists stays, with the person's changes, unless it is copied again.
  await writeSettings(draft, (current) => ({
    ...current,
    steps: { agents: 'done' },
  }));
  await seedDraft(global, draft);
  assert.deepEqual((await loadSettings(draft)).steps, { agents: 'done' });
  await seedDraft(global, draft, true);
  assert.deepEqual((await loadSettings(draft)).steps, {});
  // Nothing of the copies stays beside the draft.
  assert.deepEqual(
    (await readdir(join(global, 'drafts'))).filter((name) =>
      name.includes('.'),
    ),
    [],
  );
});

await test('a project takes a copy of the draft as its own profile, or nothing when the copy fails part-way', async (t) => {
  const base = await folder(t, 'draft-place');
  const global = join(base, 'agency');
  await globalProfile(global);
  const here = join(base, 'here');
  await mkdir(here);
  const draft = await draftFolder(global, here);
  await seedDraft(global, draft);
  // Before the project exists, and for a project without its own profile, the global profile counts.
  assert.equal(await projectProfile(here, global), global);
  await createProject(
    here,
    workspace,
    'Q?',
    undefined,
    signal,
    true,
    undefined,
    draft,
  );
  assert.equal((await loadWorkspace(here)).ownProfile, true);
  const own = ownProfileFolder(here);
  assert.equal(own, join(here, '.verifold', 'agency'));
  assert.equal(await projectProfile(here, global), own);
  assert.match((await loadMemory(own)) ?? '', /Probes/);
  assert.equal(existsSync(join(own, 'profile.lock')), false);
  assert.deepEqual(
    (await readdir(join(here, '.verifold'))).filter((name) =>
      name.startsWith('agency.'),
    ),
    [],
  );
  // A later change of the workspace keeps the choice.
  await changeWorkspace(here, (current) => ({
    ...(current ?? workspace),
    agents: 2,
  }));
  assert.equal((await loadWorkspace(here)).ownProfile, true);

  // A file of the draft that cannot be read stops the copy: no profile folder, no project.
  const there = join(base, 'there');
  await mkdir(there);
  const broken = await draftFolder(global, there);
  await seedDraft(global, broken);
  await writeFile(join(broken, 'locked.txt'), 'x', { mode: 0o000 });
  await assert.rejects(
    createProject(
      there,
      workspace,
      'Q?',
      undefined,
      signal,
      true,
      undefined,
      broken,
    ),
  );
  assert.equal(existsSync(join(there, '.verifold', 'workspace.json')), false);
  assert.equal(existsSync(join(there, '.verifold.md')), false);
  assert.deepEqual(
    (await readdir(join(there, '.verifold'))).filter((name) =>
      name.startsWith('agency'),
    ),
    [],
  );
  // A project folder that holds a profile folder already is refused.
  const taken = join(base, 'taken');
  await mkdir(join(taken, '.verifold', 'agency'), { recursive: true });
  await assert.rejects(
    createProject(
      taken,
      workspace,
      'Q?',
      undefined,
      signal,
      true,
      undefined,
      draft,
    ),
    /exists already/,
  );
  assert.equal(existsSync(join(taken, '.verifold', 'workspace.json')), false);
});

await test("the lab cannot read a project's profile folders, beyond the default one that every session closes", () => {
  const root = '/work/cot';
  const global = agencyDirectory(root);
  assert.deepEqual(profileDenial(root, [global, global]), {});
  assert.deepEqual(profileDenial(root, [ownProfileFolder(root), global]), {
    denyRead: [ownProfileFolder(root)],
  });
  assert.deepEqual(
    profileDenial(root, [ownProfileFolder(root), '/elsewhere/agency']),
    { denyRead: [ownProfileFolder(root), '/elsewhere/agency'] },
  );
});

const claudeFound: HarnessStatus = {
  harness: 'claude',
  installed: true,
  version: '2.1.304',
  signedIn: true,
  plan: 'max',
  models: [{ id: 'opus[1m]', label: 'Opus' }],
};

async function compute(base: string): Promise<Compute> {
  const value = new Compute(join(base, 'here'), {
    store: new KeyStore({
      home: join(base, 'home'),
      platform: 'linux',
      secretTool: join(base, 'none'),
    }),
  });
  await value.load();
  return value;
}

await test('without a project, the first run serves the global profile, and for profile project the draft, which shows the global monthly limit and never saves one', async (t) => {
  const base = await folder(t, 'draft-run');
  const global = join(base, 'agency');
  await globalProfile(global);
  const here = join(base, 'here');
  await mkdir(here);
  const options = {
    directory: global,
    root: here,
    compute: await compute(base),
    signal,
    detect: () => Promise.resolve([claudeFound]),
    installed: () => Promise.resolve(['claude' as const]),
  };
  const setup = new StartFirstRun(options);
  const shared = await setup.view();
  assert.equal(shared.scope, 'global');
  assert.equal(shared.steps.about, 'done');
  // The draft comes at its first read, with every step to do.
  const own = await setup.view('project');
  assert.equal(own.scope, 'project');
  assert.deepEqual(own.steps, {
    agents: null,
    about: null,
    skills: null,
    money: null,
  });
  assert.equal(own.money.limits.limitUsd, 40);
  assert.equal(own.money.limits.monthUsd, 200);
  // A save goes to the draft. A monthly limit in it is not saved: only the global profile holds one.
  assert.equal(
    await setup.act({
      action: 'setup-money',
      profile: 'project',
      ...profileMoneyDefaults,
      limitUsd: 10,
      monthUsd: 999,
    }),
    200,
  );
  assert.equal(
    await setup.act({
      action: 'setup-skip',
      profile: 'project',
      step: 'about',
    }),
    200,
  );
  const draft = await draftFolder(global, here);
  const saved = await loadSettings(draft);
  assert.equal(saved.money?.limitUsd, 10);
  assert.equal(saved.money?.monthUsd, null);
  assert.deepEqual(saved.steps, { money: 'done', about: 'skipped' });
  const after = await setup.view('project');
  assert.equal(after.money.limits.monthUsd, 200);
  // The global profile stays as it was.
  const kept = await loadSettings(global);
  assert.equal(kept.money?.limitUsd, 40);
  assert.equal(kept.money?.monthUsd, 200);
  assert.equal(kept.steps.about, 'done');
  // A copy of the global settings again replaces the draft's changes.
  assert.equal(
    await setup.act({ action: 'setup-copy-global', profile: 'project' }),
    200,
  );
  assert.deepEqual((await loadSettings(draft)).steps, {});
  assert.equal((await setup.view('project')).money.limits.limitUsd, 40);
  // Without profile project, a copy again is not an action of the global profile.
  assert.equal(await setup.act({ action: 'setup-copy-global' }), 400);
  // A first run of the global profile alone has no project's profile.
  const plain = new FirstRun(options);
  await assert.rejects(plain.view('project'), /no profile of a project/);
  assert.throws(
    () => plain.act({ action: 'setup-check', profile: 'project' }),
    /no profile of a project/,
  );
});
