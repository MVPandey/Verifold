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
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cardMarkdown,
  loadOwnChoices,
  ownChoicesReader,
  ownLimits,
  personProfile,
  profileReader,
  saveAgencyFile,
  skillsOff,
  writeOwnChoices,
  type OwnChange,
} from '../src/core/agency.ts';
import { Compute } from '../src/core/compute.ts';
import { KeyStore } from '../src/core/credentials.ts';
import { listOwnSkills, type OwnSkill } from '../src/core/own-skills.ts';
import {
  claudeSessionSettings,
  codexSkillsOff,
} from '../src/core/session-hosts.ts';
import { skillLoader } from '../src/core/skills.ts';
import { FirstRun } from '../src/server/setup.ts';

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

/** A fake Claude Code whose `plugin list --json` prints `list`. */
async function fakeClaude(base: string, list: string): Promise<string> {
  const path = join(base, `claude-${Math.random().toString(16).slice(2)}`);
  await writeFile(
    path,
    `#!${process.execPath}
if (process.argv.slice(2).join(' ') !== 'plugin list --json') process.exit(2);
process.stdout.write(${list});
`,
    { mode: 0o700 },
  );
  return path;
}

/**
 * A fake Codex. `answer`: `list` answers skills/list with `skills`, `refuse`
 * refuses it, and `never` never answers.
 */
async function fakeCodex(
  base: string,
  answer: 'list' | 'refuse' | 'never',
  skills: readonly unknown[] = [],
): Promise<string> {
  const path = join(base, `codex-${answer}`);
  await writeFile(
    path,
    `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('codex-cli 0.160.0'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(join(base, 'codex-args.json'))}, JSON.stringify(process.argv.slice(2)));
const { out, onLine } = require(${JSON.stringify(codexSocket)})(process.argv);
onLine((line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') out({ id: message.id, result: {} });
  if (message.method !== 'skills/list' || ${JSON.stringify(answer)} === 'never') return;
  if (${JSON.stringify(answer)} === 'refuse') return out({ id: message.id, error: { code: -32000, message: 'No.' } });
  out({ id: message.id, result: { data: [{ cwd: message.params.cwds[0], errors: [], skills: ${JSON.stringify(skills)} }] } });
});
`,
    { mode: 0o700 },
  );
  return path;
}

