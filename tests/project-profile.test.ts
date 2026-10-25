import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
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
  copyGlobalProfile,
  ownProfileCopied,
  ownProfileFolder,
  profileDenial,
  projectProfile,
} from '../src/core/project-profile.ts';
import { changeWorkspace, loadWorkspace } from '../src/core/storage.ts';
import type { Workspace } from '../src/core/contracts.ts';
import { createProject, defaultProfile } from '../src/cli/project.ts';
import { FirstRuns } from '../src/server/setup.ts';

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
}

/** A global profile: agents, GPU limits with a monthly one, every step done, a card, an added skill, and the month's records. */
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
}

const workspace: Workspace = {
  schemaVersion: 1,
  visibility: 'private',
  profile: defaultProfile,
  host: 'claude',
  candidates: [],
  selectedId: null,
};

await test("an isolated project's settings are a copy of the global profile in its own folder, with every step to do and no monthly limit, while the global profile's lock holds", async (t) => {
  const base = await folder(t, 'own-copy');
  const global = join(base, 'agency');
  await globalProfile(global);
  const here = join(base, 'here');
  await mkdir(here);
  assert.equal(await ownProfileCopied(here), null);
  await copyGlobalProfile(global, here, signal);
  const own = ownProfileFolder(here);
  assert.equal(own, join(here, '.verifold', 'agency'));
  const settings = await loadSettings(own);
  assert.deepEqual(settings.agency, {
    host: 'claude',
    model: 'opus[1m]',
    helper: 'codex',
  });
  assert.equal(settings.money?.limitUsd, 40);
  assert.equal(settings.money?.monthUsd, null);
  assert.deepEqual(settings.steps, {});
  assert.match((await loadMemory(own)) ?? '', /Probes/);
  assert.equal(
    await readFile(
      join(own, 'skills', 'owner', 'repo', 'a'.repeat(40), 'id', 'SKILL.md'),
      'utf8',
    ),
    '---\nname: probe\n---\n',
  );
  const names = await readdir(own);
  assert.equal(names.includes('gpu'), false);
  assert.equal(names.includes('profile.lock'), false);
  assert.match((await ownProfileCopied(here)) ?? '', /^\d{4}-\d\d-\d\dT/);
  // The global profile does not change, and its lock is gone again.
  assert.deepEqual((await loadSettings(global)).steps, {
    agents: 'done',
    about: 'done',
    skills: 'done',
    money: 'done',
  });
  assert.equal(existsSync(join(global, 'profile.lock')), false);
  // A copy again replaces a broken copy without reading it.
  await writeFile(join(own, 'profile-state.json'), '{ not json');
  await writeFile(join(own, 'USER.md'), 'x'.repeat(20_000));
  await writeFile(join(own, 'left.txt'), 'from before');
  await copyGlobalProfile(global, here, signal);
  assert.equal(existsSync(join(own, 'left.txt')), false);
  assert.equal(existsSync(join(own, 'profile-state.json')), false);
  assert.match((await loadMemory(own)) ?? '', /Probes/);
  // While another setup holds the global profile's lock, nothing is copied.
  const lock = await open(join(global, 'profile.lock'), 'wx');
  await lock.close();
  await assert.rejects(copyGlobalProfile(global, here, signal), /locked/);
  await rm(join(global, 'profile.lock'));
  // A .verifold that is a link is refused.
  const linked = join(base, 'linked');
  await mkdir(linked);
  await symlink(join(base, 'elsewhere'), join(linked, '.verifold'));
  await assert.rejects(
    copyGlobalProfile(global, linked, signal),
    /real folder/,
  );
});

await test('a project with its own settings records it at the start, and each later read of the project uses them', async (t) => {
  const base = await folder(t, 'own-start');
  const global = join(base, 'agency');
  await globalProfile(global);
  const here = join(base, 'here');
  await mkdir(here);
  // Without the copy, the start refuses.
  await assert.rejects(
    createProject(
      here,
      workspace,
      'Q?',
      undefined,
      signal,
      true,
      undefined,
      true,
    ),
    /Choose Isolated project again/,
  );
  assert.equal(existsSync(join(here, '.verifold', 'workspace.json')), false);
  await copyGlobalProfile(global, here, signal);
  // Before the project exists, the global profile counts.
  assert.equal(await projectProfile(here, global), global);
  await createProject(
    here,
    workspace,
    'Q?',
    undefined,
    signal,
    true,
    undefined,
    true,
  );
  assert.equal((await loadWorkspace(here)).ownProfile, true);
  assert.equal(await projectProfile(here, global), ownProfileFolder(here));
  // A later change of the workspace keeps the choice.
  await changeWorkspace(here, (current) => ({
    ...(current ?? workspace),
    agents: 2,
  }));
  assert.equal((await loadWorkspace(here)).ownProfile, true);
  // A project on the global settings uses the global profile.
  const shared = join(base, 'shared');
  await mkdir(shared);
  await createProject(shared, workspace, 'Q?', undefined, signal, true);
  assert.equal(await projectProfile(shared, global), global);
  // A workspace that does not read is refused, not taken for one on the global settings.
  await writeFile(join(shared, '.verifold', 'workspace.json'), '{ broken');
  await assert.rejects(
    projectProfile(shared, global),
    /cannot tell which settings this project uses/,
  );
});

