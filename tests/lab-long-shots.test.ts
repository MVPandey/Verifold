import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Lab, startLabOn } from '../src/core/lab.ts';
import { longShotLimits } from '../src/core/lab-tools.ts';
import {
  parseState,
  type LabSessions,
  type LabView,
} from '../src/core/lab/schema.ts';
import type { AgentTools } from '../src/core/session-hosts.ts';
import {
  readSessionRecord,
  type SessionRecord,
  type SessionView,
} from '../src/core/session.ts';
import { changeWorkspace } from '../src/core/storage.ts';
import {
  claudeUpdates,
  type TranscriptUpdate,
} from '../src/core/transcript.ts';
import { gitEnvironment } from '../src/core/workspaces.ts';
import type { Lab as WireLab } from '../src/protocol/api.ts';
import { ApiReader } from '../src/server/api.ts';
import { until } from './wait.ts';

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args],
    {
      cwd,
      stdio: 'ignore',
      // Inside a Git hook, GIT_* variables point at the Verifold repository. They must not reach a fixture.
      env: gitEnvironment(),
    },
  );
}

interface Started {
  readonly id: string;
  readonly host: string;
  readonly agent: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly tools: AgentTools;
  readonly denyRead: readonly string[];
}

/** Fake worker slots: a start records its input, and no harness runs. Each start is one process. */
function fakeSessions(limit: number): {
  readonly sessions: LabSessions;
  readonly started: Started[];
  readonly sent: { readonly id: string; readonly text: string }[];
  readonly idle: Set<string>;
  readonly live: Set<string>;
} {
  const started: Started[] = [];
  const sent: { id: string; text: string }[] = [];
  const live = new Set<string>();
  const idle = new Set<string>();
  const sessions: LabSessions = {
    get full(): boolean {
      return live.size >= limit;
    },
    limit,
    view: (id) =>
      live.has(id)
        ? ({
            live: true,
            record: {
              id,
              status: idle.has(id) ? 'idle' : 'running',
              launches: [{ id: `run-${id}` }],
            },
          } as unknown as SessionView)
        : null,
    idle: (id) => idle.has(id),
    startAgent: (input) => {
      const id = `20261101T000000000Z-${String(started.length + 1).padStart(8, '0')}`;
      started.push({
        id,
        host: input.host,
        agent: input.agent,
        prompt: input.prompt,
        cwd: input.cwd,
        tools: input.tools,
        denyRead: input.denyRead ?? [],
      });
      live.add(id);
      return Promise.resolve(id);
    },
    resumeAgent: (id) => {
      live.add(id);
      return Promise.resolve();
    },
    takeAgentTerminal: () => Promise.resolve(),
    park: (id) => {
      live.delete(id);
      idle.delete(id);
      return Promise.resolve(true);
    },
    continueTask: (id, text) => {
      sent.push({ id, text });
      idle.delete(id);
    },
    steer: () => false,
    endTask: (id) => {
      live.delete(id);
      idle.delete(id);
    },
  };
  return { sessions, started, sent, idle, live };
}

async function project(t: TestContext): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'verifold-draws-')));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  const root = join(base, 'project');
  await mkdir(root);
  git(root, 'init', '--quiet');
  await writeFile(join(root, 'README.md'), '# Project\n');
  await changeWorkspace(root, () => ({
    schemaVersion: 1,
    visibility: 'private',
    profile: {
      name: 'R',
      interests: ['Graphs'],
      scholar: '',
      github: '',
      session: '',
    },
    host: 'claude',
    candidates: [],
    selectedId: null,
  }));
  git(root, 'add', '.');
  git(root, 'commit', '--quiet', '-m', 'start');
  return root;
}

type Fake = ReturnType<typeof fakeSessions>;

interface Built extends Fake {
  readonly lab: Lab;
  readonly root: string;
  readonly call: (
    index: number,
    name: string,
    input: Record<string, unknown>,
  ) => Promise<{ readonly ok: boolean; readonly text: string }>;
  readonly view: () => LabView;
}

let calls = 0;

