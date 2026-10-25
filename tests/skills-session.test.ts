import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { HarnessName } from '../src/core/harness.ts';
import { saveAgencyFile } from '../src/core/agency.ts';
import { skillLoader } from '../src/core/skills.ts';
import { SessionManager, type SessionSkills } from '../src/core/session.ts';
import { changeWorkspace } from '../src/core/storage.ts';
import { jsonLines, until } from './wait.ts';

const codexSocket = fileURLToPath(
  new URL('./fixtures/codex-socket.cjs', import.meta.url),
);

/**
 * A fake Claude Code. With a plugin folder whose path says `blocked`, it
 * stops as a managed policy makes it stop. With `broken`, its start event
 * lists the plugin as failed.
 */
const claudeHost = `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync('args.json', JSON.stringify(args));
const dir = args.includes('--plugin-dir') ? args[args.indexOf('--plugin-dir') + 1] : null;
fs.appendFileSync('runs.jsonl', JSON.stringify(args) + '\\n');
if (dir && dir.includes('blocked')) {
  process.stderr.write("Error: --plugin-dir is disabled by your organization's managed settings (disableSideloadFlags).\\n");
  process.exit(1);
}
if (dir && dir.includes('crash')) {
  process.stderr.write('Error: the plugin manifest could not be read.\\n');
  process.exit(1);
}
if (fs.existsSync('always-fail')) {
  process.stderr.write('Error: not signed in.\\n');
  process.exit(1);
}
if (dir && dir.includes('hang')) setInterval(() => {}, 1000);
if (dir) {
  const skills = require('node:path').join(dir, 'skills');
  const read = fs.readdirSync(skills).map((name) => fs.readFileSync(require('node:path').join(skills, name, 'SKILL.md'), 'utf8'));
  fs.writeFileSync('read.txt', read.join('\\n'));
}
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  if (dir && dir.includes('hang')) return;
  const message = JSON.parse(line);
  if (message.type === 'control_request' && message.request.subtype === 'initialize')
    return out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
  if (message.type !== 'user') return;
  const broken = Boolean(dir && dir.includes('broken'));
  out({ type: 'system', subtype: 'init', session_id: 'native-1', model: 'fake', permissionMode: 'dontAsk',
    plugins: dir && !broken ? [{ name: 'verifold-skills', path: dir }] : [],
    plugin_errors: broken ? [{ plugin: 'verifold-skills@inline', error: 'Invalid skill' }] : [] });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } });
  out({ type: 'result', subtype: 'success' });
});`;

/** A fake Codex app-server that knows the skill methods, unless the folder has an \`old-codex\` file. */
const codexHost = `const fs = require('node:fs');
fs.writeFileSync('codex-args.json', JSON.stringify(process.argv.slice(2)));
const { out, onLine } = require(${JSON.stringify(codexSocket)})(process.argv);
let roots = [];
onLine((line) => {
  fs.appendFileSync('rpc.jsonl', line + '\\n');
  const message = JSON.parse(line);
  if (message.method === 'initialize') out({ id: message.id, result: {} });
  else if (message.method === 'config/read') out({ id: message.id, result: { config: { model: 'gpt-x', mcp_servers: {} } } });
  else if (message.method === 'skills/extraRoots/set') {
    if (fs.existsSync('old-codex')) return out({ id: message.id, error: { code: -32601, message: 'Method not found' } });
    roots = message.params.extraRoots;
    for (const root of roots)
      fs.writeFileSync('codex-read.txt', fs.readdirSync(root).map((name) => fs.readFileSync(require('node:path').join(root, name, 'SKILL.md'), 'utf8')).join('\\n'));
    out({ id: message.id, result: {} });
  } else if (message.method === 'skills/list') {
    if (fs.existsSync('list-fails')) return out({ id: message.id, error: { code: -32000, message: 'List failed' } });
    out({ id: message.id, result: { data: [{ cwd: message.params.cwds[0], skills: roots.map((root) => ({ name: 'transformer-lens', path: root + '/transformer-lens/SKILL.md', description: 'x', enabled: true, scope: 'user' })), errors: [] }] } });
  } else if (message.method === 'model/list') out({ id: message.id, result: { data: [], nextCursor: null } });
  else if (message.method === 'thread/start') out({ id: message.id, result: { thread: { id: 'thread-1' }, model: 'fake', approvalsReviewer: 'user' } });
  else if (message.method === 'turn/start') {
    out({ id: message.id, result: { turn: { id: 'turn-1' } } });
    out({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  }
});`;

