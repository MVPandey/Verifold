import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadOwnChoices, writeSettings } from '../src/core/agency.ts';
import { Compute } from '../src/core/compute.ts';
import { KeyStore } from '../src/core/credentials.ts';
import { claudeChoices, type HarnessStatus } from '../src/core/detect.ts';
import type { HarnessRequest, HarnessResult } from '../src/core/harness.ts';
import type { OwnSkill } from '../src/core/own-skills.ts';
import {
  claudeFolder,
  claudeMemory,
  codexClosed,
  importProfile,
} from '../src/core/profile-import.ts';
import { SessionActionError } from '../src/core/session.ts';
import {
  copyGlobalProfile,
  ownProfileFolder,
} from '../src/core/project-profile.ts';
import { FirstRun, FirstRuns } from '../src/server/setup.ts';
import type { SetupView } from '../src/protocol/api.ts';

async function folder(t: test.TestContext, name: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `verifold-${name}-`));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

const signal = new AbortController().signal;

const skills: readonly OwnSkill[] = [
  {
    harness: 'claude',
    id: 'research-paper-writing',
    name: 'research-paper-writing',
    description: 'Improve ML papers.',
    source: 'personal',
    off: ['research-paper-writing'],
  },
  {
    harness: 'claude',
    id: 'vercel:deploy',
    name: 'vercel:deploy',
    description: 'Deploy to Vercel.',
    source: 'plugin',
    off: ['vercel:deploy'],
  },
  {
    harness: 'codex',
    id: '/home/p/.agents/skills/python/SKILL.md',
    name: 'python',
    description: 'Python style.',
    source: 'personal',
    off: ['/home/p/.agents/skills/python/SKILL.md'],
  },
];

/** A memory folder of the fake Claude Code settings folder. */
function memoryOf(config: string, name: string): string {
  return join(config, 'projects', name, 'memory');
}

/**
 * A Claude Code settings folder: one memory folder whose MEMORY.md changed
 * last, one without MEMORY.md and with seven notes, eleven older ones with
 * one note each (p0, the newest, to p10), transcripts and settings beside
 * them, two memory folders without a note, two between "new" and "old"
 * whose names hold rule syntax or a backslash, and a project without memory.
 */
async function fakeClaude(base: string): Promise<string> {
  const config = join(base, 'claude');
  const memory = (name: string): string => memoryOf(config, name);
  const older = Array.from({ length: 11 }, (_, index) => `p${index}`);
  const odd = ['odd (x)', 'odd\\x'];
  for (const name of ['new', 'old', 'empty', 'other', ...odd, ...older])
    await mkdir(memory(name), { recursive: true });
  await mkdir(join(config, 'projects', 'none'), { recursive: true });
  await writeFile(join(config, 'CLAUDE.md'), 'Short answers.');
  await writeFile(join(config, 'settings.json'), '{}');
  await writeFile(join(memory('new'), 'MEMORY.md'), '');
  await writeFile(join(config, 'projects', 'new', 's.jsonl'), 'transcript');
  for (let note = 0; note < 7; note++)
    await writeFile(join(memory('old'), `n${note}.md`), 'note');
  await writeFile(join(memory('old'), 'x.jsonl'), 'not a note');
  // Neither a file that is not .md nor a folder that ends in .md is a note.
  await writeFile(join(memory('other'), 'x.jsonl'), 'not a note');
  await mkdir(join(memory('other'), 'sub.md'));
  for (const name of [...odd, ...older])
    await writeFile(join(memory(name), 'n.md'), 'note');
  const day = 86_400_000;
  const at = (ago: number): Date => new Date(Date.now() - ago);
  // The folder of "new" is older, but its MEMORY.md changed last.
  await utimes(memory('new'), at(2 * day), at(2 * day));
  await utimes(memory('old'), at(day), at(day));
  for (const [index, name] of odd.entries()) {
    const time = at((index + 1) * 0.3 * day);
    await utimes(memory(name), time, time);
  }
  for (const [index, name] of older.entries())
    await utimes(memory(name), at((3 + index) * day), at((3 + index) * day));
  return config;
}