function newLab(
  t: TestContext,
  root: string,
  more: {
    readonly limit?: number;
    readonly minuteMs?: number;
    readonly objectionMs?: number;
    readonly share?: string;
  } = {},
): Built {
  const fake = fakeSessions(more.limit ?? 8);
  // A fixed sequence, so each draw is the same.
  let seed = 0;
  const lab = new Lab(root, {
    sessions: fake.sessions,
    sandbox: (spec) => ({ file: '/bin/sh', args: ['-c', spec.command] }),
    harnesses: () => Promise.resolve(['claude', 'codex']),
    random: () => {
      seed = (seed + 0.618_033_988_75) % 1;
      return seed;
    },
    timing: {
      tickMs: 5,
      debounceMs: 5,
      continueMs: 60_000,
      objectionMs: more.objectionMs ?? 3_600_000,
      ...(more.minuteMs ? { minuteMs: more.minuteMs } : {}),
    },
  });
  t.after(() => lab.close());
  const view = (): LabView => {
    const shown = lab.view();
    assert.ok(shown);
    return shown;
  };
  return {
    ...fake,
    lab,
    root,
    view,
    call: (index, name, input) => {
      const agent = fake.started[index];
      assert.ok(agent);
      calls += 1;
      return agent.tools.call(name, input, `call-${calls}`);
    },
  };
}

const entry = (
  title: string,
  more: Record<string, unknown> = {},
): Record<string, unknown> => ({
  title,
  job: 'Tests',
  team: 'One',
  bar: 'It beats the control.',
  runs: 3,
  noise: '±0.02',
  buildsOn: [],
  harness: 'claude',
  ...more,
});

/** A lab with a plan of `count` directions, each with its agent started. */
async function planned(
  t: TestContext,
  more: Parameters<typeof newLab>[2] = {},
  count = 3,
  directions: readonly Record<string, unknown>[] = [],
): Promise<Built> {
  const built = newLab(t, await project(t), more);
  await built.lab.start(
    'Do months sit on a circle?',
    more.share ? { share: more.share } : {},
  );
  await until(() => built.started.length > 0);
  const plan = await built.call(0, 'verifold_plan', {
    reading: 'How I read it.',
    cost: 'Nothing yet.',
    directions: directions.length
      ? directions
      : Array.from({ length: count }, (_, index) => entry(`Line ${index + 1}`)),
  });
  assert.equal(plan.ok, true, plan.text);
  await until(() => built.started.length >= (directions.length || count));
  return built;
}

/** Add ideas that the lab has not tried. */
async function ideas(built: Built, count: number): Promise<void> {
  for (let index = 1; index <= count; index++) {
    const reply = await built.call(0, 'verifold_idea', {
      text: `Idea number ${index}`,
      tried: false,
    });
    assert.equal(reply.ok, true, reply.text);
  }
}

/** A ruled-out post of the first agent, with proof. */
async function ruledOut(built: Built): Promise<void> {
  const direction = built.view().directions[0]?.direction;
  assert.ok(direction);
  await writeFile(
    join(built.root, direction.workspace.path, 'failed.txt'),
    '0.1\n',
  );
  const reply = await built.call(0, 'verifold_post', {
    kind: 'ruled-out',
    title: 'Why the first line of work failed',
    why: 'Others can reuse what passed.',
    text: 'The line failed its bar.',
    artifacts: [{ type: 'file', path: 'failed.txt' }],
  });
  assert.equal(reply.ok, true, reply.text);
}

const isJudge = (started: Started): boolean =>
  started.cwd.includes('/lab/long-shots/');

const judges = (built: Built): number => built.started.filter(isJudge).length;

const judgeOf = (built: Built): Started | undefined =>
  built.started.find((entry) => isJudge(entry));

const judgment = (
  id: string,
  sense: number,
  prior: number,
): Record<string, unknown> => ({
  id,
  question: `Does ${id} beat the control on seed 2?`,
  sense,
  test: 'Run it on one seed.',
  cost: 'About 2 hours of GPU',
  prior,
  closest: 'none found',
});

const endTurn = (built: Built, started: Started, status = 'idle'): void => {
  if (status === 'idle') built.idle.add(started.id);
  built.lab.turnEnded(
    {
      id: started.id,
      agent: started.agent,
      status,
      launches: [],
    } as unknown as SessionRecord,
    'completed',
  );
};

const statusPosts = (built: Built): readonly string[] =>
  built
    .view()
    .posts.filter((post) => post.author === 'verifold')
    .map((post) => post.text);

