import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  Agent,
  Direction,
  Lab,
  Run,
  Thread,
  Wait,
} from '../src/protocol/api.ts';
import { foldsTeams, teamRows, troubles } from '../src/app/team-view.ts';

const now = Date.UTC(2026, 10, 1, 17, 8);
const ago = (minutes: number): string =>
  new Date(now - minutes * 60_000).toISOString();

const agent = (number: number, more: Partial<Agent> = {}): Agent => ({
  id: `a-${number}`,
  handle: `agent-${number}`,
  job: `Job ${number}`,
  harness: 'codex',
  model: null,
  direction: `d-${number}`,
  check: null,
  status: 'working',
  until: null,
  live: { state: 'working', text: 'Working', since: ago(1) },
  line: {
    doing: `Agent ${number} works`,
    why: 'It has a reason',
    next: 'More',
    at: ago(5),
  },
  helpers: [],
  lastPostAt: ago(5),
  turns: { turns: [], more: false },
  spendUsd: null,
  ...more,
});

const direction = (number: number, team: string | null): Direction => ({
  id: `d-${number}`,
  title: `Direction ${number}`,
  job: `Job ${number}`,
  team,
  bar: null,
  runs: null,
  noise: null,
  buildsOn: [],
  state: 'open',
  verdict: 'open',
  disputed: false,
  evidence: null,
  agent: `a-${number}`,
  openedBy: 'a-1',
  openedAt: ago(200),
  stoppedAt: null,
  head: 'abc',
});

const lab = (more: Partial<Lab>): Lab =>
  ({
    needsYou: [],
    agents: [],
    directions: [],
    waits: [],
    runs: [],
    paused: null,
    ...more,
  }) as unknown as Lab;

const run = (agentId: string, more: Partial<Run>): Run =>
  ({
    id: 'r-132',
    agent: agentId,
    direction: 'd-1',
    status: 'done',
    where: 'local',
    queuedAt: ago(100),
    startedAt: ago(90),
    endedAt: ago(40),
    ...more,
  }) as Run;

const wait = (more: Partial<Wait>): Wait => ({
  waiter: 'a-1',
  waiterHandle: 'agent-1',
  on: 'a-2',
  onHandle: 'agent-2',
  post: 'p-9',
  reason: 'ask',
  thread: 't-2',
  subject: 'Which seed leaks?',
  text: 'Which seed leaks?',
  since: ago(38),
  ...more,
});

/** Twenty agents in six teams of 3 to 5. */
function twenty(
  more: Partial<Lab> = {},
  agents = new Map<number, Partial<Agent>>(),
): Lab {
  const teams = [
    'A',
    'A',
    'A',
    'B',
    'B',
    'B',
    'C',
    'C',
    'C',
    'D',
    'D',
    'D',
    'E',
    'E',
    'E',
    'F',
    'F',
    'F',
    'F',
    'F',
  ];
  return lab({
    agents: teams.map((_, index) => agent(index + 1, agents.get(index + 1))),
    directions: teams.map((team, index) => direction(index + 1, team)),
    ...more,
  });
}

await test('the home keeps its rows up to 6 agents, and a checker does not count', () => {
  const six = [1, 2, 3, 4, 5, 6].map((number) => agent(number));
  assert.equal(foldsTeams(lab({ agents: six })), false);
  assert.equal(
    foldsTeams(lab({ agents: [...six, agent(7, { direction: null })] })),
    false,
  );
  assert.equal(foldsTeams(lab({ agents: [...six, agent(7)] })), true);
});

await test('with no trouble, 20 agents fold into 6 teams with their members', () => {
  const shown = twenty();
  assert.deepEqual(troubles(shown, 'simple', now), []);
  const teams = teamRows(shown, 'simple', now);
  assert.equal(teams.length, 6);
  assert.equal(
    teams.reduce((sum, team) => sum + team.rows.length, 0),
    20,
  );
  const last = teams.find((team) => team.name === 'F');
  assert.equal(last?.members, 'Agents 16, 17, 18, 19 and 20');
  assert.equal(last?.chip.label, 'Working');
  assert.match(last?.line ?? '', /^Agent \d+: Agent \d+ works/);
});

