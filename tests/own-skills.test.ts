import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cardMarkdown,
  loadOwnChoices,
  personProfile,
  profileReader,
  saveAgencyFile,
  skillsOff,
  writeOwnChoices,
} from '../src/core/agency.ts';
import { Compute } from '../src/core/compute.ts';
import { KeyStore } from '../src/core/credentials.ts';
import { listOwnSkills, type OwnSkill } from '../src/core/own-skills.ts';
import { skillLoader } from '../src/core/skills.ts';
import { FirstRun } from '../src/server/setup.ts';
import {
  claudeSessionSettings,
  codexSkillsOff,
} from '../src/core/session-hosts.ts';

const codexSocket = fileURLToPath(
  new URL('./fixtures/codex-socket.cjs', import.meta.url),
);

async function folder(t: test.TestContext, name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `verifold-${name}-`));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function skill(
  root: string,
  folderName: string,
  front: string,
): Promise<void> {
  await mkdir(join(root, folderName), { recursive: true });
  await writeFile(
    join(root, folderName, 'SKILL.md'),
    `---\n${front}\n---\n\nBody.\n`,
  );
}

await test('the own skills: Claude Code folders and plugins, and Codex user and admin skills, without bundled or plugin ones', async (t) => {
  const base = await folder(t, 'own-skills');
  const config = join(base, 'claude-config');
  const skills = join(config, 'skills');
  await skill(skills, 'python', 'name: python\ndescription: Python style.');
  // The frontmatter's name wins over the folder's.
  await skill(skills, 'notes-folder', 'name: notes\ndescription: Notes.');
  // A folder without frontmatter, a hidden folder, and a name that cannot go into a rule stay out.
  await mkdir(join(skills, 'plain'), { recursive: true });
  await writeFile(join(skills, 'plain', 'SKILL.md'), 'No frontmatter.\n');
  await skill(join(skills, '.trash'), 'old', 'name: old\ndescription: x');
  await skill(skills, 'bad name', 'description: spaces');
  // A linked skill folder counts.
  await skill(join(base, 'shared'), 'linked', 'name: linked\ndescription: L');
  await symlink(join(base, 'shared', 'linked'), join(skills, 'linked'));
  await skill(
    join(skills, 'synced', 'org-1'),
    'pdf',
    'name: pdf\ndescription: >\n  Read and\n  fill PDFs.',
  );
  const plugin = join(base, 'plugins', 'vercel');
  await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(plugin, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'vercel', skills: ['./extra/', '../outside'] }),
  );
  await skill(
    join(plugin, 'skills'),
    'nextjs',
    `name: nextjs\ndescription: ${'n'.repeat(1100)}`,
  );
  await skill(join(plugin, 'extra'), 'deploy', 'description: Deploys.');
  await skill(join(base, 'plugins'), 'outside', 'description: Not this.');
  const projectPlugin = join(base, 'plugins', 'review');
  await skill(join(projectPlugin, 'skills'), 'review', 'description: x');
  const fakeClaude = join(base, 'claude');
  await writeFile(
    fakeClaude,
    `#!${process.execPath}
if (process.argv.slice(2).join(' ') !== 'plugin list --json') process.exit(2);
console.log(JSON.stringify([
  { id: 'vercel@official', scope: 'user', enabled: true, installPath: ${JSON.stringify(plugin)} },
  { id: 'review@official', scope: 'project', enabled: true, installPath: ${JSON.stringify(projectPlugin)} },
  { id: 'off@official', scope: 'user', enabled: false, installPath: ${JSON.stringify(projectPlugin)} },
  { id: 'relative@official', scope: 'user', enabled: true, installPath: 'plugins/review' },
]));
`,
    { mode: 0o700 },
  );
  const fakeCodex = join(base, 'codex');
  await writeFile(
    fakeCodex,
    `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(join(base, 'codex-args.json'))}, JSON.stringify(process.argv.slice(2)));
const { out, onLine } = require(${JSON.stringify(codexSocket)})(process.argv);
onLine((line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') out({ id: message.id, result: {} });
  if (message.method !== 'skills/list') return;
  out({ id: message.id, result: { data: [{ cwd: message.params.cwds[0], errors: [], skills: [
    { name: 'python', description: 'Python style.', path: '/home/p/.agents/skills/python/SKILL.md', scope: 'user', enabled: true },
    { name: 'docs', description: 'Docs.', path: '/home/p/.agents/skills/synced/org/docs/SKILL.md', scope: 'user', enabled: true },
    { name: 'site', description: 'Site.', path: '/etc/codex/skills/site/SKILL.md', scope: 'admin', enabled: true },
    { name: 'off-in-codex', description: 'x', path: '/home/p/.agents/skills/off/SKILL.md', scope: 'user', enabled: false },
    { name: 'imagegen', description: 'x', path: '/home/p/.codex/skills/.system/imagegen/SKILL.md', scope: 'system', enabled: true },
    { name: 'repo-skill', description: 'x', path: '/w/.agents/skills/r/SKILL.md', scope: 'repo', enabled: true },
    { name: 'python', description: 'Twice.', path: '/home/p/.codex/skills/python/SKILL.md', scope: 'user', enabled: true },
  ] }] } });
});
`,
    { mode: 0o700 },
  );
  const found = await listOwnSkills({
    claude: fakeClaude,
    codex: fakeCodex,
    claudeConfig: config,
  });
  const names = (harness: string): string[] =>
    found
      .filter((entry) => entry.harness === harness)
      .map((entry) => `${entry.source} ${entry.name}`)
      .sort();
  assert.deepEqual(names('claude'), [
    'personal linked',
    'personal notes',
    'personal python',
    'plugin vercel:deploy',
    'plugin vercel:nextjs',
    'synced anthropic-skills:pdf',
  ]);
  // Each name once per harness, the first one kept.
  assert.deepEqual(names('codex'), [
    'admin site',
    'personal python',
    'synced docs',
  ]);
  assert.equal(
    found.find((entry) => entry.name === 'anthropic-skills:pdf')?.description,
    'Read and fill PDFs.',
  );
  assert.equal(
    found.find((entry) => entry.name === 'vercel:nextjs')?.description.length,
    1024,
  );
  assert.equal(
    found.find((entry) => entry.harness === 'codex' && entry.name === 'python')
      ?.description,
    'Python style.',
  );
  // The list has plugins off, as in a lab session.
  const codexArgs = JSON.parse(
    await readFile(join(base, 'codex-args.json'), 'utf8'),
  ) as string[];
  assert.ok(codexArgs.includes('features.plugins=false'));

  // Without the harnesses, nothing is listed.
  assert.deepEqual(
    await listOwnSkills({
      claude: join(base, 'no-claude'),
      codex: join(base, 'no-codex'),
      claudeConfig: config,
    }),
    [],
  );
});