await test('no session reads an isolated project’s settings, whether the project uses them yet or not, nor a global profile outside the default folder', () => {
  const root = '/work/cot';
  const own = ownProfileFolder(root);
  assert.deepEqual(profileDenial(root, agencyDirectory(root)), [own]);
  assert.deepEqual(profileDenial(root, '/elsewhere/agency'), [
    own,
    '/elsewhere/agency',
  ]);
});

const claudeFound: HarnessStatus = {
  harness: 'claude',
  installed: true,
  version: '2.1.304',
  signedIn: true,
  plan: 'max',
  models: [{ id: 'opus[1m]', label: 'Opus' }],
};

async function options(base: string, root: string, global: string) {
  const compute = new Compute(join(base, 'here'), {
    store: new KeyStore({
      home: join(base, 'home'),
      platform: 'linux',
      secretTool: join(base, 'none'),
    }),
  });
  await compute.load();
  return {
    directory: global,
    root,
    compute,
    signal,
    detect: () => Promise.resolve([claudeFound]),
    installed: () => Promise.resolve(['claude' as const]),
  };
}

await test('without a project, the first runs serve the global settings, and for profile project a copy in the folder that shows the global monthly limit and never saves one', async (t) => {
  const base = await folder(t, 'own-run');
  const global = join(base, 'agency');
  await globalProfile(global);
  const here = join(base, 'here');
  await mkdir(here);
  const setup = new FirstRuns({
    ...(await options(base, here, global)),
    own: 'new',
  });
  const shared = await setup.view();
  assert.equal(shared.scope, 'global');
  assert.equal(shared.steps.about, 'done');
  assert.equal(shared.ownCopied, null);
  // The first read of the project's settings copies the global ones here.
  const own = await setup.view('project');
  assert.equal(own.scope, 'project');
  assert.deepEqual(own.steps, {
    agents: null,
    about: null,
    skills: null,
    money: null,
  });
  assert.deepEqual(own.money.globalMonth, { usd: 200 });
  assert.match((await setup.view()).ownCopied ?? '', /^\d{4}-/);
  // A save goes to the copy. A monthly limit in it is not saved: only the global profile holds one.
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
  const saved = await loadSettings(ownProfileFolder(here));
  assert.equal(saved.money?.limitUsd, 10);
  assert.equal(saved.money?.monthUsd, null);
  assert.deepEqual(saved.steps, { money: 'done', about: 'skipped' });
  const kept = await loadSettings(global);
  assert.equal(kept.money?.limitUsd, 40);
  assert.equal(kept.money?.monthUsd, 200);
  assert.equal(kept.steps.about, 'done');
  // A copy again replaces the copy's changes. Two at once run one after the other.
  const copies = await Promise.all([
    setup.act({ action: 'setup-copy-global', profile: 'project' }),
    setup.act({ action: 'setup-copy-global', profile: 'project' }),
  ]);
  assert.deepEqual(copies, [200, 200]);
  assert.deepEqual((await loadSettings(ownProfileFolder(here))).steps, {});
  assert.equal((await setup.view('project')).money.limits.limitUsd, 40);
  // Without profile project, a copy again is not an action of the global settings.
  assert.equal(await setup.act({ action: 'setup-copy-global' }), 400);
  // Global GPU limits that do not read: the copy says so, and never claims no limit.
  await writeFile(
    join(global, 'settings.json'),
    JSON.stringify({ host: 'claude', money: { limitUsd: -1 } }),
  );
  assert.equal((await setup.view('project')).money.globalMonth, null);
});

await test('in a project, only an isolated one has settings of its own, and they are not copied again', async (t) => {
  const base = await folder(t, 'own-project');
  const global = join(base, 'agency');
  await globalProfile(global);
  const here = join(base, 'here');
  await mkdir(here);
  await copyGlobalProfile(global, here, signal);
  const isolated = new FirstRuns({
    ...(await options(base, here, global)),
    own: 'project',
  });
  assert.equal((await isolated.view('project')).scope, 'project');
  assert.equal((await isolated.view()).scope, 'global');
  assert.equal((await isolated.view()).ownCopied, undefined);
  await assert.rejects(
    isolated.act({ action: 'setup-copy-global', profile: 'project' }),
    /settings stay/,
  );
  const shared = new FirstRuns({
    ...(await options(base, here, global)),
    own: null,
  });
  await assert.rejects(shared.view('project'), /uses your global settings/);
});