/** The lab as the wire has it. */
async function onWire(built: Built): Promise<WireLab> {
  const view = built.view();
  const reader = new ApiReader(() => ({
    root: built.root,
    lab: { view: () => view },
    compute: undefined,
    session: () => null,
    away: () => Promise.resolve(null),
    works: [],
  }));
  return (JSON.parse((await reader.build()).json) as { lab: WireLab }).lab;
}

await test('a failed line of work starts a draw that a fresh session of the other harness judges', async (t) => {
  const built = await planned(t);
  await ideas(built, 6);
  await ruledOut(built);
  await until(() => judgeOf(built) !== undefined);
  const judge = judgeOf(built);
  assert.ok(judge);
  // The first agent runs on Claude Code, so Codex judges its failed line.
  assert.equal(judge.host, 'codex');
  assert.deepEqual(
    judge.tools.specs.map((tool) => tool.name),
    ['verifold_judge'],
  );
  assert.match(judge.cwd, /\.verifold\/lab\/long-shots\/l-\d+$/);
  assert.equal((await stat(judge.cwd)).isDirectory(), true);
  // It gets the question and the candidates, and nothing else of the lab.
  assert.match(judge.prompt, /Do months sit on a circle\?/);
  assert.match(
    judge.prompt,
    /c-1: "Idea number \d" \+ "Idea number \d" \+ "Idea number \d"/,
  );
  assert.match(judge.prompt, /Today is /);
  assert.doesNotMatch(judge.prompt, /The line failed its bar/);
  for (const name of [
    'board',
    'workspaces',
    'sessions',
    'lab.json',
    join('lab', 'threads.json'),
  ])
    assert.ok(
      judge.denyRead.includes(join(built.root, '.verifold', name)),
      name,
    );
  assert.ok(judge.denyRead.includes(join(built.root, 'memory')));
  // Its session is no agent of the lab, and the next agent takes another ID.
  assert.ok(
    !built.view().directions.some(({ agent }) => agent.id === judge.agent),
  );
  assert.notEqual(
    (built.lab as unknown as { nextAgent(): string }).nextAgent(),
    judge.agent,
  );
});

await test('the best candidates go on the board as open long shots, each in its own thread', async (t) => {
  const built = await planned(t);
  await ideas(built, 6);
  await ruledOut(built);
  await until(() => judgeOf(built) !== undefined);
  const judge = judgeOf(built);
  assert.ok(judge);
  const reply = await judge.tools.call(
    'verifold_judge',
    {
      candidates: [
        judgment('c-1', 5, 0),
        judgment('c-2', 4, 1),
        // A candidate that makes no sense stays off the board, however rare it is.
        judgment('c-3', 2, 0),
        judgment('c-4', 3, 9),
        judgment('c-5', 4, 0),
        judgment('c-6', 3, 2),
      ],
    },
    'judge-1',
  );
  assert.equal(reply.ok, true, reply.text);
  assert.match(
    reply.text,
    new RegExp(`posted ${longShotLimits.top} long shots`),
  );
  const shots = built.view().posts.filter((post) => post.alien);
  assert.equal(shots.length, longShotLimits.top);
  assert.ok(shots.every((post) => post.kind === 'proposal'));
  assert.ok(shots.every((post) => post.author === 'verifold'));
  assert.equal(new Set(shots.map((post) => post.thread)).size, shots.length);
  const threads = shots.map((post) =>
    built.view().threads?.find((thread) => thread.id === post.thread),
  );
  assert.ok(threads.every((thread) => thread?.state === 'open'));
  assert.ok(threads.every((thread) => thread?.openedBy === 'verifold'));
  // The best candidate leads, with its test, its cost, and its search.
  assert.match(threads[0]?.title ?? '', /^Does c-1 beat/);
  assert.match(
    threads[0]?.why ?? '',
    /drew these ideas at random: Idea number/,
  );
  assert.match(
    shots[0]?.text ?? '',
    /^Long shot, judged by Codex: Idea number .*Test: Run it on one seed\. Cost: About 2 hours of GPU\. Closest paper: none found\./,
  );
  assert.ok(!threads.some((thread) => thread?.title.startsWith('Does c-3')));
  // A second judgment changes nothing.
  assert.match(
    (await judge.tools.call('verifold_judge', { candidates: [] }, 'judge-2'))
      .text,
    /gave your judgment/,
  );
  assert.equal(built.view().posts.filter((post) => post.alien).length, 3);
  // The session ends after its turn. Every agent reads the long shots as open, and no agent wakes.
  endTurn(built, judge);
  await until(() => !built.live.has(judge.id));
  const wire = await onWire(built);
  const shown = wire.board.posts.filter((post) => post.alien);
  assert.equal(shown.length, 3);
  assert.equal(shown[0]?.kind, 'proposal');
  assert.ok(
    !built
      .view()
      .directions.some(({ agent }) =>
        agent.events.some((event) => shots.some(({ id }) => id === event.post)),
      ),
  );
});