await test('the choices: stored by harness, a note kept until changed, and a skill that loads with no note needs no entry', async (t) => {
  const agency = join(await folder(t, 'own-choices'), 'agency');
  const empty = await loadOwnChoices(agency);
  assert.equal(empty.claude.size + empty.codex.size, 0);
  await writeOwnChoices(agency, [
    { harness: 'claude', name: 'python', use: false, when: 'Never here.' },
    {
      harness: 'claude',
      name: 'humanizer',
      use: true,
      when: `  For text the person reads.${' x'.repeat(200)}`,
    },
    { harness: 'codex', name: 'python', use: true, when: 'For scripts.' },
    { harness: 'codex', name: 'constructor', use: false },
  ]);
  let choices = await loadOwnChoices(agency);
  assert.deepEqual(choices.claude.get('python'), {
    use: false,
    when: 'Never here.',
  });
  assert.equal(choices.claude.get('humanizer')?.when.length, 300);
  assert.match(
    choices.claude.get('humanizer')?.when ?? '',
    /^For text the person reads/,
  );
  // A name that is also an object key of JavaScript is only a name.
  assert.deepEqual(skillsOff(choices, 'codex'), ['constructor']);
  assert.deepEqual(skillsOff(choices, 'claude'), ['python']);
  // Without `when`, the note stays. Yes with no note leaves no entry.
  await writeOwnChoices(agency, [
    { harness: 'claude', name: 'python', use: true },
    { harness: 'codex', name: 'python', use: true, when: '' },
  ]);
  choices = await loadOwnChoices(agency);
  assert.deepEqual(choices.claude.get('python'), {
    use: true,
    when: 'Never here.',
  });
  assert.equal(choices.codex.has('python'), false);
  const file = JSON.parse(
    await readFile(join(agency, 'own-skills.json'), 'utf8'),
  ) as { skills: { codex: Record<string, unknown> } };
  assert.deepEqual(file.skills.codex, { constructor: { use: false } });
  await writeFile(
    join(agency, 'own-skills.json'),
    JSON.stringify({
      schemaVersion: 1,
      skills: { claude: { 'a b': { use: false } } },
    }),
  );
  await assert.rejects(loadOwnChoices(agency), /not valid/);
});