await test("the import names Claude Code's memory folders that hold a note, the newest 10, or all with consent, and Claude Code may open only these 10, or with consent every memory folder, never the transcripts and settings beside them", async (t) => {
  const config = await fakeClaude(await folder(t, 'import-memory'));
  const memory = await claudeMemory(config, false, signal);
  const newest = ['new', 'old', 'p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  // The empty folders and the odd names, which would change their rules, are left out, and the newest note counts first.
  assert.deepEqual(
    memory.folders,
    newest.map((name) => memoryOf(config, name)),
  );
  // Folders with a note stay closed, so a refused read can come.
  assert.equal(memory.closed, true);
  assert.equal(memory.instructions, join(config, 'CLAUDE.md'));
  // Each of these folders is open with all that it holds. No other folder is.
  assert.deepEqual(memory.allow, [
    join(config, 'CLAUDE.md'),
    ...newest.map((name) => join(memoryOf(config, name), '**')),
  ]);
  // With consent, the import names every folder with a note, the odd names too, and still no empty one. Every memory folder is open.
  const all = await claudeMemory(config, true, signal);
  assert.deepEqual(
    all.folders,
    [
      'new',
      'odd (x)',
      'odd\\x',
      'old',
      ...Array.from({ length: 11 }, (_, index) => `p${index}`),
    ].map((name) => memoryOf(config, name)),
  );
  assert.equal(all.closed, false);
  assert.deepEqual(all.allow, [
    join(config, 'CLAUDE.md'),
    join(config, 'projects', '*', 'memory', '**'),
  ]);
  for (const closed of [
    join(config, 'projects', '**', '*.jsonl'),
    join(config, 'settings*.json'),
    join(config, 'history.jsonl'),
    join(config, 'file-history'),
    '~/.ssh',
  ])
    assert.ok(memory.deny.includes(closed), closed);
  // Without a settings folder, it may read nothing that exists.
  const none = await claudeMemory(join(config, 'missing'), false, signal);
  assert.deepEqual(none.folders, []);
  assert.equal(none.instructions, null);
  // With no folder left out, nothing is closed.
  assert.equal(none.closed, false);
  assert.deepEqual(none.allow, [join(config, 'missing', 'CLAUDE.md')]);
  // A folder path that a rule would read as syntax is refused with a reason.
  assert.equal(
    claudeFolder('relative/../claude'),
    join(process.cwd(), 'claude'),
  );
  for (const odd of [
    '/home/me/claude*',
    '/home/me (work)/.claude',
    '/home/[me]',
  ])
    assert.throws(
      () => claudeFolder(odd),
      (error: unknown) =>
        error instanceof SessionActionError &&
        /a permission rule cannot hold/.test(error.message),
    );
});

await test('the import asks each harness at once, keeps only listed skills that it named, merges two cards, and leaves "To explore" to the person', async (t) => {
  const config = await fakeClaude(await folder(t, 'import-run'));
  const requests: HarnessRequest[] = [];
  const run = (request: HarnessRequest): Promise<HarnessResult> => {
    requests.push(request);
    if (request.prompt.includes('Merge the two drafts'))
      return Promise.resolve({
        text: JSON.stringify({
          card: {
            workOn: 'CoT faithfulness; probes.',
            explore: 'Merged.',
            talk: '',
          },
        }),
      });
    return Promise.resolve({
      text: JSON.stringify(
        request.host === 'claude'
          ? {
              card: {
                workOn: 'CoT faithfulness.',
                explore: 'Probes.',
                talk: 'Short.',
              },
              skills: [
                {
                  id: 'research-paper-writing',
                  fits: true,
                  when: `For drafts. ${'x'.repeat(400)}`,
                },
                // An unknown ID, and a second answer for one skill, count for nothing.
                { id: 'not-listed', fits: true, when: 'x' },
                { id: 'research-paper-writing', fits: false },
              ],
              read: 'My instructions and the memories of two projects.',
            }
          : {
              card: { workOn: 'Probes.', explore: '', talk: '' },
              skills: [
                {
                  id: '/home/p/.agents/skills/python/SKILL.md',
                  fits: false,
                  when: 'Never.',
                },
              ],
            },
      ),
    });
  };
  const result = await importProfile({
    harnesses: [
      { host: 'claude', model: 'opus' },
      { host: 'codex', model: 'gpt-6-astra' },
    ],
    merger: { host: 'claude', model: 'opus' },
    skills,
    claudeConfig: config,
    signal,
    run,
  });
  assert.deepEqual(result.from, ['claude', 'codex']);
  assert.deepEqual(result.card, {
    workOn: 'CoT faithfulness; probes.',
    explore: '',
    talk: '',
  });
  assert.deepEqual(
    result.skills.map((skill) => [skill.harness, skill.name, skill.fits]),
    [
      // vercel:deploy is left out of the answer: no opinion.
      ['claude', 'research-paper-writing', true],
      ['codex', 'python', false],
    ],
  );
  // A note is cut to its limit, and a skill that does not fit gets none.
  assert.equal(result.skills[0]?.when.length, 300);
  assert.equal(result.skills[1]?.when, '');
  assert.deepEqual(result.read, [
    'Claude Code: My instructions and the memories of two projects.',
    'Codex: It did not say what it read.',
  ]);
  assert.deepEqual(result.problems, []);
  // The two harnesses run at once, so their requests come in either order.
  const asked = requests.filter((request) => !request.textOnly);
  const claude = asked.find((request) => request.host === 'claude');
  const codex = asked.find((request) => request.host === 'codex');
  const merge = requests.find((request) => request.textOnly);
  // Claude Code gets the newest 10 memory folders, may open only them and nothing beside them, and knows that other reads are refused. Codex's commands may read nothing at home, and it gets only its own skills.
  const newest = (await claudeMemory(config, false, signal)).folders;
  assert.equal(newest.length, 10);
  assert.deepEqual(claude?.ownFiles?.allow, [
    join(config, 'CLAUDE.md'),
    ...newest.map((path) => join(path, '**')),
  ]);
  assert.ok(
    claude?.ownFiles?.deny.includes(join(config, 'projects', '**', '*.jsonl')),
  );
  assert.ok(
    claude?.prompt.includes(
      JSON.stringify({
        instructions: join(config, 'CLAUDE.md'),
        memoryFolders: newest,
      }).slice(1, -1),
    ),
  );
  assert.match(claude?.prompt ?? '', /A refused read is expected\./);
  assert.match(claude?.prompt ?? '', /research-paper-writing/);
  assert.doesNotMatch(claude?.prompt ?? '', /python/);
  // The import does not ask what to explore.
  assert.doesNotMatch(claude?.prompt ?? '', /explore/);
  assert.deepEqual(codex?.ownFiles?.allow, []);
  assert.equal(codex?.ownFiles?.deny[0], await realpath(homedir()));
  assert.doesNotMatch(codex?.prompt ?? '', /"memoryFolders":|refused read/);
  assert.match(codex?.prompt ?? '', /I am Verifold, an automated science/);
  assert.equal(claude?.outsideText, true);
  assert.equal(claude?.model, 'opus');
  // Each call runs in its own empty folder.
  assert.notEqual(claude?.cwd, codex?.cwd);
  // The merge sees only the two cards, as text only, and they count as text from outside. Its idle limit comes before its 3-minute limit.
  assert.equal(claude?.idleMs, 180_000);
  assert.equal(merge?.idleMs, 120_000);
  assert.equal(merge?.timeoutMs, 180_000);
  assert.equal(merge?.textOnly, true);
  assert.equal(merge?.outsideText, true);
  assert.equal(merge?.ownFiles, undefined);
  assert.match(merge?.prompt ?? '', /"drafts":\[/);
  assert.doesNotMatch(merge?.prompt ?? '', /explore/);
  // With consent, Claude Code gets every memory folder that holds a note, and may open every memory folder.
  requests.length = 0;
  await importProfile({
    harnesses: [{ host: 'claude' }],
    merger: null,
    skills,
    claudeConfig: config,
    allMemories: true,
    signal,
    run,
  });
  assert.deepEqual(requests[0]?.ownFiles?.allow, [
    join(config, 'CLAUDE.md'),
    join(config, 'projects', '*', 'memory', '**'),
  ]);
  assert.ok(
    requests[0]?.prompt.includes(
      JSON.stringify({
        memoryFolders: (await claudeMemory(config, true, signal)).folders,
      }).slice(1, -1),
    ),
  );
  assert.doesNotMatch(requests[0]?.prompt ?? '', /refused read/);
  // Without consent, but with no folder left out, no read is refused, so the prompt does not say so.
  requests.length = 0;
  await importProfile({
    harnesses: [{ host: 'claude' }],
    merger: null,
    skills,
    claudeConfig: join(config, 'missing'),
    signal,
    run,
  });
  assert.doesNotMatch(requests[0]?.prompt ?? '', /refused read/);
});

await test("Codex's commands may not read the home folder, by its real path, nor Codex's folder or a credential path outside it, and no path comes twice", async (t) => {
  const base = await realpath(await folder(t, 'closed'));
  const home = join(base, 'home');
  const keys = join(base, 'keys');
  const codex = join(base, 'codex');
  await mkdir(join(home, '.ssh'), { recursive: true });
  await mkdir(join(home, '.config'));
  await mkdir(keys);
  await mkdir(codex);
  // ~/.ssh lies in the home folder, which closes it. ~/.config/gh leads out of it.
  await symlink(keys, join(home, '.config', 'gh'));
  const link = join(base, 'home-link');
  await symlink(home, link);
  // CODEX_HOME is the home folder, by another path.
  assert.deepEqual(await codexClosed(link, link), [home, keys]);
  assert.deepEqual(await codexClosed(home, codex), [home, keys, codex]);
});

await test("one harness that fails leaves the other's answer, a failed merge keeps the lead's card, and no answer at all fails", async () => {
  const answer = {
    card: { workOn: 'Lead card.', explore: '', talk: '' },
    skills: [],
  };
  const base = {
    merger: { host: 'claude' as const },
    skills,
    claudeConfig: join(tmpdir(), 'verifold-no-such-folder'),
    signal,
  };
  const one = await importProfile({
    ...base,
    harnesses: [{ host: 'claude' }, { host: 'codex' }],
    run: (request) =>
      request.host === 'codex'
        ? Promise.reject(new Error('Codex started a command or a tool.'))
        : Promise.resolve({ text: JSON.stringify(answer) }),
  });
  assert.deepEqual(one.from, ['claude']);
  assert.deepEqual(one.problems, [
    'Codex did not answer: Codex started a command or a tool.',
  ]);
  // An answer that names no skill has no opinion on any.
  assert.deepEqual(one.skills, []);
  const merged = await importProfile({
    ...base,
    harnesses: [{ host: 'claude' }, { host: 'codex' }],
    run: (request) =>
      request.textOnly
        ? Promise.resolve({ text: 'no card' })
        : Promise.resolve({
            text: JSON.stringify(
              request.host === 'codex'
                ? { ...answer, card: { ...answer.card, workOn: 'Other.' } }
                : answer,
            ),
          }),
  });
  assert.deepEqual(merged.card, answer.card);
  assert.match(
    merged.problems[0] ?? '',
    /could not merge the two drafts, so the card is Claude Code's draft/,
  );
  // An answer that is not JSON is a failure too.
  await assert.rejects(
    importProfile({
      ...base,
      harnesses: [{ host: 'claude' }],
      run: () => Promise.resolve({ text: 'I know nothing.' }),
    }),
    (error: unknown) =>
      error instanceof SessionActionError &&
      /Claude Code did not answer: Claude Code did not send an answer/.test(
        error.message,
      ),
  );
});

const claudeFound: HarnessStatus = {
  harness: 'claude',
  installed: true,
  version: '2.1.310',
  signedIn: true,
  plan: 'max',
  models: claudeChoices('opus[1m]', 'max'),
};

const codexOut: HarnessStatus = {
  harness: 'codex',
  installed: true,
  version: '0.160.0',
  signedIn: false,
  plan: null,
  models: [],
};

async function until(check: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('The condition did not hold.');
    await delay(20);
  }
}

await test('the import through the first run: one at a time, a stop that the next import waits for, and an Accept that sets the draft card and only the skills that the person never chose', async (t) => {
  const base = await folder(t, 'import-first-run');
  const agency = join(base, 'agency');
  const compute = new Compute(join(base, 'here'), {
    store: new KeyStore({
      home: join(base, 'home'),
      platform: 'linux',
      secretTool: join(base, 'none'),
    }),
  });
  await compute.load();
  // A harness that answers when the test says so, and fails when its call is stopped.
  const waiting: ((text: string) => void)[] = [];
  const requests: HarnessRequest[] = [];
  let detected: readonly HarnessStatus[] = [
    { ...claudeFound, signedIn: false },
  ];
  const setup = new FirstRun({
    directory: agency,
    compute,
    signal,
    claudeConfig: join(base, 'claude'),
    harness: (request) => {
      requests.push(request);
      return new Promise((resolve, reject) => {
        waiting.push((text) => resolve({ text }));
        request.signal.addEventListener('abort', () =>
          setTimeout(() => reject(new Error('Stopped.')), 200),
        );
      });
    },
    detect: () => Promise.resolve(detected),
    installed: () => Promise.resolve(['claude']),
    ownSkills: () =>
      Promise.resolve({
        skills: skills.filter((skill) => skill.harness === 'claude'),
        problems: [],
      }),
  });
  const answer = JSON.stringify({
    card: { workOn: 'CoT faithfulness.', explore: 'Probes.', talk: '' },
    skills: [
      { id: 'research-paper-writing', fits: true, when: 'Drafts.' },
      { id: 'vercel:deploy', fits: false },
    ],
    read: 'My instructions.',
  });
  const idle = async (): Promise<void> =>
    until(async () => (await setup.view()).about.import?.busy === null);
  // Before any import, the view says that none runs. Claude Code is signed out, so the import would not ask it.
  assert.deepEqual((await setup.view()).about.import, {
    busy: null,
    asking: [],
    claude: false,
    error: null,
    result: null,
  });
  // With no agent signed in, the import is refused and does not count as running.
  await assert.rejects(setup.act({ action: 'setup-import' }), /signed in/);
  assert.equal((await setup.view()).about.import?.busy, null);
  detected = [claudeFound, codexOut];
  await setup.act({ action: 'setup-check' });
  await until(async () => !(await setup.view()).agents.checking);
  assert.equal((await setup.view()).about.import?.claude, true);
  // The person chose Yes for vercel:deploy before the import.
  await setup.act({ action: 'setup-own-skills-list' });
  await until(async () => !(await setup.view()).skills?.ownReading);
  await setup.act({
    action: 'setup-own-skills',
    choices: [{ harness: 'claude', id: 'vercel:deploy', use: true }],
  });
  assert.equal(await setup.act({ action: 'setup-import' }), 202);
  // A signed-out Codex is not asked, and a second import waits.
  await until(
    async () => (await setup.view()).about.import?.asking.join() === 'claude',
  );
  await assert.rejects(setup.act({ action: 'setup-import' }), /Wait a moment/);
  await until(() => Promise.resolve(waiting.length === 1));
  assert.equal(requests[0]?.host, 'claude');
  assert.equal(requests[0]?.model, 'opus[1m]');
  // Stop: the call is stopped, the view shows no import at once, and nothing comes of it.
  assert.equal(await setup.act({ action: 'setup-import-discard' }), 200);
  assert.equal(requests[0]?.signal.aborted, true);
  assert.equal((await setup.view()).about.import?.busy, null);
  // A new import waits until the stopped one ended, then asks again, this time with consent to every memory folder.
  waiting.length = 0;
  assert.equal(
    await setup.act({ action: 'setup-import', allMemories: true }),
    202,
  );
  await until(() => Promise.resolve(waiting.length === 1));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]?.ownFiles?.allow, [
    join(base, 'claude', 'CLAUDE.md'),
  ]);
  assert.deepEqual(requests[1]?.ownFiles?.allow, [
    join(base, 'claude', 'CLAUDE.md'),
    join(base, 'claude', 'projects', '*', 'memory', '**'),
  ]);
  waiting.shift()?.(answer);
  await idle();
  const shown = (await setup.view()).about;
  assert.equal(shown.import?.error, null);
  assert.deepEqual(shown.import?.result?.from, ['claude']);
  // The skill that the person chose says so.
  assert.deepEqual(
    shown.import?.result?.skills.map((skill) => [skill.name, skill.chosen]),
    [
      ['research-paper-writing', undefined],
      ['vercel:deploy', true],
    ],
  );
  // Nothing is saved, and the card is not a draft yet.
  assert.equal(shown.card, null);
  // Discard drops it.
  assert.equal(await setup.act({ action: 'setup-import-discard' }), 200);
  assert.equal((await setup.view()).about.import?.result, null);
  await assert.rejects(
    setup.act({ action: 'setup-import-accept' }),
    /Nothing waits to be accepted/,
  );
  // Again, and Accept: the card becomes the draft, and only the skill that the person never chose is set. The answer's "explore" counts for nothing.
  await setup.act({ action: 'setup-import' });
  await until(() => Promise.resolve(waiting.length === 1));
  waiting.shift()?.(answer);
  await idle();
  assert.equal(await setup.act({ action: 'setup-import-accept' }), 200);
  const accepted = (await setup.view()).about;
  assert.deepEqual(accepted.card, {
    workOn: 'CoT faithfulness.',
    explore: '',
    talk: '',
  });
  assert.equal(accepted.import?.result, null);
  // The card is still a draft until "Looks right".
  assert.equal(accepted.saved, null);
  const choices = (await loadOwnChoices(agency)).claude;
  assert.deepEqual(
    [...choices].map(([id, choice]) => [id, choice.use, choice.when]),
    [
      ['vercel:deploy', true, ''],
      ['research-paper-writing', true, 'Drafts.'],
    ],
  );
});