await test('a long shot stays open: no window turns it into a decision', async (t) => {
  const built = await planned(t, { objectionMs: 1 });
  await ideas(built, 4);
  await built.lab.drawAgain();
  await until(() => judgeOf(built) !== undefined);
  const judge = judgeOf(built);
  assert.ok(judge);
  await judge.tools.call(
    'verifold_judge',
    { candidates: [judgment('c-1', 5, 0)] },
    'judge-1',
  );
  const shot = built.view().posts.find((post) => post.alien);
  assert.ok(shot);
  // Ticks run the decisions. Another proposal shows that they ran.
  const reply = await built.call(0, 'verifold_post', {
    kind: 'proposal',
    title: 'Which control should the lab use first?',
    why: 'It sets the bar.',
    text: 'Use the old mix.',
  });
  assert.equal(reply.ok, true, reply.text);
  await until(
    () =>
      built.view().threads?.some((thread) => thread.state === 'decided') ===
      true,
  );
  assert.equal(
    built.view().threads?.find((thread) => thread.id === shot.thread)?.state,
    'open',
  );
});

await test('a judgment that is not valid is refused, and says what to change', async (t) => {
  const built = await planned(t);
  await ideas(built, 4);
  await built.lab.drawAgain();
  await until(() => judgeOf(built) !== undefined);
  const judge = judgeOf(built);
  assert.ok(judge);
  const judged = (
    candidates: unknown,
  ): Promise<{ ok: boolean; text: string }> =>
    judge.tools.call('verifold_judge', { candidates }, `bad-${Math.random()}`);
  assert.match((await judged([])).text, /Give your judgment/);
  assert.match(
    (await judged([judgment('c-9', 5, 0)])).text,
    /Name one of these/,
  );
  assert.match(
    (await judged([{ ...judgment('c-1', 5, 0), sense: 9 }])).text,
    /Give the score of c-1, from 1 to 5/,
  );
  assert.match(
    (await judged([{ ...judgment('c-1', 5, 0), test: '' }])).text,
    /Write the test of c-1/,
  );
  assert.match(
    (await judged([judgment('c-1', 5, 0), judgment('c-1', 4, 0)])).text,
    /each candidate once/,
  );
  assert.match(
    (await judge.tools.call('verifold_post', {}, 'x')).text,
    /Unknown tool/,
  );
  assert.equal(built.view().posts.filter((post) => post.alien).length, 0);
});

await test('no candidate that makes sense means one note and no proposal', async (t) => {
  const built = await planned(t);
  await ideas(built, 4);
  await built.lab.drawAgain();
  await until(() => judgeOf(built) !== undefined);
  const judge = judgeOf(built);
  assert.ok(judge);
  await judge.tools.call(
    'verifold_judge',
    { candidates: [judgment('c-1', 1, 0)] },
    'judge-1',
  );
  assert.ok(
    statusPosts(built).some((text) => /no candidate made sense/.test(text)),
  );
  assert.equal(built.view().posts.filter((post) => post.alien).length, 0);
});

await test('too few ideas mean no draw and one note, however often a line fails', async (t) => {
  const built = await planned(t);
  await ideas(built, 2);
  await built.lab.drawAgain();
  await built.lab.drawAgain();
  const notes = statusPosts(built).filter((text) =>
    /drew no long shots/.test(text),
  );
  assert.equal(notes.length, 1);
  assert.equal(judgeOf(built), undefined);
});

await test('a session gets its turns, then its draw ends with a note and blocks no one', async (t) => {
  const built = await planned(t);
  await ideas(built, 8);
  await built.lab.drawAgain();
  await until(() => judgeOf(built) !== undefined);
  const judge = judgeOf(built);
  assert.ok(judge);
  endTurn(built, judge);
  await until(() => built.sent.some(({ id }) => id === judge.id));
  assert.match(built.sent.at(-1)?.text ?? '', /Call verifold_judge now/);
  endTurn(built, judge);
  await until(() => !built.live.has(judge.id));
  await until(() =>
    statusPosts(built).some((text) => /gave no judgment/.test(text)),
  );
  // A later draw can run.
  await built.lab.drawAgain();
  await until(() => judges(built) === 2);
});