await test('the notes on skills go to every agent with the profile, and the reader reads them again when they change', async (t) => {
  const agency = join(await folder(t, 'own-notes'), 'agency');
  assert.equal(await personProfile(agency), null);
  await writeOwnChoices(agency, [
    {
      harness: 'claude',
      name: 'humanizer',
      use: true,
      when: 'For text the person reads.',
    },
    { harness: 'codex', name: 'python', use: false, when: 'For scripts.' },
  ]);
  // Notes without a profile: only the notes, and only for skills that load.
  assert.deepEqual(await personProfile(agency), {
    whole: '',
    style: null,
    skills: '- humanizer (Claude Code): For text the person reads.',
  });
  const read = profileReader(agency);
  await saveAgencyFile(
    agency,
    'USER.md',
    cardMarkdown({ workOn: 'Graphs.', explore: '', talk: 'Short.' }),
  );
  assert.equal((await read())?.style, 'Short.');
  await writeOwnChoices(agency, [
    { harness: 'codex', name: 'python', use: true },
  ]);
  assert.equal(
    (await read())?.skills,
    '- humanizer (Claude Code): For text the person reads.\n- python (Codex): For scripts.',
  );
  // Choices that cannot be read add no notes, and the profile still reads.
  await writeFile(join(agency, 'own-skills.json'), '{');
  assert.deepEqual(await personProfile(agency), {
    whole:
      'The person works on: Graphs.\nHow they want agents to write to them: Short.',
    style: 'Short.',
  });
});

await test('the session settings: deny rules for each skill that is off, skillOverrides for skill-folder skills, merged with strict mode', () => {
  assert.equal(claudeSessionSettings({ mode: 'auto' }), null);
  const loose = JSON.parse(
    claudeSessionSettings({
      mode: 'auto',
      skillsOff: ['python', 'vercel:nextjs'],
    }) ?? '{}',
  ) as Record<string, unknown>;
  assert.deepEqual(loose, {
    permissions: {
      deny: [
        'Skill(python)',
        'Skill(python *)',
        'Skill(vercel:nextjs)',
        'Skill(vercel:nextjs *)',
      ],
    },
    skillOverrides: { python: 'off' },
  });
  const strict = JSON.parse(
    claudeSessionSettings({
      mode: 'strict',
      denyRead: ['/records'],
      skillsOff: ['anthropic-skills:pdf'],
    }) ?? '{}',
  ) as {
    sandbox: { enabled: boolean };
    permissions: { allow: string[]; deny: string[] };
    skillOverrides?: unknown;
  };
  assert.equal(strict.sandbox.enabled, true);
  assert.ok(strict.permissions.allow.includes('Edit(./**)'));
  assert.ok(strict.permissions.deny.includes('Read(//records)'));
  assert.deepEqual(strict.permissions.deny.slice(-2), [
    'Skill(anthropic-skills:pdf)',
    'Skill(anthropic-skills:pdf *)',
  ]);
  // skillOverrides does not reach claude.ai or plugin skills, so they get none.
  assert.equal(strict.skillOverrides, undefined);
  assert.deepEqual(codexSkillsOff([]), []);
  assert.deepEqual(codexSkillsOff(['python', 'humanizer:humanizer']), [
    '-c',
    'skills.config=[{name="python",enabled=false},{name="humanizer:humanizer",enabled=false}]',
  ]);
});