await test('Accept keeps the person\'s "To explore" text: from the saved card, from the draft, and from the saved card again after a new start', async (t) => {
  const base = await folder(t, 'import-explore');
  const compute = new Compute(join(base, 'here'), {
    store: new KeyStore({
      home: join(base, 'home'),
      platform: 'linux',
      secretTool: join(base, 'none'),
    }),
  });
  await compute.load();
  const setup = new FirstRun({
    directory: join(base, 'agency'),
    compute,
    signal,
    claudeConfig: join(base, 'claude'),
    // The import's answer, else the conversation's card, which keeps the note's edit.
    harness: (request) =>
      Promise.resolve({
        text: JSON.stringify({
          card: request.prompt.includes('I am Verifold, an automated science')
            ? {
                workOn: 'Imported.',
                explore: 'From the import.',
                talk: 'Short.',
              }
            : { workOn: 'Imported.', explore: 'Draft.', talk: 'Short.' },
          skills: [],
        }),
      }),
    detect: () => Promise.resolve([claudeFound]),
    installed: () => Promise.resolve(['claude']),
  });
  const accept = async (): Promise<SetupView['about']['card']> => {
    assert.equal(await setup.act({ action: 'setup-import' }), 202);
    await until(async () => (await setup.view()).about.import?.result != null);
    assert.equal(await setup.act({ action: 'setup-import-accept' }), 200);
    return (await setup.view()).about.card;
  };
  await setup.act({
    action: 'setup-about',
    card: { workOn: 'Old.', explore: 'Saved.', talk: 'Old.' },
  });
  assert.deepEqual(await accept(), {
    workOn: 'Imported.',
    explore: 'Saved.',
    talk: 'Short.',
  });
  // A note on the draft changes its "To explore".
  assert.equal(
    await setup.act({
      action: 'setup-say',
      text: 'Change it.',
      card: { workOn: 'Imported.', explore: 'Draft.', talk: 'Short.' },
    }),
    202,
  );
  await until(async () => (await setup.view()).about.busy === null);
  assert.equal((await setup.view()).about.card?.explore, 'Draft.');
  assert.equal((await accept())?.explore, 'Draft.');
  // A new conversation has no draft yet, so the saved text stays: "Looks right" would otherwise erase it.
  await setup.act({ action: 'setup-restart' });
  assert.equal((await accept())?.explore, 'Saved.');
});