await test('a session that stops by itself ends its draw, and a late call changes nothing', async (t) => {
  const built = await planned(t);
  await ideas(built, 4);
  await built.lab.drawAgain();
  await until(() => judgeOf(built) !== undefined);
  const judge = judgeOf(built);
  assert.ok(judge);
  built.live.delete(judge.id);
  endTurn(built, judge, 'failed');
  await until(() =>
    statusPosts(built).some((text) => /stopped with no judgment/.test(text)),
  );
  const late = await judge.tools.call(
    'verifold_judge',
    { candidates: [judgment('c-1', 5, 0)] },
    'late',
  );
  assert.equal(late.ok, false);
  assert.equal(built.view().posts.filter((post) => post.alien).length, 0);
});

await test('a session has a time limit', async (t) => {
  const built = await planned(t, { minuteMs: 1 });
  await ideas(built, 4);
  await built.lab.drawAgain();
  await until(() => judgeOf(built) !== undefined);
  const judge = judgeOf(built);
  assert.ok(judge);
  await until(() => !built.live.has(judge.id));
  await until(() =>
    statusPosts(built).some((text) => /ran out of time/.test(text)),
  );
});

await test('the hourly limit and a draw that runs refuse the person, and a failed line stays quiet', async (t) => {
  const built = await planned(t);
  await ideas(built, 12);
  await built.lab.drawAgain();
  await assert.rejects(built.lab.drawAgain(), /A draw runs now/);
  for (let draw = 1; draw <= longShotLimits.perHour; draw++) {
    await until(() => judges(built) === draw);
    const judge = built.started.at(-1);
    assert.ok(judge);
    await judge.tools.call(
      'verifold_judge',
      { candidates: [judgment('c-1', 1, 0)] },
      `judge-${draw}`,
    );
    endTurn(built, judge);
    await until(() => !built.live.has(judge.id));
    if (draw < longShotLimits.perHour) await built.lab.drawAgain();
  }
  await assert.rejects(
    built.lab.drawAgain(),
    new RegExp(`drew ${longShotLimits.perHour} times in the last hour`),
  );
  const before = built.started.length;
  await ruledOut(built);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(built.started.length, before);
});

await test('later draws skip the combinations of earlier draws', async (t) => {
  const built = await planned(t);
  await ideas(built, 6);
  await built.lab.drawAgain();
  await until(() => judgeOf(built) !== undefined);
  const first = judgeOf(built);
  assert.ok(first);
  endTurn(built, first);
  await until(() => built.sent.some(({ id }) => id === first.id));
  endTurn(built, first);
  await until(() => !built.live.has(first.id));
  await built.lab.drawAgain();
  await until(() => judges(built) === 2);
  const combinations = (prompt: string): readonly string[] =>
    [...prompt.matchAll(/c-\d: (.+)/g)].map(
      (match) => match[1]?.split(' + ').sort().join('+') ?? '',
    );
  const second = built.started.at(-1);
  assert.ok(second);
  const old = new Set(combinations(first.prompt));
  assert.ok(old.size);
  assert.ok(combinations(second.prompt).every((key) => !old.has(key)));
});

await test('agents and checks take slots first: a long shot starts only when no one needs one', async (t) => {
  const built = await planned(t, { limit: 3 });
  await ideas(built, 4);
  // Every slot runs a turn, so no agent can give its slot.
  await built.lab.drawAgain();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(judgeOf(built), undefined);
  // An agent that had its turn gives its slot to the draw.
  const agent = built.started[1];
  assert.ok(agent);
  endTurn(built, agent);
  await until(() => judgeOf(built) !== undefined);
  assert.equal(built.live.has(agent.id), false);
});

await test('a pause ends the session, and a draw can start after the resume', async (t) => {
  const built = await planned(t);
  await ideas(built, 8);
  await built.lab.drawAgain();
  await until(() => judgeOf(built) !== undefined);
  const judge = judgeOf(built);
  assert.ok(judge);
  await built.lab.pause();
  assert.equal(built.live.has(judge.id), false);
  assert.ok(!statusPosts(built).some((text) => /long-shot/.test(text)));
  await built.lab.resume();
  await built.lab.drawAgain();
  await until(() => judges(built) === 2);
});

