import test from 'node:test';
import assert from 'node:assert/strict';
import type { Post } from '../src/core/board.ts';
import { wakeList } from '../src/core/lab/post-rules.ts';
import {
  directionNamedIn,
  namedIn,
  reachOf,
  type LabReach,
  type ReachAgent,
  type Words,
} from '../src/core/lab/reach.ts';

const agent = (
  number: number,
  status: ReachAgent['status'] = 'working',
  more: Partial<ReachAgent> = {},
): ReachAgent => ({
  id: `a-${number}`,
  handle: `agent-${number}`,
  direction: `d-${number}`,
  status,
  until: null,
  parked: false,
  ...more,
});

const lab = (
  agents: readonly ReachAgent[],
  more: Partial<LabReach> = {},
): LabReach => ({ agents, paused: null, slotsFull: false, ...more });

const thread = (...followers: readonly string[]) => ({
  id: 't-3',
  followers,
});

const words = (...mentions: readonly string[]): Words => ({ mentions });

const nobody = { target: undefined, thread: undefined };

await test('a thread reaches its followers, and says who will not read it', () => {
  const reach = reachOf(
    words(),
    { target: undefined, thread: thread('a-1', 'a-3') },
    lab([agent(1, 'closed'), agent(2), agent(3), agent(4, 'stopped')]),
  );
  assert.deepEqual(reach.readers, [
    { handle: 'agent-3', when: 'step', until: null },
  ]);
  assert.deepEqual(reach.missed, [{ handle: 'agent-1', why: 'closed' }]);
});

await test('Everyone reaches each agent that works, and names each one that ended', () => {
  const reach = reachOf(
    words('all'),
    { target: undefined, thread: thread('a-3') },
    lab([agent(1, 'closed'), agent(2, 'idle'), agent(3)]),
  );
  assert.deepEqual(
    reach.readers.map(({ handle, when }) => [handle, when]),
    [
      ['agent-2', 'now'],
      ['agent-3', 'step'],
    ],
  );
  assert.deepEqual(reach.missed, [{ handle: 'agent-1', why: 'closed' }]);
});

await test('a parked agent reads when its usage window resets, or when a slot is free', () => {
  const until = '2026-11-01T18:00:00.000Z';
  const reach = reachOf(
    words('all'),
    nobody,
    lab(
      [
        agent(1, 'usage', { until, parked: true }),
        agent(2, 'slot', { parked: true }),
        agent(3, 'idle', { parked: true }),
        agent(4, 'idle', { parked: false }),
        agent(5, 'turns', { parked: true }),
      ],
      { slotsFull: true },
    ),
  );
  assert.deepEqual(
    reach.readers.map(({ when, until: at }) => [when, at]),
    [
      ['usage', until],
      ['slot', null],
      ['slot', null],
      ['now', null],
      ['slot', null],
    ],
  );
  // With a free slot, a wake starts the agent's process at once.
  assert.equal(
    reachOf(words('all'), nobody, lab([agent(3, 'idle', { parked: true })]))
      .readers[0]?.when,
    'now',
  );
});

await test('in a paused lab an agent reads after the resume, and a crashed agent still does not', () => {
  const agents = [agent(1, 'paused'), agent(2, 'crashed'), agent(3, 'closed')];
  const paused = reachOf(
    words('all'),
    nobody,
    lab(agents, { paused: 'person' }),
  );
  assert.deepEqual(paused.readers, [
    { handle: 'agent-1', when: 'resume', until: null },
  ]);
  assert.deepEqual(paused.missed, [
    { handle: 'agent-2', why: 'crashed' },
    { handle: 'agent-3', why: 'closed' },
  ]);
  assert.equal(
    reachOf(words('all'), nobody, lab(agents, { paused: 'deadline' }))
      .readers[0]?.when,
    'more-time',
  );
});