await test("in an isolated project, the import runs in the project's own settings, and Accept saves only there", async (t) => {
  const base = await folder(t, 'import-scope');
  const global = join(base, 'agency');
  await writeSettings(global, () => ({
    agency: { host: 'claude' },
    money: null,
    unreadMoney: null,
    steps: { agents: 'done' },
  }));
  const here = join(base, 'here');
  await mkdir(here);
  await copyGlobalProfile(global, here, signal);
  const compute = new Compute(join(base, 'compute'), {
    store: new KeyStore({
      home: join(base, 'home'),
      platform: 'linux',
      secretTool: join(base, 'none'),
    }),
  });
  await compute.load();
  const runs = new FirstRuns({
    directory: global,
    root: here,
    own: 'project',
    compute,
    signal,
    claudeConfig: join(base, 'claude'),
    harness: () =>
      Promise.resolve({
        text: JSON.stringify({
          card: { workOn: 'Probes.', explore: '', talk: '' },
          skills: [
            { id: 'research-paper-writing', fits: true, when: 'Drafts.' },
          ],
        }),
      }),
    detect: () => Promise.resolve([claudeFound]),
    installed: () => Promise.resolve(['claude']),
    ownSkills: () =>
      Promise.resolve({
        skills: skills.filter((skill) => skill.harness === 'claude'),
        problems: [],
      }),
  });
  const project = { profile: 'project' } as const;
  assert.equal(await runs.act({ action: 'setup-import', ...project }), 202);
  await until(
    async () => (await runs.view('project')).about.import?.result != null,
  );
  // The global settings have no import of their own.
  assert.equal((await runs.view()).about.import?.result, null);
  assert.equal(
    await runs.act({ action: 'setup-import-accept', ...project }),
    200,
  );
  assert.deepEqual((await runs.view('project')).about.card?.workOn, 'Probes.');
  assert.equal(
    (await loadOwnChoices(ownProfileFolder(here))).claude.get(
      'research-paper-writing',
    )?.when,
    'Drafts.',
  );
  assert.equal((await loadOwnChoices(global)).claude.size, 0);
  assert.equal((await runs.view()).about.card, null);
});