await test('Close to known work starts no draw by itself, and the person can still draw', async (t) => {
  const built = await planned(t, { share: 'close' });
  assert.equal(built.view().state.share, 'close');
  await ideas(built, 4);
  await ruledOut(built);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(judgeOf(built), undefined);
  await built.lab.drawAgain();
  await until(() => judgeOf(built) !== undefined);
});

await test('the share reaches the planner as a number of directions, and the plan marks long shots', async (t) => {
  const built = newLab(t, await project(t), { limit: 20 });
  await built.lab.start('Do months sit on a circle?', { share: 'far' });
  await until(() => built.started.length > 0);
  assert.equal(built.view().state.share, 'far');
  assert.match(built.started[0]?.prompt ?? '', /about 10 of 20 directions/);
  const plan = await built.call(0, 'verifold_plan', {
    reading: 'How I read it.',
    cost: 'Nothing yet.',
    directions: [
      entry('Main line'),
      entry('Far line', { longShot: true }),
      entry('Control'),
    ],
  });
  assert.equal(plan.ok, true, plan.text);
  await until(() => built.started.length >= 3);
  const rows = built.view().directions;
  assert.deepEqual(
    rows.map(({ direction }) => [direction.title, direction.longShot]),
    [
      ['Main line', false],
      ['Far line', true],
      ['Control', false],
    ],
  );
  // Its agent hears its role, and chooses what to take up. No one else does.
  const far = built.started.find((entry) => entry.agent === rows[1]?.agent.id);
  assert.match(
    far?.prompt ?? '',
    /You work on long shots\. .*Choose what to take up/,
  );
  assert.doesNotMatch(built.started[0]?.prompt ?? '', /You work on long shots/);
  const wire = await onWire(built);
  assert.equal(wire.share, 'far');
  assert.equal(
    wire.directions.find((row) => row.title === 'Far line')?.longShot,
    true,
  );
  // A later plan that leaves it out keeps it.
  const later = await built.call(0, 'verifold_plan', {
    reading: 'How I read it.',
    cost: 'Nothing yet.',
    changed: 'A new title.',
    directions: rows.map(({ direction }) => ({ id: direction.id })),
  });
  assert.equal(later.ok, true, later.text);
  assert.equal(built.view().directions[1]?.direction.longShot, true);
});

await test('the default share is Mixed, a share that is not valid is refused, and an agent can open a long shot', async (t) => {
  const refused = newLab(t, await project(t));
  await assert.rejects(
    refused.lab.start('Q?', { share: 'wild' }),
    /close, mixed, or far/,
  );
  assert.equal(refused.lab.view(), null);
  const built = await planned(t);
  assert.equal(built.view().state.share, 'mixed');
  assert.match(
    built.started[0]?.prompt ?? '',
    /1 direction in 4 as long shots/,
  );
  const opened = await built.call(0, 'verifold_direction', {
    action: 'open',
    title: 'A far line',
    bar: 'It beats the control.',
    harness: 'codex',
    longShot: true,
    why: 'A new route.',
  });
  assert.equal(opened.ok, true, opened.text);
  await until(() =>
    built.view().directions.some(({ direction }) => direction.longShot),
  );
});

await test('a lab from before this choice has no share, so a failed line starts no draw', () => {
  const state = parseState({
    schemaVersion: 1,
    question: 'Q?',
    startedAt: '2026-11-01T10:00:00.000Z',
    directions: [],
    roles: { agents: 0, checkers: 0 },
  });
  assert.equal(state?.share, null);
  assert.equal(
    parseState({
      schemaVersion: 1,
      question: 'Q?',
      startedAt: '2026-11-01T10:00:00.000Z',
      directions: [],
      share: 'wild',
    })?.share,
    null,
  );
});

await test('the start of a lab takes the share of the Ask page', async (t) => {
  const built = newLab(t, await project(t));
  await startLabOn(built.root, built.lab, 'Q?', 'autonomous', 8, 'close');
  assert.equal(built.view().state.share, 'close');
});