async function project(t: test.TestContext): Promise<{
  readonly root: string;
  readonly work: string;
  readonly managers: readonly SessionManager[];
  readonly start: (
    host: HarnessName,
    skills: SessionSkills,
  ) => Promise<SessionManager>;
}> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'verifold-skills-session-')),
  );
  const managers: SessionManager[] = [];
  t.after(async () => {
    for (const manager of managers) await manager.close();
    // Verifold's copies of skills are read-only.
    for (const entry of await readdir(root, {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []))
      if (entry.isDirectory())
        await chmod(join(entry.parentPath, entry.name), 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await changeWorkspace(root, () => ({
    schemaVersion: 1,
    visibility: 'private',
    profile: {
      name: 'Researcher',
      interests: ['Graphs'],
      scholar: '',
      github: '',
      session: '',
    },
    host: 'claude',
    candidates: [],
    selectedId: null,
  }));
  // A direction's folder, as the lab gives one to its agent.
  const work = join(root, '.verifold', 'workspaces', 'd-1');
  await mkdir(work, { recursive: true });
  const executables = {
    claude: join(root, 'fake-claude'),
    codex: join(root, 'fake-codex'),
  };
  await writeFile(executables.claude, `#!${process.execPath}\n${claudeHost}`, {
    mode: 0o700,
  });
  await writeFile(executables.codex, `#!${process.execPath}\n${codexHost}`, {
    mode: 0o700,
  });
  return {
    root,
    work,
    managers,
    start: async (host, skills) => {
      const manager = new SessionManager(root, {
        clientVersion: 'test',
        ownerId: 'test-owner',
        executables,
        skills,
      });
      managers.push(manager);
      await manager.startAgent({
        host,
        prompt: 'Go.',
        cwd: work,
        agent: 'a-1',
        tools: {
          specs: [],
          call: () => Promise.resolve({ ok: true, text: '' }),
        },
      });
      return manager;
    },
  };
}

function loader(folder: string | null): SessionSkills & {
  readonly problems: (readonly [HarnessName, string])[];
  readonly uses: string[];
} {
  const problems: (readonly [HarnessName, string])[] = [];
  const uses: string[] = [];
  return {
    problems,
    uses,
    folder: () => Promise.resolve(folder),
    problem: (host, text) => problems.push([host, text]),
    used: (path) => uses.push(path),
  };
}

/** A plugin folder with one skill, as skillPlugin builds it. */
async function plugin(root: string, name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(join(path, 'skills', 'transformer-lens'), { recursive: true });
  await writeFile(
    join(path, 'skills', 'transformer-lens', 'SKILL.md'),
    '---\nname: transformer-lens\ndescription: x\n---\n',
  );
  return path;
}

const args = async (work: string, file: string): Promise<string[]> =>
  JSON.parse(await readFile(join(work, file), 'utf8')) as string[];

await test('Claude Code gets --plugin-dir only with added skills, and a plugin that fails or is blocked is reported', async (t) => {
  const { root, work, start, managers } = await project(t);
  const folder = await plugin(root, 'plugins-1a2b3c4d5e6f7a8b');
  const ok = loader(folder);
  await start('claude', ok);
  // The fake writes args.json after it makes it, so the wait is for the whole JSON.
  await until(
    async () => (await args(work, 'args.json').catch(() => null)) !== null,
  );
  const given = await args(work, 'args.json');
  assert.equal(given[given.indexOf('--plugin-dir') + 1], folder);
  const first = managers.at(-1);
  assert.ok(first);
  await until(() => first.view()?.record.status === 'idle');
  // The start event listed the plugin before the turn ended, so nothing is reported.
  assert.deepEqual(ok.problems, []);
  // Each later turn marks the set as used, so it is not pruned under the session.
  first.continueTask('Again.');
  assert.deepEqual(ok.uses, [folder]);

  await rm(join(work, 'args.json'));
  const none = loader(null);
  await start('claude', none);
  await until(
    async () => (await args(work, 'args.json').catch(() => null)) !== null,
  );
  assert.ok(!(await args(work, 'args.json')).includes('--plugin-dir'));

  const broken = loader(await plugin(root, 'broken-plugin'));
  await start('claude', broken);
  await until(() => broken.problems.length > 0);
  assert.deepEqual(broken.problems, [
    [
      'claude',
      'Claude Code could not load the added skills, so its agents run without them.',
    ],
  ]);

  // A managed setting refuses the flag: the skills are blocked, and the session goes on without them.
  await rm(join(work, 'runs.jsonl'), { force: true });
  const blocked = loader(await plugin(root, 'blocked-plugin'));
  const manager = await start('claude', blocked);
  await until(() => blocked.problems.length > 0);
  assert.deepEqual(blocked.problems, [
    [
      'claude',
      "Your organization's Claude Code settings block added skills, so agents run without them.",
    ],
  ]);
  await until(() => manager.view()?.record.status === 'idle');
  const runs = await jsonLines<string[]>(join(work, 'runs.jsonl'));
  assert.equal(runs.length, 2);
  assert.ok(runs[0]?.includes('--plugin-dir'));
  assert.ok(!runs[1]?.includes('--plugin-dir'));
  // The second run got the same session ID and the same first request.
  assert.equal(
    runs[1]?.[runs[1].indexOf('--session-id') + 1],
    runs[0]?.[runs[0].indexOf('--session-id') + 1],
  );
});

await test('a Claude Code run that fails with the plugin runs again without it, and the skills are blocked only when that run starts', async (t) => {
  const { root, work, start } = await project(t);
  // Another failure with the plugin: the run without it starts, so the plugin was the cause.
  const crash = loader(await plugin(root, 'crash-plugin'));
  const manager = await start('claude', crash);
  await until(() => crash.problems.length > 0);
  assert.deepEqual(crash.problems, [
    [
      'claude',
      'Claude Code did not start with the added skills, so its agents run without them.',
    ],
  ]);
  await until(() => manager.view()?.record.status === 'idle');
  assert.ok(existsSync(join(work, 'read.txt')) === false);

  // Both runs fail: the plugin is not the cause, so nothing is blocked.
  await writeFile(join(work, 'always-fail'), '');
  const both = loader(await plugin(root, 'crash-again'));
  const failing = await start('claude', both);
  await until(() => failing.view()?.record.status === 'failed');
  assert.deepEqual(both.problems, []);
  await rm(join(work, 'always-fail'));

  // Verifold's own stop before the start is no failure of the plugin.
  const hang = loader(await plugin(root, 'hang-plugin'));
  const stopped = await start('claude', hang);
  await delay(300);
  await stopped.close();
  await delay(200);
  assert.deepEqual(hang.problems, []);
});

await test('Codex sets the skill root before the thread starts, with MCP dependency installs off, and an old Codex runs without it', async (t) => {
  const { root, work, start } = await project(t);
  const folder = await plugin(root, 'plugins-0011223344556677');
  const ok = loader(folder);
  await start('codex', ok);
  await until(async () =>
    (
      await jsonLines<{ method?: string }>(join(work, 'rpc.jsonl')).catch(
        () => [],
      )
    ).some((message) => message.method === 'thread/start'),
  );
  const given = await args(work, 'codex-args.json');
  assert.equal(
    given[given.indexOf('features.skill_mcp_dependency_install=false') - 1],
    '-c',
  );
  assert.ok(
    given.indexOf('features.skill_mcp_dependency_install=false') <
      given.indexOf('app-server'),
  );
  const methods = (
    await jsonLines<{ method?: string }>(join(work, 'rpc.jsonl'))
  ).map((message) => message.method);
  assert.ok(
    methods.indexOf('skills/extraRoots/set') < methods.indexOf('skills/list') &&
      methods.indexOf('skills/list') < methods.indexOf('thread/start'),
    methods.join(', '),
  );
  const set = (await readFile(join(work, 'rpc.jsonl'), 'utf8'))
    .split('\n')
    .find((line) => line.includes('skills/extraRoots/set'));
  assert.deepEqual((JSON.parse(set ?? '{}') as { params: unknown }).params, {
    extraRoots: [join(folder, 'skills')],
  });
  assert.ok(!methods.includes('skills/config/write'));
  assert.deepEqual(ok.problems, []);

  // skills/list fails: the root goes again before the thread starts, as the line says.
  await rm(join(work, 'rpc.jsonl'));
  await writeFile(join(work, 'list-fails'), '');
  const unlisted = loader(folder);
  await start('codex', unlisted);
  await until(async () =>
    (
      await jsonLines<{ method?: string }>(join(work, 'rpc.jsonl')).catch(
        () => [],
      )
    ).some((message) => message.method === 'thread/start'),
  );
  const sets = (
    await jsonLines<{ method?: string; params?: unknown }>(
      join(work, 'rpc.jsonl'),
    )
  ).filter((message) => message.method === 'skills/extraRoots/set');
  assert.deepEqual(sets.at(-1)?.params, { extraRoots: [] });
  assert.deepEqual(unlisted.problems, [
    [
      'codex',
      'Codex could not load the added skills, so Codex agents run without them.',
    ],
  ]);
  await rm(join(work, 'list-fails'));

  // An old Codex has no skill methods: the thread starts all the same.
  await rm(join(work, 'rpc.jsonl'));
  await writeFile(join(work, 'old-codex'), '');
  const old = loader(folder);
  await start('codex', old);
  await until(async () =>
    (
      await jsonLines<{ method?: string }>(join(work, 'rpc.jsonl')).catch(
        () => [],
      )
    ).some((message) => message.method === 'thread/start'),
  );
  assert.deepEqual(old.problems, [
    [
      'codex',
      'This version of Codex cannot load added skills, so Codex agents run without them. Update Codex to use them.',
    ],
  ]);

  // Without added skills, nothing changes in the command or the calls.
  await rm(join(work, 'rpc.jsonl'));
  await rm(join(work, 'old-codex'));
  await start('codex', loader(null));
  await until(async () =>
    (
      await jsonLines<{ method?: string }>(join(work, 'rpc.jsonl')).catch(
        () => [],
      )
    ).some((message) => message.method === 'thread/start'),
  );
  assert.ok(
    !(await args(work, 'codex-args.json')).some((arg) =>
      arg.includes('skill_mcp_dependency_install'),
    ),
  );
  assert.ok(
    !(await readFile(join(work, 'rpc.jsonl'), 'utf8')).includes('skills/'),
  );
});

await test('with the profile folder unreadable, both harnesses read the added skill through the copy that the loader builds', async (t) => {
  const { root, work, start } = await project(t);
  // A skill that the person added, as addSkill keeps it in the profile folder.
  const agency = join(root, 'agency');
  const commit = 'c'.repeat(40);
  // The store keeps each skill under its ID.
  const store = join(
    agency,
    'skills',
    'Orchestra-Research',
    'AI-Research-SKILLs',
    commit,
    '0123456789abcdef',
  );
  await saveAgencyFile(
    agency,
    'skills.json',
    JSON.stringify({
      schemaVersion: 1,
      added: [
        {
          id: '0123456789abcdef',
          name: 'transformer-lens',
          repo: 'Orchestra-Research/AI-Research-SKILLs',
          commit,
          path: '04-mechanistic-interpretability/transformer-lens',
          tree: 'd'.repeat(40),
          license: 'MIT',
          addedAt: new Date().toISOString(),
        },
      ],
    }),
  );
  await mkdir(store, { recursive: true });
  await writeFile(
    join(store, 'SKILL.md'),
    '---\nname: transformer-lens\ndescription: Activation patching.\n---\n',
  );
  const told: string[] = [];
  const skills = skillLoader(agency, join(root, 'plugins'), (text) =>
    told.push(text),
  );
  const folder = await skills.folder('claude');
  assert.ok(folder && !folder.startsWith(`${agency}/`));
  // Lab sessions cannot read the profile folder. The owner still reads skills.json there, so the
  // test locks the store of the skills' files, the only part that a session would need.
  await chmod(join(agency, 'skills'), 0o000);
  try {
    await start('claude', skills);
    // A fake writes the file after it makes it, so the wait is for its text.
    await until(async () =>
      (await readFile(join(work, 'read.txt'), 'utf8').catch(() => '')).includes(
        'Activation patching',
      ),
    );
    assert.match(
      await readFile(join(work, 'read.txt'), 'utf8'),
      /Activation patching/,
    );
    await start('codex', skills);
    await until(async () =>
      (
        await readFile(join(work, 'codex-read.txt'), 'utf8').catch(() => '')
      ).includes('Activation patching'),
    );
    assert.match(
      await readFile(join(work, 'codex-read.txt'), 'utf8'),
      /Activation patching/,
    );
    for (const file of ['args.json', 'codex-args.json'])
      assert.ok(
        !(await readFile(join(work, file), 'utf8')).includes(agency),
        `${file} names no path in the profile folder`,
      );
    const roots = (await readFile(join(work, 'rpc.jsonl'), 'utf8'))
      .split('\n')
      .filter((line) => line.includes('skills/extraRoots/set'));
    assert.ok(roots.length && roots.every((line) => !line.includes(agency)));
  } finally {
    // Restored before the project's cleanup, which removes the folder.
    await chmod(join(agency, 'skills'), 0o700);
  }
  assert.deepEqual(told, []);
});

await test("the person's own skills that are off stay out of every session: Claude Code by its settings, Codex by a -c rule on each path", async (t) => {
  const { root, work, start } = await project(t);
  const python = '/home/p/.agents/skills/python/SKILL.md';
  const off = (host: HarnessName): Promise<readonly string[]> =>
    Promise.resolve(host === 'claude' ? ['python', 'vercel:nextjs'] : [python]);
  await start('claude', { ...loader(null), off });
  await until(
    async () => (await args(work, 'args.json').catch(() => null)) !== null,
  );
  const given = await args(work, 'args.json');
  const settings = JSON.parse(
    given[given.indexOf('--settings') + 1] ?? '{}',
  ) as {
    sandbox?: unknown;
    permissions: { deny: string[] };
    skillOverrides: Record<string, string>;
  };
  // The lab's agent runs in strict mode, so its rules stay, with the skills added.
  assert.ok(settings.sandbox);
  assert.ok(settings.permissions.deny.some((rule) => rule.startsWith('Read(')));
  assert.deepEqual(settings.permissions.deny.slice(-4), [
    'Skill(python)',
    'Skill(python *)',
    'Skill(vercel:nextjs)',
    'Skill(vercel:nextjs *)',
  ]);
  assert.deepEqual(settings.skillOverrides, { python: 'off' });
  assert.equal(given.filter((arg) => arg === '--settings').length, 1);

  await start('codex', { ...loader(null), off });
  await until(
    async () =>
      (await args(work, 'codex-args.json').catch(() => null)) !== null,
  );
  const codex = await args(work, 'codex-args.json');
  const rule = codex.indexOf(
    `skills.config=[{path="${python}",enabled=false}]`,
  );
  assert.equal(codex[rule - 1], '-c');
  assert.ok(rule < codex.indexOf('app-server'));

  // A task of the coordinator is no lab agent, and leaves them out too.
  await rm(join(work, 'args.json'));
  const manager = new SessionManager(root, {
    clientVersion: 'test',
    ownerId: 'test-owner',
    executables: { claude: join(root, 'fake-claude') },
    skills: { ...loader(null), off },
  });
  t.after(() => manager.close());
  await manager.startTask({
    host: 'claude',
    prompt: 'Go.',
    cwd: work,
    task: { id: 't-1', claim: 'c' },
  });
  await until(
    async () => (await args(work, 'args.json').catch(() => null)) !== null,
  );
  const task = await args(work, 'args.json');
  assert.ok(task[task.indexOf('--settings') + 1]?.includes('Skill(python)'));
  assert.ok(!task.includes('--plugin-dir'));
});