await test('a wait past 30 minutes is trouble, with its age. A shorter one is not.', () => {
  const late = troubles(
    twenty({ waits: [wait({ since: ago(38) })] }),
    'simple',
    now,
  );
  assert.equal(late.length, 1);
  assert.equal(late[0]?.agent.id, 'a-1');
  assert.equal(late[0]?.chip.label, '38 min');
  assert.match(late[0]?.line ?? '', /waits on Agent 2: Which seed leaks\?/);
  assert.deepEqual(
    troubles(twenty({ waits: [wait({ since: ago(10) })] }), 'simple', now),
    [],
  );
});

await test('Technical names the post of a wait, and Simple shows the plain title', () => {
  const shown = twenty({
    waits: [wait({})],
    threads: [
      { id: 't-2', plainTitle: 'Which run went wrong?' } as unknown as Thread,
    ],
  });
  const simple = troubles(shown, 'simple', now)[0]?.line ?? '';
  assert.doesNotMatch(simple, /p-9/);
  assert.match(simple, /Which run went wrong\?/);
  const technical = troubles(shown, 'technical', now)[0]?.line ?? '';
  assert.match(technical, /p-9/);
  assert.match(technical, /Which seed leaks\?/);
});

await test('a call that waits past the threshold counts as a wait on the person', () => {
  const shown = twenty({
    needsYou: [
      {
        id: 'c-4',
        at: ago(45),
        askers: [{ agent: 'a-2' }],
      },
    ] as unknown as Lab['needsYou'],
  });
  const [first] = troubles(shown, 'simple', now);
  assert.equal(first?.agent.id, 'a-2');
  assert.match(first?.line ?? '', /your decision/);
});

await test('a disputed direction is trouble, and it names who objects', () => {
  const shown = twenty({
    directions: [
      { ...direction(8, 'C'), disputed: true },
      ...twenty().directions.filter(({ id }) => id !== 'd-8'),
    ],
    waits: [
      wait({
        waiter: 'a-14',
        waiterHandle: 'agent-14',
        on: 'a-8',
        onHandle: 'agent-8',
        reason: 'objection',
        since: ago(5),
      }),
    ],
  });
  const [first] = troubles(shown, 'simple', now);
  assert.equal(first?.kind, 'disputed');
  assert.match(first?.line ?? '', /objection from Agent 14/);
  assert.equal(first?.chip.label, 'Disputed');
  const team = teamRows(shown, 'simple', now)[0];
  assert.equal(team?.name, 'C');
  assert.equal(team?.chip.label, '1 disputed');
});

await test('a lost helper is trouble', () => {
  const [first] = troubles(
    twenty(
      {},
      new Map([
        [
          5,
          {
            helpers: [
              { label: 'agent-5.1', title: 'Search', state: 'lost' as const },
            ],
          },
        ],
      ]),
    ),
    'technical',
    now,
  );
  assert.equal(first?.kind, 'helper');
  assert.match(first?.line ?? '', /agent-5\.1 stopped with no result: Search/);
});

const endedRun = { active: false, ended: { run: 'r-132', at: ago(40) } };

await test('silence after a run ended is trouble, with its age', () => {
  const silent = twenty(
    {},
    new Map([[17, { line: null, lastPostAt: ago(120), runState: endedRun }]]),
  );
  const [first] = troubles(silent, 'simple', now);
  assert.equal(first?.kind, 'silent');
  assert.equal(first?.chip.label, '40 min');
  assert.match(troubles(silent, 'technical', now)[0]?.line ?? '', /r-132/);
  assert.equal(
    teamRows(silent, 'simple', now).find((team) => team.name === 'F')?.chip
      .label,
    '1 silent',
  );
});

await test('a long run with no post is not silence, at 20 agents, when the run left the snapshot', () => {
  // The snapshot keeps the newest runs, and 19 agents have filled it.
  const runs = Array.from({ length: 30 }, (_, index) =>
    run('a-1', { id: `r-${index + 100}` }),
  );
  assert.deepEqual(
    troubles(
      twenty(
        { runs },
        new Map([
          [
            3,
            {
              line: null,
              lastPostAt: ago(120),
              runState: { ...endedRun, active: true },
            },
          ],
        ]),
      ),
      'simple',
      now,
    ),
    [],
  );
});