await test("a session's record keeps the folder of a long-shot session", async (t) => {
  const root = await project(t);
  const id = '20261101T000000000Z-00000001';
  const path = join(root, `${id}.json`);
  const record = {
    schemaVersion: 2,
    id,
    host: 'codex',
    model: null,
    mode: 'strict',
    reportedMode: null,
    status: 'ended',
    startedAt: '2026-11-01T10:00:00.000Z',
    cwd: '.verifold/lab/long-shots/l-5',
  };
  await writeFile(path, JSON.stringify(record));
  assert.equal(
    (await readSessionRecord(path))?.cwd,
    '.verifold/lab/long-shots/l-5',
  );
  await writeFile(
    path,
    JSON.stringify({ ...record, cwd: '.verifold/lab/agents' }),
  );
  assert.equal((await readSessionRecord(path))?.cwd, undefined);
});

await test('a proposal or a ruled-out post with no lookup shows "No search yet", and it still goes out', async (t) => {
  const built = await planned(t);
  const first = await built.call(0, 'verifold_post', {
    kind: 'proposal',
    title: 'Which control should the lab use first?',
    why: 'It sets the bar.',
    text: 'Use the old mix.',
  });
  assert.equal(first.ok, true, first.text);
  const marked = (): readonly (true | undefined)[] =>
    built
      .view()
      .posts.filter((post) => post.kind === 'proposal')
      .map((post) => post.noSearch);
  assert.deepEqual(marked(), [true]);
  // A lookup that the harness reports ends the mark. The agent's own words do not.
  const agent = built.started[0];
  assert.ok(agent);
  const record = {
    agent: agent.agent,
    launches: [{ id: 'run-1' }],
  } as unknown as SessionRecord;
  for (const update of claudeUpdates({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'I searched the literature.' },
        {
          type: 'tool_use',
          id: 'toolu-1',
          name: 'WebSearch',
          input: { query: 'old mix papers' },
        },
      ],
    },
  }))
    built.lab.harnessUpdate(record, update);
  const second = await built.call(0, 'verifold_post', {
    kind: 'proposal',
    title: 'Which seed should the lab use first?',
    why: 'It sets the order.',
    text: 'Use seed 2.',
  });
  assert.equal(second.ok, true, second.text);
  assert.deepEqual(marked(), [true, undefined]);
  // Since that post, it searched nothing.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const third = await built.call(0, 'verifold_post', {
    kind: 'proposal',
    title: 'Which folder should hold the shared data?',
    why: 'Others read it.',
    text: 'Use data/.',
  });
  assert.equal(third.ok, true, third.text);
  assert.deepEqual(marked(), [true, undefined, true]);
  // Only these kinds carry the mark.
  const wire = await onWire(built);
  assert.equal(wire.board.posts.filter((post) => post.noSearch).length, 2);
});

await test('reading shows on the wire, from harness records and the map', async (t) => {
  const built = await planned(t);
  const agent = built.started[1];
  assert.ok(agent);
  const reply = await built.call(1, 'verifold_source', {
    title: 'A paper',
    url: 'https://arxiv.org/abs/2603.01092',
    date: 'Mar 2026',
    ideas: ['Region mixtures', 'Output metric'],
  });
  assert.equal(reply.ok, true, reply.text);
  assert.equal(
    (await built.call(1, 'verifold_idea', { text: 'Flat span', tried: true }))
      .ok,
    true,
  );
  const empty = await onWire(built);
  assert.deepEqual(empty.reading, { papers: 1, lookups: 0, lastPaperAt: null });
  built.lab.harnessUpdate(
    {
      agent: agent.agent,
      launches: [{ id: 'run-1' }],
    } as unknown as SessionRecord,
    {
      id: 'x',
      kind: 'tool',
      name: 'WebFetch',
      title: 'https://arxiv.org/abs/1',
    },
  );
  const wire = await onWire(built);
  assert.equal(wire.reading?.lookups, 1);
  assert.ok(wire.reading?.lastPaperAt);
  // Every agent reads the map and the ideas.
  const sources = await built.call(2, 'verifold_board', { view: 'sources' });
  assert.match(sources.text, /s-1 "A paper"/);
  const map = await built.call(2, 'verifold_board', { view: 'ideas' });
  assert.match(map.text, /\[not tried\] "Region mixtures" from s-1/);
  assert.match(map.text, /\[tried\] "Flat span"/);
  // A restart keeps them.
  await built.lab.close();
  const fake = fakeSessions(8);
  const next = new Lab(built.root, { sessions: fake.sessions, runs: false });
  t.after(() => next.close());
  await next.load();
  assert.equal(next.view()?.reading?.papers, 1);
  assert.equal(next.view()?.reading?.lookups, 1);
  assert.ok(
    JSON.parse(
      await readFile(
        join(built.root, '.verifold', 'lab', 'literature.json'),
        'utf8',
      ),
    ),
  );
});