await test('the session loader reads the skills that are off at each launch, and choices it cannot read turn none off', async (t) => {
  const base = await folder(t, 'own-loader');
  const agency = join(base, 'agency');
  const told: string[] = [];
  const loader = skillLoader(agency, join(base, 'plugins'), (text) =>
    told.push(text),
  );
  assert.deepEqual(await loader.off?.('claude'), []);
  await writeOwnChoices(agency, [
    { harness: 'claude', name: 'python', use: false },
  ]);
  assert.deepEqual(await loader.off?.('claude'), ['python']);
  assert.deepEqual(await loader.off?.('codex'), []);
  await writeFile(join(agency, 'own-skills.json'), '{');
  assert.deepEqual(await loader.off?.('claude'), []);
  assert.deepEqual(await loader.off?.('codex'), []);
  assert.equal(told.length, 1);
  assert.match(told[0] ?? '', /agents load all of them/);
});

await test('the Skills step lists the own skills once, with each choice, and saves several choices in one request', async (t) => {
  const root = await folder(t, 'own-step');
  const agency = join(root, 'agency');
  const compute = new Compute(root, {
    store: new KeyStore({
      home: root,
      platform: 'linux',
      secretTool: join(root, 'none'),
    }),
  });
  await compute.load();
  let lists = 0;
  let release: () => void = () => {};
  const listed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const own: OwnSkill[] = [
    {
      harness: 'claude',
      name: 'python',
      description: 'Style.',
      source: 'personal',
    },
    {
      harness: 'codex',
      name: 'python',
      description: 'Style.',
      source: 'personal',
    },
  ];
  const setup = new FirstRun({
    directory: agency,
    compute,
    signal: new AbortController().signal,
    detect: () => Promise.resolve([]),
    installed: () => Promise.resolve(['claude']),
    ownSkills: async () => {
      lists += 1;
      await listed;
      return own;
    },
  });
  let skills = (await setup.view()).skills;
  assert.equal(skills?.ownReading, true);
  assert.deepEqual(skills?.own, []);
  release();
  for (let tries = 0; tries < 100 && skills?.ownReading; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    skills = (await setup.view()).skills;
  }
  assert.equal(skills?.ownReading, false);
  assert.deepEqual(
    skills?.own?.map((skill) => [skill.harness, skill.use, skill.when]),
    [
      ['claude', true, ''],
      ['codex', true, ''],
    ],
  );
  assert.equal(
    await setup.act({
      action: 'setup-own-skills',
      choices: [
        { harness: 'claude', name: 'python', use: false },
        { harness: 'codex', name: 'python', use: true, when: 'For scripts.' },
      ],
    }),
    200,
  );
  skills = (await setup.view()).skills;
  assert.deepEqual(
    skills?.own?.map((skill) => [skill.harness, skill.use, skill.when]),
    [
      ['claude', false, ''],
      ['codex', true, 'For scripts.'],
    ],
  );
  // The list is read once while it is new.
  assert.equal(lists, 1);
  for (const [choices, reason] of [
    [[], /from 1 to 600/],
    [[{ harness: 'gemini', name: 'python', use: true }], /harness/],
    [[{ harness: 'claude', name: 'bad name', use: true }], /skill name/],
    [[{ harness: 'claude', name: 'python', use: 'yes' }], /yes or no/],
    [
      [{ harness: 'claude', name: 'python', use: true, when: 'x'.repeat(301) }],
      /at most 300/,
    ],
  ] as const)
    await assert.rejects(
      setup.act({ action: 'setup-own-skills', choices }),
      reason,
    );
});