await test('a word after the run ended, a short silence, or a paused lab is no silence', () => {
  const quiet = { line: null, lastPostAt: ago(120), runState: endedRun };
  assert.deepEqual(
    troubles(
      twenty({}, new Map([[17, { ...quiet, lastPostAt: ago(10) }]])),
      'simple',
      now,
    ),
    [],
  );
  assert.deepEqual(
    troubles(
      twenty(
        {},
        new Map([
          [
            17,
            {
              ...quiet,
              runState: {
                active: false,
                ended: { run: 'r-132', at: ago(10) },
              },
            },
          ],
        ]),
      ),
      'simple',
      now,
    ),
    [],
  );
  assert.deepEqual(
    troubles(
      twenty(
        { paused: { at: ago(50), reason: 'person' } },
        new Map([[17, quiet]]),
      ),
      'simple',
      now,
    ),
    [],
  );
  // A server from before this fact says nothing of runs, so nothing shows.
  assert.deepEqual(
    troubles(
      twenty({}, new Map([[17, { line: null, lastPostAt: ago(120) }]])),
      'simple',
      now,
    ),
    [],
  );
});

await test('an agent that stopped by itself needs a look, and one that closed does not', () => {
  const list = troubles(
    twenty(
      { waits: [wait({ waiter: 'a-5', waiterHandle: 'agent-5' })] },
      new Map<number, Partial<Agent>>([
        [4, { status: 'crashed' }],
        [5, { status: 'closed' }],
      ]),
    ),
    'simple',
    now,
  );
  assert.deepEqual(
    list.map(({ agent: { id }, kind }) => [id, kind]),
    [['a-4', 'crashed']],
  );
});

await test('each agent shows once, with its wait first', () => {
  const list = troubles(
    twenty(
      {
        waits: [wait({ waiter: 'a-5', waiterHandle: 'agent-5' })],
      },
      new Map([
        [
          5,
          {
            helpers: [
              { label: 'agent-5.1', title: 'Search', state: 'lost' as const },
            ],
          },
        ],
      ]),
    ),
    'simple',
    now,
  );
  assert.deepEqual(
    list.map(({ kind }) => kind),
    ['wait'],
  );
});

await test('a team that waits on the person leads, and a team that ended comes last', () => {
  const shown = twenty(
    {
      needsYou: [
        { id: 'c-4', at: ago(5), askers: [{ agent: 'a-10' }] },
      ] as unknown as Lab['needsYou'],
    },
    new Map<number, Partial<Agent>>(
      [1, 2, 3].map((number) => [
        number,
        {
          status: 'closed',
          live: { state: 'ended', text: 'Closed', since: ago(5) },
        },
      ]),
    ),
  );
  const teams = teamRows(shown, 'simple', now);
  assert.equal(teams[0]?.name, 'D');
  assert.equal(teams[0]?.chip.label, 'Waits on you');
  assert.equal(teams.at(-1)?.name, 'A');
  assert.equal(teams.at(-1)?.chip.label, 'Closed');
});

await test('a team says who has helpers, and checkers fold together', () => {
  const shown = twenty(
    {},
    new Map([
      [
        19,
        {
          helpers: [
            { label: 'agent-19.1', title: 'Search', state: 'running' as const },
            { label: 'agent-19.2', title: 'Search', state: 'running' as const },
          ],
        },
      ],
    ]),
  );
  const teams = teamRows(
    {
      ...shown,
      agents: [
        ...shown.agents,
        agent(21, { handle: 'checker-1', direction: null, status: 'running' }),
      ],
    },
    'simple',
    now,
  );
  assert.equal(
    teams.find((team) => team.name === 'F')?.helpers,
    'Agent 19: 2 helpers.',
  );
  assert.equal(teams.find((team) => team.name === 'Checkers')?.rows.length, 1);
});

await test('a direction with no team folds into No team', () => {
  const shown = lab({
    agents: [1, 2, 3, 4, 5, 6, 7].map((number) => agent(number)),
    directions: [1, 2, 3, 4, 5, 6, 7].map((number) => direction(number, null)),
  });
  assert.deepEqual(
    teamRows(shown, 'simple', now).map(({ name }) => name),
    ['No team'],
  );
});
