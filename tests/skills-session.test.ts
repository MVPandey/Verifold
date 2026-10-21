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
if (dir && dir.includes('blocked')) {
  process.stderr.write('Error: --plugin-dir is not allowed by your organization (disableSideloadFlags).\\n');
  process.exit(1);
}
if (dir) {
  const skills = require('node:path').join(dir, 'skills');
  const read = fs.readdirSync(skills).map((name) => fs.readFileSync(require('node:path').join(skills, name, 'SKILL.md'), 'utf8'));
  fs.writeFileSync('read.txt', read.join('\\n'));
}
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
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
  } else if (message.method === 'skills/list')
    out({ id: message.id, result: { data: [{ cwd: message.params.cwds[0], skills: roots.map((root) => ({ name: 'transformer-lens', path: root + '/transformer-lens/SKILL.md', description: 'x', enabled: true, scope: 'user' })), errors: [] }] } });
  else if (message.method === 'model/list') out({ id: message.id, result: { data: [], nextCursor: null } });
  else if (message.method === 'thread/start') out({ id: message.id, result: { thread: { id: 'thread-1' }, model: 'fake', approvalsReviewer: 'user' } });
  else if (message.method === 'turn/start') {
    out({ id: message.id, result: { turn: { id: 'turn-1' } } });
    out({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  }
});`;

async function project(t: test.TestContext): Promise<{
  readonly root: string;
  readonly work: string;
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

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let tries = 0; tries < 250; tries++) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error('The session did not get there.');
}

function loader(folder: string | null): SessionSkills & {
  readonly problems: (readonly [HarnessName, string])[];
} {
  const problems: (readonly [HarnessName, string])[] = [];
  return {
    problems,
    folder: () => Promise.resolve(folder),
    problem: (host, text) => problems.push([host, text]),
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
  const { root, work, start } = await project(t);
  const folder = await plugin(root, 'plugins-1a2b3c4d5e6f7a8b');
  const ok = loader(folder);
  await start('claude', ok);
  await until(() => existsSync(join(work, 'args.json')));
  const given = await args(work, 'args.json');
  assert.equal(given[given.indexOf('--plugin-dir') + 1], folder);
  // The start event lists the plugin, so nothing is reported.
  await delay(200);
  assert.deepEqual(ok.problems, []);

  await rm(join(work, 'args.json'));
  const none = loader(null);
  await start('claude', none);
  await until(() => existsSync(join(work, 'args.json')));
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

  const blocked = loader(await plugin(root, 'blocked-plugin'));
  const manager = await start('claude', blocked);
  await until(() => blocked.problems.length > 0);
  assert.deepEqual(blocked.problems, [
    [
      'claude',
      "Your organization's Claude Code settings block added skills, so agents run without them.",
    ],
  ]);
  await until(() => manager.view()?.record.status === 'failed');
});

await test('Codex sets the skill root before the thread starts, with MCP dependency installs off, and an old Codex runs without it', async (t) => {
  const { root, work, start } = await project(t);
  const folder = await plugin(root, 'plugins-0011223344556677');
  const ok = loader(folder);
  await start('codex', ok);
  await until(async () =>
    (await readFile(join(work, 'rpc.jsonl'), 'utf8').catch(() => '')).includes(
      'thread/start',
    ),
  );
  const given = await args(work, 'codex-args.json');
  assert.ok(given.includes('--disable'));
  assert.equal(
    given[given.indexOf('--disable') + 1],
    'skill_mcp_dependency_install',
  );
  const methods = (await readFile(join(work, 'rpc.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { method?: string }).method);
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

  // An old Codex has no skill methods: the thread starts all the same.
  await rm(join(work, 'rpc.jsonl'));
  await writeFile(join(work, 'old-codex'), '');
  const old = loader(folder);
  await start('codex', old);
  await until(async () =>
    (await readFile(join(work, 'rpc.jsonl'), 'utf8').catch(() => '')).includes(
      'thread/start',
    ),
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
    (await readFile(join(work, 'rpc.jsonl'), 'utf8').catch(() => '')).includes(
      'thread/start',
    ),
  );
  assert.ok(!(await args(work, 'codex-args.json')).includes('--disable'));
  assert.ok(
    !(await readFile(join(work, 'rpc.jsonl'), 'utf8')).includes('skills/'),
  );
});

await test('with the profile folder unreadable, both harnesses read the added skill through the copy that the loader builds', async (t) => {
  const { root, work, start } = await project(t);
  // A skill that the person added, as addSkill keeps it in the profile folder.
  const agency = join(root, 'agency');
  const commit = 'c'.repeat(40);
  const store = join(
    agency,
    'skills',
    'Orchestra-Research',
    'AI-Research-SKILLs',
    commit,
    '04-mechanistic-interpretability',
    'transformer-lens',
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
    await until(() => existsSync(join(work, 'read.txt')));
    assert.match(
      await readFile(join(work, 'read.txt'), 'utf8'),
      /Activation patching/,
    );
    await start('codex', skills);
    await until(() => existsSync(join(work, 'codex-read.txt')));
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