await test('the own skills: Claude Code folders and plugins, and Codex user and admin skills by path, without bundled or plugin ones', async (t) => {
  const base = await folder(t, 'own-skills');
  const config = join(base, 'claude-config');
  const skills = join(config, 'skills');
  await skill(skills, 'python', 'name: python\ndescription: Python style.');
  // The frontmatter's name is the listed one. The folder's name also invokes the skill, so both turn it off.
  await skill(skills, 'notes-folder', 'name: notes\ndescription: Notes.');
  // A folder without frontmatter, a hidden folder, and a name that cannot go into a rule stay out.
  await mkdir(join(skills, 'plain'), { recursive: true });
  await writeFile(join(skills, 'plain', 'SKILL.md'), 'No frontmatter.\n');
  await skill(join(skills, '.trash'), 'old', 'name: old\ndescription: x');
  await skill(skills, 'bad name', 'description: spaces');
  // A personal name with `:` could stand for a plugin's skill.
  await skill(skills, 'clash', 'name: vercel:clash\ndescription: x');
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
  const claude = await fakeClaude(
    base,
    JSON.stringify(
      JSON.stringify([
        {
          id: 'vercel@official',
          scope: 'user',
          enabled: true,
          installPath: plugin,
        },
        {
          id: 'review@official',
          scope: 'project',
          enabled: true,
          installPath: projectPlugin,
        },
        {
          id: 'off@official',
          scope: 'user',
          enabled: false,
          installPath: projectPlugin,
        },
        {
          id: 'relative@official',
          scope: 'user',
          enabled: true,
          installPath: 'plugins/review',
        },
      ]),
    ),
  );
  const python = '/home/p/.agents/skills/python/SKILL.md';
  const codex = await fakeCodex(base, 'list', [
    {
      name: 'python',
      description: 'Python style.',
      path: python,
      scope: 'user',
      enabled: true,
    },
    {
      name: 'docs',
      description: 'Docs.',
      path: '/home/p/.agents/skills/synced/org/docs/SKILL.md',
      scope: 'user',
      enabled: true,
    },
    {
      name: 'site',
      description: 'Site.',
      path: '/etc/codex/skills/site/SKILL.md',
      scope: 'admin',
      enabled: true,
    },
    {
      name: 'off-in-codex',
      description: 'x',
      path: '/home/p/.agents/skills/off/SKILL.md',
      scope: 'user',
      enabled: false,
    },
    {
      name: 'imagegen',
      description: 'x',
      path: '/home/p/.codex/skills/.system/imagegen/SKILL.md',
      scope: 'system',
      enabled: true,
    },
    {
      name: 'repo-skill',
      description: 'x',
      path: '/w/.agents/skills/r/SKILL.md',
      scope: 'repo',
      enabled: true,
    },
    {
      name: 'relative',
      description: 'x',
      path: 'skills/r/SKILL.md',
      scope: 'user',
      enabled: true,
    },
    {
      name: 'python',
      description: 'Twice.',
      path: '/home/p/.codex/skills/python/SKILL.md',
      scope: 'user',
      enabled: true,
    },
  ]);
  const { skills: found, problems } = await listOwnSkills({
    claude,
    codex,
    claudeConfig: config,
  });
  const names = (harness: string): string[] =>
    found
      .filter((entry) => entry.harness === harness)
      .map((entry) => `${entry.source} ${entry.name} ${entry.off.join(' ')}`)
      .sort();
  assert.deepEqual(names('claude'), [
    'personal linked linked',
    'personal notes notes notes-folder',
    'personal python python',
    'plugin vercel:deploy vercel:deploy',
    'plugin vercel:nextjs vercel:nextjs',
    'synced anthropic-skills:pdf anthropic-skills:pdf',
  ]);
  // Codex skills are told apart by path, so two of one name both show, each with its own rule.
  assert.deepEqual(names('codex'), [
    'admin site /etc/codex/skills/site/SKILL.md',
    `personal python ${python}`,
    'personal python /home/p/.codex/skills/python/SKILL.md',
    'synced docs /home/p/.agents/skills/synced/org/docs/SKILL.md',
  ]);
  assert.ok(
    found.every((entry) =>
      entry.harness === 'codex'
        ? entry.id === entry.off[0]
        : entry.id === entry.name,
    ),
  );
  assert.deepEqual(problems, [
    "Verifold leaves out 1 skill of your Claude Code skill folder whose names hold “:”, the mark of a plugin's skill.",
  ]);
  assert.equal(
    found.find((entry) => entry.name === 'anthropic-skills:pdf')?.description,
    'Read and fill PDFs.',
  );
  assert.equal(
    found.find((entry) => entry.name === 'vercel:nextjs')?.description.length,
    1024,
  );
  // The list has plugins off, as in a lab session.
  const codexArgs = JSON.parse(
    await readFile(join(base, 'codex-args.json'), 'utf8'),
  ) as string[];
  assert.ok(codexArgs.includes('features.plugins=false'));

  // Without the harnesses, nothing is listed, and nothing is wrong.
  assert.deepEqual(
    await listOwnSkills({
      claude: join(base, 'no-claude'),
      codex: join(base, 'no-codex'),
      claudeConfig: config,
    }),
    { skills: [], problems: [] },
  );
});

await test('the listing says what it could not list: a plugin list too long or not readable, a Codex that does not answer, and a cap', async (t) => {
  const base = await folder(t, 'own-problems');
  const config = join(base, 'claude-config');
  for (let index = 0; index < 305; index++)
    await skill(
      join(config, 'skills'),
      `skill-${index}`,
      `name: skill-${index}\ndescription: x`,
    );
  const long = await fakeClaude(base, `'[' + ' '.repeat(1100000) + ']'`);
  const refused = await fakeCodex(base, 'refuse');
  const first = await listOwnSkills({
    claude: long,
    codex: refused,
    claudeConfig: config,
  });
  assert.equal(first.skills.length, 300);
  assert.deepEqual([...first.problems].sort(), [
    'Claude Code loads more skills than Verifold lists. These are the first 300.',
    "Claude Code's plugin list is longer than 1 MB, so Verifold lists none of its plugin skills.",
    'Codex did not list its skills. Read the list again.',
  ]);
  const text = await fakeClaude(base, JSON.stringify('Unknown option --json'));
  assert.deepEqual(
    (
      await listOwnSkills({
        claude: text,
        codex: join(base, 'no-codex'),
        claudeConfig: join(base, 'none'),
      })
    ).problems,
    [
      "Verifold could not read Claude Code's plugin list, so it lists none of its plugin skills.",
    ],
  );
});