await test('words to an agent that ended reach every agent that works, and the line says both', () => {
  const reach = reachOf(
    words('a-1'),
    { target: undefined, thread: thread('a-2') },
    lab([agent(1, 'closed'), agent(2), agent(3), agent(4, 'stopped')]),
  );
  assert.deepEqual(
    reach.readers.map(({ handle }) => handle),
    ['agent-2', 'agent-3'],
  );
  assert.deepEqual(reach.missed, [{ handle: 'agent-1', why: 'closed' }]);
});

await test('a lab with no agent that works reaches no one', () => {
  const reach = reachOf(
    words(),
    nobody,
    lab([agent(1, 'closed'), agent(2, 'crashed')]),
  );
  assert.deepEqual(reach.readers, []);
  assert.deepEqual(
    reach.missed.map(({ why }) => why),
    ['closed', 'crashed'],
  );
});

await test('a reply reaches the author of its target and the followers', () => {
  const reach = reachOf(
    words(),
    { target: { author: 'a-1' }, thread: thread('a-3') },
    lab([agent(1, 'closed'), agent(2), agent(3)]),
  );
  assert.deepEqual(
    reach.readers.map(({ handle }) => handle),
    ['agent-3'],
  );
  assert.deepEqual(reach.missed, [{ handle: 'agent-1', why: 'closed' }]);
});

await test('a terminal and a held agent read later, each for its own reason', () => {
  assert.deepEqual(
    reachOf(
      words('all'),
      nobody,
      lab([agent(1, 'terminal'), agent(2, 'plan'), agent(3, 'starting')]),
    ).readers.map(({ when }) => when),
    ['terminal', 'plan', 'step'],
  );
});

await test('the line and the wakes are one answer, for each level and each state', () => {
  const states: readonly ReachAgent['status'][] = [
    'working',
    'idle',
    'paused',
    'usage',
    'slot',
    'closed',
    'stopped',
    'crashed',
  ];
  const agents = states.map((status, index) => agent(index + 1, status));
  const works = agents.filter(
    ({ status }) => !['closed', 'stopped', 'crashed'].includes(status),
  );
  const levels: readonly {
    readonly words: Words;
    readonly target?: Post;
    readonly followers: readonly string[];
    readonly plan?: boolean;
  }[] = [
    { words: words(), followers: ['a-1', 'a-6'] },
    { words: words(), followers: [] },
    { words: words(), followers: ['a-6', 'a-7'] },
    { words: words('a-2'), followers: ['a-1'] },
    { words: words('a-6'), followers: ['a-1'] },
    { words: words('all'), followers: ['a-1'] },
    { words: words(), followers: [], plan: true },
    {
      words: words(),
      followers: ['a-2'],
      target: { author: 'a-3' } as Post,
    },
    { words: { mentions: [], direction: 'd-4' }, followers: [] },
  ];
  for (const level of levels) {
    const shown = {
      id: level.plan ? 't-1' : 't-3',
      followers: level.followers,
    };
    const reach = reachOf(
      level.words,
      { target: level.target, thread: shown },
      lab(agents),
    );
    const handles = new Map(agents.map(({ id, handle }) => [handle, id]));
    assert.deepEqual(
      reach.readers.map(({ handle }) => handles.get(handle)).sort(),
      [
        ...wakeList(
          {
            author: 'person',
            kind: 'question',
            ...level.words,
          } as unknown as Post,
          {
            target: level.target,
            thread: { ...shown } as never,
            agents: works,
          },
        ),
      ].sort(),
      JSON.stringify(level),
    );
  }
});

await test('the names in a text are those that the lab takes', () => {
  assert.deepEqual(
    namedIn('@agent-3 look @all and mail@agent-4 @nobody', 'agent-\\d+'),
    ['agent-3', 'all'],
  );
  const directions = [
    { id: 'd-1', state: 'closed' },
    { id: 'd-2', state: 'open' },
  ];
  assert.equal(directionNamedIn('see @d-1 and @d-2', directions), 'd-2');
  assert.equal(directionNamedIn('see @d-1', directions), undefined);
});