/** A helper of `started`, as its harness reports it. */
function helper(
  built: Built,
  started: Started,
  events: readonly unknown[],
  launch = `run-${started.id}`,
): void {
  const record = {
    id: started.id,
    agent: started.agent,
    launches: [{ id: launch }],
  } as unknown as SessionRecord;
  const updates: TranscriptUpdate[] = events.flatMap((event) =>
    claudeUpdates(event),
  );
  for (const update of updates) built.lab.harnessUpdate(record, update);
}

const background = (id: string): unknown => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: {
    content: [
      {
        type: 'tool_use',
        id,
        name: 'Agent',
        input: {
          description: 'Scan the prior work',
          prompt: 'Scan it.',
          run_in_background: true,
        },
      },
    ],
  },
});

await test('helpers show on the wire with their labels, and a lost helper tells its agent once', async (t) => {
  const built = await planned(t);
  const started = built.started[1];
  assert.ok(started);
  const row = (): LabView['directions'][number] | undefined =>
    built.view().directions.find(({ agent }) => agent.id === started.agent);
  const handle = row()?.agent.handle;
  helper(built, started, [background('toolu-1')]);
  const wire = await onWire(built);
  assert.deepEqual(
    wire.agents.find((agent) => agent.id === started.agent)?.helpers,
    [{ label: `${handle}.1`, title: 'Scan the prior work', state: 'running' }],
  );
  // A subagent's lookup counts for its agent.
  helper(built, started, [
    {
      type: 'assistant',
      parent_tool_use_id: 'toolu-1',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu-2',
            name: 'WebSearch',
            input: { query: 'prior work papers' },
          },
        ],
      },
    },
  ]);
  assert.equal(built.view().reading?.lookups, 1);
  // The process stops: the helper is lost, and its agent hears once.
  await built.sessions.park(started.id);
  await until(() => row()?.helpers?.[0]?.state === 'lost');
  await until(() =>
    (row()?.agent.events ?? []).some((event) => event.kind === 'helper'),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  const heard = (row()?.agent.events ?? []).filter(
    (event) => event.kind === 'helper',
  );
  assert.equal(heard.length, 1);
  assert.match(heard[0]?.text ?? '', /stopped with no result/);
  const shown = await onWire(built);
  assert.equal(
    shown.agents.find((agent) => agent.id === started.agent)?.helpers?.[0]
      ?.state,
    'lost',
  );
});

await test("a checker's or a judge's session has no helpers, and its lookups count for the lab", async (t) => {
  const built = await planned(t);
  built.lab.harnessUpdate(
    { agent: 'a-99', launches: [{ id: 'run-1' }] } as unknown as SessionRecord,
    { id: 'x', kind: 'tool', name: 'WebSearch', title: 'papers on it' },
  );
  assert.equal(built.view().reading?.lookups, 1);
  // A session that is no agent of the lab, such as the person's own, counts for nothing.
  built.lab.harnessUpdate({ launches: [] } as unknown as SessionRecord, {
    id: 'y',
    kind: 'tool',
    name: 'WebSearch',
    title: 'q',
  });
  assert.equal(built.view().reading?.lookups, 1);
});

await test('a park takes an agent with no running helper first', async (t) => {
  const built = await planned(t, { limit: 3 });
  const [one, two] = [built.started[1], built.started[2]];
  assert.ok(one && two);
  const yieldable = (): readonly { id: string }[] =>
    (built.lab as unknown as { yieldable(): { id: string }[] }).yieldable();
  // The agent that worked longest ago goes first, unless its helper runs.
  endTurn(built, one);
  await until(() => yieldable().length === 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  endTurn(built, two);
  await until(() => yieldable().length === 2);
  assert.equal(yieldable()[0]?.id, one.agent);
  helper(built, one, [background('toolu-1')]);
  assert.equal(yieldable()[0]?.id, two.agent);
  // It still can give its slot, so a helper never blocks the lab.
  assert.equal(yieldable().length, 2);
});