await test('a stop ends the listing at once, and stops its Codex app-server', async (t) => {
  const base = await folder(t, 'own-stop');
  const never = await fakeCodex(base, 'never');
  const controller = new AbortController();
  const started = Date.now();
  const listing = listOwnSkills({
    claude: join(base, 'no-claude'),
    codex: never,
    claudeConfig: join(base, 'none'),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(listing, { name: 'AbortError' });
  // Without the stop, the question to Codex waits 10 seconds.
  assert.ok(Date.now() - started < 5_000);
});

/** A change that turns a skill off, or on, with what turns it off. */
function change(
  harness: 'claude' | 'codex',
  name: string,
  use: boolean,
  when?: string,
): OwnChange {
  const id =
    harness === 'codex' ? `/home/p/.agents/skills/${name}/SKILL.md` : name;
  return {
    harness,
    id,
    name,
    use,
    off: [id],
    ...(when === undefined ? {} : { when }),
  };
}

/** A Codex skill's ID in the tests. */
const codexId = (name: string): string =>
  `/home/p/.agents/skills/${name}/SKILL.md`;

await test('the choices: stored compact by harness with what turns each skill off, within limits, and a bad entry is skipped and counted', async (t) => {
  const agency = join(await folder(t, 'own-choices'), 'agency');
  const empty = await loadOwnChoices(agency);
  assert.equal(empty.claude.size + empty.codex.size + empty.skipped, 0);
  await writeOwnChoices(agency, [
    change('claude', 'python', false, 'Never here.'),
    change('claude', 'humanizer', true, `  For text.${' x'.repeat(200)}`),
    change('codex', 'python', true, 'For scripts.'),
    change('codex', 'constructor', false),
  ]);
  let choices = await loadOwnChoices(agency);
  assert.deepEqual(choices.claude.get('python'), {
    name: 'python',
    use: false,
    when: 'Never here.',
    off: ['python'],
  });
  assert.equal(choices.claude.get('humanizer')?.when.length, 300);
  // A name that is also an object key of JavaScript is only a name.
  assert.deepEqual(skillsOff(choices, 'codex'), [
    '/home/p/.agents/skills/constructor/SKILL.md',
  ]);
  assert.deepEqual(skillsOff(choices, 'claude'), ['python']);
  // Without `when`, the note stays. A Yes with no note stays as a choice.
  await writeOwnChoices(agency, [
    change('claude', 'python', true),
    change('codex', 'python', true, ''),
  ]);
  choices = await loadOwnChoices(agency);
  assert.deepEqual(choices.claude.get('python'), {
    name: 'python',
    use: true,
    when: 'Never here.',
    off: [],
  });
  assert.deepEqual(choices.codex.get(codexId('python')), {
    name: 'python',
    use: true,
    when: '',
    off: [],
  });
  const raw = await readFile(join(agency, 'own-skills.json'), 'utf8');
  assert.doesNotMatch(raw, /\n/);
  assert.deepEqual(
    (JSON.parse(raw) as { skills: { codex: unknown } }).skills.codex,
    {
      [codexId('python')]: { name: 'python', use: true },
      [codexId('constructor')]: {
        name: 'constructor',
        use: false,
        off: [codexId('constructor')],
      },
    },
  );
  // A No without a target, or a path that cannot go into a TOML string, is refused.
  for (const off of [['rel/SKILL.md'], ['/a\x7fb/SKILL.md'], []])
    await assert.rejects(
      writeOwnChoices(agency, [{ ...change('codex', 'x', false), off }]),
      /cannot turn off x/,
    );
  // More choices than the limit are refused before anything is written.
  await assert.rejects(
    writeOwnChoices(
      agency,
      Array.from({ length: ownLimits.choices }, (_, index) =>
        change('claude', `skill-${index}`, false),
      ),
    ),
    /at most 600 skills/,
  );
  assert.equal(await readFile(join(agency, 'own-skills.json'), 'utf8'), raw);
  // A bad entry is skipped and counted. The rest still reads.
  await writeFile(
    join(agency, 'own-skills.json'),
    JSON.stringify({
      schemaVersion: 1,
      skills: {
        claude: {
          'a b': { use: false, off: ['a b'] },
          python: { use: false, off: ['python'] },
          lost: { use: false },
          long: { use: true, when: 'x'.repeat(301) },
        },
        codex: 'no',
      },
    }),
  );
  choices = await loadOwnChoices(agency);
  assert.deepEqual([...choices.claude.keys()], ['python']);
  assert.equal(choices.skipped, 4);
  // A file that is not the choices at all cannot be read. A save moves it aside and starts again.
  for (const bad of ['{"schemaVersion":2}', '{}', '{']) {
    await writeFile(join(agency, 'own-skills.json'), bad);
    await assert.rejects(loadOwnChoices(agency), /not valid|JSON/);
    assert.match(
      (await writeOwnChoices(agency, [change('claude', 'python', false)])) ??
        '',
      /own-skills\.json\.bad$/,
    );
    assert.equal(
      await readFile(join(agency, 'own-skills.json.bad'), 'utf8'),
      bad,
    );
    assert.deepEqual(skillsOff(await loadOwnChoices(agency), 'claude'), [
      'python',
    ]);
  }
  // A readable file is never moved.
  assert.equal(
    await writeOwnChoices(agency, [change('claude', 'ruby', false)]),
    null,
  );
});

await test('the choices reader reads the file again only when it changed', async (t) => {
  const agency = join(await folder(t, 'own-reader'), 'agency');
  const read = ownChoicesReader(agency);
  const none = await read();
  assert.equal(none?.claude.size, 0);
  assert.equal(await read(), none);
  await writeOwnChoices(agency, [change('claude', 'python', false)]);
  const first = await read();
  assert.equal(first?.claude.size, 1);
  assert.equal(await read(), first);
  await writeFile(join(agency, 'own-skills.json'), '{');
  assert.equal(await read(), null);
});

await test("each agent gets the notes on its own harness's skills with the profile, and the reader reads them again when they change", async (t) => {
  const agency = join(await folder(t, 'own-notes'), 'agency');
  assert.equal(await personProfile(agency), null);
  await writeOwnChoices(agency, [
    change('claude', 'humanizer', true, 'For text the person reads.'),
    change('codex', 'python', false, 'For scripts.'),
  ]);
  // Notes without a profile: only the notes, and only for skills that load.
  assert.deepEqual(await personProfile(agency), {
    whole: '',
    style: null,
    skills: { claude: '- humanizer: For text the person reads.' },
  });
  const read = profileReader(agency);
  await saveAgencyFile(
    agency,
    'USER.md',
    cardMarkdown({ workOn: 'Graphs.', explore: '', talk: 'Short.' }),
  );
  assert.equal((await read())?.style, 'Short.');
  await writeOwnChoices(agency, [change('codex', 'python', true)]);
  assert.deepEqual((await read())?.skills, {
    claude: '- humanizer: For text the person reads.',
    codex: '- python: For scripts.',
  });
  // Choices that cannot be read add no notes, and the profile still reads.
  await writeFile(join(agency, 'own-skills.json'), '{');
  assert.deepEqual(await personProfile(agency), {
    whole:
      'The person works on: Graphs.\nHow they want agents to write to them: Short.',
    style: 'Short.',
  });
});

await test('the session settings: deny rules for each name of a skill that is off, skillOverrides for skill-folder names, and Codex rules by path', () => {
  assert.equal(claudeSessionSettings({ mode: 'auto' }), null);
  const loose = JSON.parse(
    claudeSessionSettings({
      mode: 'auto',
      skillsOff: ['notes', 'notes-folder', 'vercel:nextjs'],
    }) ?? '{}',
  ) as Record<string, unknown>;
  assert.deepEqual(loose, {
    permissions: {
      deny: [
        'Skill(notes)',
        'Skill(notes *)',
        'Skill(notes-folder)',
        'Skill(notes-folder *)',
        'Skill(vercel:nextjs)',
        'Skill(vercel:nextjs *)',
      ],
    },
    skillOverrides: { notes: 'off', 'notes-folder': 'off' },
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
  assert.deepEqual(
    codexSkillsOff([
      '/home/p/.agents/skills/python/SKILL.md',
      '/a "b"/SKILL.md',
    ]),
    [
      '-c',
      'skills.config=[{path="/home/p/.agents/skills/python/SKILL.md",enabled=false},{path="/a \\"b\\"/SKILL.md",enabled=false}]',
    ],
  );
});

await test('the session loader reads the skills that are off at each launch, and says plainly when it cannot read the file', async (t) => {
  const base = await folder(t, 'own-loader');
  const agency = join(base, 'agency');
  const told: string[] = [];
  // Before the lab exists, nothing takes a note, so it comes again at the next launch.
  let lab = false;
  const loader = skillLoader(agency, join(base, 'plugins'), (text) => {
    if (lab) told.push(text);
    return lab;
  });
  await mkdir(agency, { recursive: true });
  await writeFile(join(agency, 'own-skills.json'), '{');
  assert.deepEqual(await loader.off?.('claude'), []);
  assert.deepEqual(told, []);
  lab = true;
  assert.deepEqual(await loader.off?.('claude'), []);
  assert.equal(told.length, 1);
  assert.match(
    told[0] ?? '',
    /^Verifold could not read .*agency\/own-skills\.json, so agents load all your skills\.$/,
  );
  told.length = 0;
  await rm(join(agency, 'own-skills.json'));
  assert.deepEqual(await loader.off?.('claude'), []);
  await writeOwnChoices(agency, [change('claude', 'python', false)]);
  assert.deepEqual(await loader.off?.('claude'), ['python']);
  assert.deepEqual(await loader.off?.('codex'), []);
  await writeFile(
    join(agency, 'own-skills.json'),
    JSON.stringify({
      schemaVersion: 1,
      skills: { claude: { python: { use: false, off: ['python'] }, bad: 1 } },
    }),
  );
  assert.deepEqual(await loader.off?.('claude'), ['python']);
  await writeFile(join(agency, 'own-skills.json'), '{');
  assert.deepEqual(await loader.off?.('claude'), []);
  assert.deepEqual(await loader.off?.('codex'), []);
  // Each note comes once: the one about the unreadable file came already.
  assert.equal(told.length, 1);
  assert.match(
    told[0] ?? '',
    /^Verifold skipped 1 entry of .*own-skills\.json that it could not read\. Agents load those skills\.$/,
  );
});

await test('the Skills step lists the own skills only when asked, keeps a list with skills, and saves choices for listed skills', async (t) => {
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
  const signals: AbortSignal[] = [];
  let release: () => void = () => {};
  let next: OwnSkill[] = [];
  const own: OwnSkill[] = [
    {
      harness: 'claude',
      id: 'python',
      name: 'python',
      description: 'Style.',
      source: 'personal',
      off: ['python'],
    },
    {
      harness: 'codex',
      id: codexId('python'),
      name: 'python',
      description: 'Style.',
      source: 'personal',
      off: [codexId('python')],
    },
  ];
  const controller = new AbortController();
  const setup = new FirstRun({
    directory: agency,
    compute,
    signal: controller.signal,
    detect: () => Promise.resolve([]),
    installed: () => Promise.resolve(['claude']),
    ownSkills: async (signal) => {
      signals.push(signal);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { skills: next, problems: [] };
    },
  });
  const settle = async (): Promise<void> => {
    release();
    for (let tries = 0; tries < 100; tries++) {
      if (!(await setup.view()).skills?.ownReading) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  // A plain read lists nothing.
  let skills = (await setup.view()).skills;
  assert.equal(signals.length, 0);
  assert.equal(skills?.own, undefined);
  assert.equal(skills?.ownReading, false);
  assert.equal(skills?.noteLimit, 300);
  await assert.rejects(
    setup.act({
      action: 'setup-own-skills',
      choices: [{ harness: 'claude', id: 'python', use: false }],
    }),
    /has not listed your skills yet/,
  );
  // An empty list is not kept: the next request lists again.
  assert.equal(await setup.act({ action: 'setup-own-skills-list' }), 202);
  assert.equal((await setup.view()).skills?.ownReading, true);
  await settle();
  assert.deepEqual((await setup.view()).skills?.own, []);
  next = own;
  assert.equal(await setup.act({ action: 'setup-own-skills-list' }), 202);
  await settle();
  // The listing stops with the desk.
  assert.equal(signals[0], controller.signal);
  skills = (await setup.view()).skills;
  assert.deepEqual(
    skills?.own?.map((skill) => [skill.harness, skill.use, skill.when]),
    [
      ['claude', true, ''],
      ['codex', true, ''],
    ],
  );
  // A list with skills serves until the person reads it again.
  assert.equal(await setup.act({ action: 'setup-own-skills-list' }), 200);
  assert.equal(signals.length, 2);
  assert.equal(
    await setup.act({ action: 'setup-own-skills-list', again: true }),
    202,
  );
  await settle();
  assert.equal(signals.length, 3);
  assert.equal(
    await setup.act({
      action: 'setup-own-skills',
      choices: [
        { harness: 'claude', id: 'python', use: false },
        {
          harness: 'codex',
          id: codexId('python'),
          use: false,
          when: 'For scripts.',
        },
      ],
    }),
    200,
  );
  skills = (await setup.view()).skills;
  assert.deepEqual(
    skills?.own?.map((skill) => [skill.harness, skill.use, skill.when]),
    [
      ['claude', false, ''],
      ['codex', false, 'For scripts.'],
    ],
  );
  // A group's switch sends many choices without notes. Each saved note stays.
  assert.equal(
    await setup.act({
      action: 'setup-own-skills',
      choices: [
        { harness: 'claude', id: 'python', use: true },
        { harness: 'codex', id: codexId('python'), use: true },
      ],
    }),
    200,
  );
  assert.deepEqual(
    (await setup.view()).skills?.own?.map((skill) => [
      skill.harness,
      skill.use,
      skill.when,
    ]),
    [
      ['claude', true, ''],
      ['codex', true, 'For scripts.'],
    ],
  );
  assert.equal(
    await setup.act({
      action: 'setup-own-skills',
      choices: [
        { harness: 'claude', id: 'python', use: false },
        { harness: 'codex', id: codexId('python'), use: false },
      ],
    }),
    200,
  );
  // The view names each skill by its ID, never by what turns it off. The file keeps that, from the list.
  assert.equal(skills?.own?.[1]?.id, codexId('python'));
  assert.doesNotMatch(JSON.stringify(skills), /"off"/);
  const choices = await loadOwnChoices(agency);
  assert.deepEqual(skillsOff(choices, 'codex'), [
    '/home/p/.agents/skills/python/SKILL.md',
  ]);
  for (const [sent, reason] of [
    [[], /from 1 to 600/],
    [[{ harness: 'gemini', id: 'python', use: true }], /harness/],
    [[{ harness: 'claude', id: 'bad name', use: true }], /the skill/],
    [[{ harness: 'codex', id: 'python', use: true }], /the skill/],
    [[{ harness: 'claude', id: 'python', use: 'yes' }], /yes or no/],
    [
      [{ harness: 'claude', id: 'python', use: true, when: 'x'.repeat(301) }],
      /at most 300/,
    ],
    [
      [{ harness: 'claude', id: 'ruby', use: false }],
      /does not list that skill/,
    ],
  ] as const)
    await assert.rejects(
      setup.act({ action: 'setup-own-skills', choices: sent }),
      reason,
    );
  // A file that cannot be read says so on the step, and a save moves it aside and says so too.
  await writeFile(join(agency, 'own-skills.json'), '{');
  assert.match(
    ((await setup.view()).skills?.ownProblems ?? []).join(' '),
    /could not read .*own-skills\.json, so agents load all your skills/,
  );
  assert.equal(
    await setup.act({
      action: 'setup-own-skills',
      choices: [{ harness: 'claude', id: 'python', use: false }],
    }),
    200,
  );
  assert.deepEqual((await setup.view()).skills?.ownProblems, [
    `Verifold could not read the earlier choices, so it kept them as ${join(agency, 'own-skills.json.bad').replace(homedir(), '~')} and started a new file.`,
  ]);
});
