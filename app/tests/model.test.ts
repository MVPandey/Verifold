import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type {
  AgentView,
  Post,
  PostView,
  RerunLine,
  ThreadSummary,
  Wait,
} from '../src/api/types.ts';

import {
  authorName,
  called,
  author,
  costLine,
  counted,
  labTotal,
  leftLine,
  memberLine,
  members,
  ownName,
  present,
  stateLine,
} from '../src/model/agents.ts';
import { clock, dayClock, duration, minutesBetween, money, tokens } from '../src/model/format.ts';
import { MAX_CHARS, MAX_LINES, linkHost, plainOnly } from '../src/model/markdown.ts';
import { orderNeeds, pauses } from '../src/model/needs.ts';
import { isRevision, revisedLine } from '../src/model/question.ts';
import {
  builtOnLabel,
  harnessRequest,
  choiceGroups,
  gaps,
  personAnswer,
  personMessage,
  clip,
  split,
  standingChip,
  titleOf,
} from '../src/model/posts.ts';
import { crossedLine, crossLines } from '../src/model/crossings.ts';
import { href, parseRoute } from '../src/model/route.ts';
import { hasNew, markSeen, readSeen } from '../src/model/seen.ts';
import {
  editLine,
  giveRole,
  outcomeLines,
  pictureBefore,
  pictureLook,
  roles,
  seatBeside,
  seatMarks,
  seatNumber,
  seatSwitches,
  takeBackRole,
  takeBacks,
} from '../src/model/identity.ts';
import { betweenLine, isSide, sideHeading, sideLines, sideReplyHint } from '../src/model/side.ts';
import {
  ON_CALL,
  needGroups,
  quietBand,
  reviewerLine,
  turnLine,
  waitGroups,
  waitsLine,
  wantedLine,
  whereLine,
} from '../src/model/status.ts';
import { wrapFocus } from '../src/model/focus.ts';
import { AT_EXIT, labelOf, seatsValue, stopLine, valueAt } from '../src/model/settings.ts';
import {
  agentCount,
  defaultsLine,
  effortsOf,
  addSeat,
  allOnCall,
  firstSeats,
  needsModel,
  newSeat,
  removeSeat,
  seatChoice,
  withSeat,
  OTHER_MODEL,
  initials,
  menuEntries,
  modeEntries,
  modelSummary,
  setupChoices,
  startRequest,
  step,
  withModel,
} from '../src/model/setup.ts';
import { clockLine, endLine, MAX_MINUTES, moreTime } from '../src/model/time.ts';
import type { ActContext } from '../src/model/turns.ts';
import {
  act,
  doneLine,
  cardStatus,
  headClaim,
  isStatusNote,
  questionThread,
  rows,
  standingIn,
  tone,
} from '../src/model/turns.ts';
import {
  DEFAULTS,
  HARNESSES,
  OFFER,
  agentView,
  ask,
  labView,
  postView,
  result,
  summary,
} from './fixtures.ts';

function memoryStore(): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
} {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
}

describe('format', () => {
  it('writes durations, token counts, and money for people', () => {
    assert.deepEqual(
      [
        duration(26),
        duration(60),
        duration(65),
        tokens(900),
        tokens(463_000),
        tokens(74_000_000),
        money(0.371),
      ],
      ['26 min', '1 h', '1 h 5 min', '900', '463k', '74M', '$0.37'],
    );
    assert.equal(minutesBetween('2026-11-06T14:00:00Z', new Date('2026-11-06T14:26:59Z')), 26);
    assert.equal(minutesBetween('2026-11-06T14:00:00Z', new Date('2026-11-06T13:00:00Z')), 0);
  });
});

describe('a time with its day', () => {
  it('gives the time of day for today, and the day too for another day', () => {
    const now = new Date(2026, 10, 6, 15, 0);
    assert.equal(dayClock(new Date(2026, 10, 6, 14, 4).toISOString(), now), '14:04');
    assert.equal(dayClock(new Date(2026, 10, 5, 14, 4).toISOString(), now), 'Nov 5 14:04');
  });
});

describe('route', () => {
  it('reads each page from the fragment, and anything else is the lab', () => {
    assert.deepEqual(
      ['#/', '#/needs', '#/thread/t-12', '#/thread/t-3/p-40', '#/thread/x', '#token=abc', ''].map(
        parseRoute,
      ),
      [
        { page: 'lab' },
        { page: 'needs' },
        { page: 'thread', id: 't-12', post: null },
        { page: 'thread', id: 't-3', post: 'p-40' },
        { page: 'lab' },
        { page: 'lab' },
        { page: 'lab' },
      ],
    );
    assert.equal(href({ page: 'thread', id: 't-3', post: null }), '#/thread/t-3');
    assert.equal(href({ page: 'thread', id: 't-3', post: 'p-40' }), '#/thread/t-3/p-40');
    const file = { page: 'file', post: 'p-7', path: 'out/final answer.md' } as const;
    assert.equal(href(file), '#/file/p-7/out%2Ffinal%20answer.md');
    assert.deepEqual(parseRoute(href(file)), file);
  });
});

describe('posts', () => {
  it('splits the first line into the headline and keeps the rest as the body', () => {
    assert.deepEqual(split('  Try sorted input.\n\nAlso reversed.  '), {
      headline: 'Try sorted input.',
      body: 'Also reversed.',
    });
    // A first line of 400 characters is a headline, as it is for an agent. The server takes 1,000.
    assert.deepEqual(split('x'.repeat(400)), { headline: 'x'.repeat(400), body: '' });
    const long = split('x'.repeat(1200));
    assert.equal(long.headline.length, 1000);
    assert.equal(long.body, 'x'.repeat(1200));
  });

  it('clips a long headline where the page lists posts', () => {
    assert.equal(clip('Short.'), 'Short.');
    assert.equal(clip('x'.repeat(300)), `${'x'.repeat(199)}…`);
  });

  it('opens a new thread for a message to all agents, and posts in a thread for a reply', () => {
    assert.deepEqual(personMessage('Check sorted input.'), {
      kind: 'message',
      text: 'Check sorted input.',
      new_thread: 'Check sorted input.',
    });
    assert.deepEqual(personMessage('Why 28.6x?\nSee bench_c.', 't-3'), {
      kind: 'message',
      text: 'Why 28.6x?',
      body: 'See bench_c.',
      thread: 't-3',
    });
    assert.equal(personMessage('   '), null);
    assert.equal(titleOf(`${'word '.repeat(30)}`.trim()).length <= 80, true);
  });

  it('sends a chosen option as the answer and the words as its detail', () => {
    const asked = ask('p-4', 'agent-2', ['Allow once', 'Reject']);
    assert.deepEqual(personAnswer(asked, 'Allow once', ' Only this time. '), {
      kind: 'answer',
      thread: 't-2',
      reply_to: 'p-4',
      text: 'Allow once',
      body: 'Only this time.',
      choice: 'Allow once',
    });
    assert.deepEqual(personAnswer(asked, null, 'No, use pure Python.'), {
      kind: 'answer',
      thread: 't-2',
      reply_to: 'p-4',
      text: 'No, use pure Python.',
    });
    assert.equal(personAnswer(asked, null, ''), null);
  });

  it('parses no Markdown that would break the parser or keep it busy', () => {
    assert.equal(plainOnly('Method: x\n- one\n  - two\n> 1. quoted\n\n| a |\n| - |'), false);
    assert.equal(plainOnly(`${'> '.repeat(30)}x`), false);
    assert.equal(plainOnly(`${'> '.repeat(31)}x`), true);
    assert.equal(plainOnly(`  ${'- '.repeat(40)}x`), true);
    assert.equal(plainOnly(`${'1. '.repeat(40)}x`), true);
    assert.equal(plainOnly(`${'> - '.repeat(20)}x`), true);
    // A rule line or a row of stars is no nesting.
    assert.equal(plainOnly(`${'-'.repeat(120)}\n${'*'.repeat(120)}\n${'='.repeat(300)}`), false);
    assert.equal(plainOnly('['.repeat(200)), true);
    assert.equal(plainOnly('x'.repeat(MAX_CHARS)), false);
    assert.equal(plainOnly('x'.repeat(MAX_CHARS + 1)), true);
    assert.equal(plainOnly('a\n'.repeat(MAX_LINES)), true);
  });

  it('names the host of a link whose text is not its target', () => {
    assert.equal(linkHost('the paper', 'https://arxiv.org/abs/2408.08292'), 'arxiv.org');
    assert.equal(
      linkHost('https://github.com/safe/repo', 'https://evil.example/x'),
      'evil.example',
    );
    assert.equal(linkHost('https://example.com/a', 'https://example.com/a'), null);
    // A bare address in the text gets its scheme from the parser.
    assert.equal(linkHost('www.example.com', 'http://www.example.com'), null);
    assert.equal(linkHost('example.com:8080', 'https://example.com:8080/'), null);
    assert.equal(linkHost('x', 'http://'), 'http://');
  });

  it('names standings, and gives every result a chip', () => {
    assert.deepEqual(standingChip(result('p-1'), 'open'), { label: 'Not checked', tone: 'none' });
    assert.deepEqual(standingChip(result('p-1'), 'held_up'), { label: 'Held up', tone: 'hold' });
    assert.equal(standingChip({ ...result('p-1'), kind: 'message' }, 'open'), null);
    assert.equal(builtOnLabel([]), null);
    assert.equal(builtOnLabel(['p-4']), 'Built on by 1 post');
    assert.equal(builtOnLabel(['p-4', 'p-9']), 'Built on by 2 posts');
    assert.equal(harnessRequest(ask('p-1', 'agent-1')), 'permission');
    assert.equal(harnessRequest(result('p-1')), null);
    // Only the field that Verifold records makes a permission request. An agent's own ask with the same words is none.
    const lookalike = ask('p-1', 'agent-1', [], null);
    assert.equal(lookalike.text.startsWith('Permission needed:'), true);
    assert.equal(harnessRequest(lookalike), null);
    assert.equal(harnessRequest(ask('p-1', 'agent-1', [], 'question')), 'question');
  });
});

describe('agents', () => {
  it('lists a member that left under the others, out of the count, with who caused it and why', () => {
    const at = '2026-11-06T14:10:00Z';
    const gone = agentView('agent-1', {
      need: 'left',
      left: { at, by: 'agent-1', reason: 'My line is ruled out.' },
    });
    const removed = agentView('agent-3', {
      need: 'left',
      left: { at, by: 'person', reason: '' },
    });
    const agents = [
      gone,
      agentView('agent-2', { need: 'working', in_turn: true }),
      removed,
      agentView('agent-4'),
    ];

    assert.deepEqual(
      present(agents).map((view) => view.agent.id),
      ['agent-2', 'agent-4'],
    );
    // The members that left are the last group of the member list.
    assert.deepEqual(
      needGroups(agents).map((group) => [group.heading, group.rows.map((view) => view.agent.id)]),
      [
        ['Working (1)', ['agent-2']],
        ['Idle (1)', ['agent-4']],
        ['Left (2)', ['agent-1', 'agent-3']],
      ],
    );
    assert.equal(turnLine(agents).text, '1 of 2 agents in a turn');
    assert.deepEqual(leftLine({ at, by: 'agent-1', reason: 'My line is ruled out.' }), {
      text: 'Left by its own choice: My line is ruled out.',
      dot: 'stop',
    });
    assert.equal(leftLine({ at, by: 'person', reason: '' }).text, 'Left, removed by you');
    // A member is still a member after it left, so its posts keep its name and its picture.
    assert.equal(author(agents, 'agent-3').kind, 'member');
  });

  it('knows a member, the person, and a blind rerun, which has no name of its own in a thread', () => {
    const checker = agentView('checker-7');
    const agents = [
      agentView('agent-1'),
      { ...checker, agent: { ...checker.agent, name: 'Checker 7', checks: 'p-1' } },
      agentView('agent-2'),
    ];
    assert.deepEqual(
      members(agents).map((view) => view.agent.id),
      ['agent-1', 'agent-2'],
    );
    const second = author(agents, 'agent-2');
    assert.deepEqual(
      [second.kind, second.name, second.kind === 'member' && second.view === agents[2]],
      ['member', 'Agent 2', true],
    );
    assert.deepEqual(author(agents, 'checker-7'), { kind: 'rerun', name: 'Blind rerun' });
    assert.deepEqual(author(agents, 'person'), { kind: 'person', name: 'You' });
    // An author that the lab does not list shows as a blind rerun does, with its ID for a name.
    assert.deepEqual(author(agents, 'gone'), { kind: 'rerun', name: 'gone' });
    assert.deepEqual(
      ['agent-1', 'checker-7', 'person', 'gone'].map((id) => authorName(agents, id)),
      ['Agent 1', 'Blind rerun', 'You', 'gone'],
    );
    assert.deepEqual(
      ['agent-1', 'checker-7', 'person', 'gone'].map((id) => ownName(agents, id)),
      ['Agent 1', 'Checker 7', 'You', 'gone'],
    );
    assert.deepEqual(
      ['agent-1', 'checker-7', 'person'].map((id) => called(agents, id)),
      ['Agent 1', 'the blind rerun', 'you'],
    );
  });

  it('counts the members that are in a turn, and says so when none is', () => {
    const checker = agentView('checker-7');
    const rerun = { ...checker, agent: { ...checker.agent, checks: 'p-1' } };
    assert.deepEqual(
      turnLine([agentView('agent-1', { need: 'working', in_turn: true }), agentView('agent-2')]),
      {
        text: '1 of 2 agents in a turn',
        live: true,
      },
    );
    assert.equal(
      turnLine([agentView('agent-1', { need: 'working', in_turn: true })]).text,
      '1 of 1 agent in a turn',
    );
    // With no agent in a turn, the dot is hollow and the line counts who is in the lab.
    assert.deepEqual(turnLine([agentView('agent-1'), agentView('agent-2')]), {
      text: 'No agent in a turn, 2 in the lab',
      live: false,
    });
    // An ask that waits for the person puts no agent in a turn by itself.
    assert.equal(
      turnLine([
        agentView('agent-1', { need: 'approval' }),
        agentView('agent-2', { need: 'answer' }),
      ]).live,
      false,
    );
    // A turn in which the harness waits for the person's approval still runs, so its agent counts.
    const asking = {
      state: 'waiting',
      detail: 'Asks you: run pytest',
      at: null,
      waits_for: 'person',
    } as const;
    assert.deepEqual(
      turnLine([
        agentView('agent-1', { need: 'approval', in_turn: true, activity: asking }),
        agentView('agent-2'),
      ]),
      { text: '1 of 2 agents in a turn', live: true },
    );
    // A status alone counts nobody: the count follows the live turn.
    assert.equal(turnLine([agentView('agent-1', { need: 'working' })]).live, false);
    // The checker of a lab from before agents took reruns is no member, and the line counts no process for it.
    assert.deepEqual(turnLine([agentView('agent-1'), rerun]), {
      text: 'No agent in a turn, 1 in the lab',
      live: false,
    });
  });

  it('says how long a wanted rerun has waited and who took it', () => {
    const now = new Date('2026-11-06T14:26:00Z');
    const agents = [
      agentView('agent-2', { agent: { ...agentView('agent-2').agent, name: 'Tessel' } }),
    ];
    const wanted = (asked_at: string, taken_by: string[] = [], post = 'p-1'): RerunLine => ({
      post,
      thread: 't-1',
      asked_by: ['agent-1'],
      asked_at,
      taken_by,
    });
    assert.equal(wantedLine([], agents, now), null);
    assert.equal(
      wantedLine([wanted('2026-11-06T14:14:00Z')], agents, now),
      'A rerun is wanted, asked 12 min ago. No agent has taken it.',
    );
    assert.equal(
      wantedLine([wanted('2026-11-06T14:25:40Z', ['agent-2', 'agent-3'])], agents, now),
      'A rerun is wanted, asked just now. Taken by Tessel, agent-3.',
    );
    // A thread with several wanted reruns has one line, from the one that has waited longest.
    const two = [wanted('2026-11-06T12:26:00Z'), wanted('2026-11-06T14:20:00Z', [], 'p-4')];
    assert.equal(
      wantedLine(two, agents, now),
      '2 reruns are wanted, the first asked 2 h ago. No agent has taken one.',
    );
    assert.equal(
      wantedLine([wanted('2026-11-06T12:26:00Z', ['agent-2']), two[1] as RerunLine], agents, now),
      '2 reruns are wanted, the first asked 2 h ago. Agents have taken 1 of them.',
    );
  });

  it('says what wakes a member that is in no turn', () => {
    const now = new Date('2026-11-06T14:12:00Z');
    const rings = '2026-11-06T14:20:00Z';
    const alarm = { minutes: 10, quiet: false, rings_at: rings };
    const idle = { state: 'idle', detail: '', at: '2026-11-06T12:37:00Z' } as const;
    const rested = agentView('agent-1', { activity: idle, turn_ended_at: '2026-11-06T12:37:00Z' });
    assert.deepEqual(memberLine({ ...rested, alarm }, false, now), {
      text: `Waits for its alarm at ${clock(rings)}.`,
      dot: 'idle',
    });
    // An alarm whose time passed still waits: it rings when the agent's turn ends.
    const past = '2026-11-06T14:05:00Z';
    assert.equal(
      memberLine({ ...rested, alarm: { ...alarm, rings_at: past } }, false, now).text,
      `Waits for its alarm at ${clock(past)}.`,
    );
    // An alarm for another day shows the day.
    const later = '2026-11-07T13:00:00Z';
    assert.equal(
      memberLine({ ...rested, alarm: { ...alarm, rings_at: later } }, false, now).text,
      `Waits for its alarm at ${dayClock(later, now)}.`,
    );
    assert.match(dayClock(later, now), /^Nov \d{1,2} \d\d:\d\d$/);
    assert.equal(dayClock(rings, now), clock(rings));
    // The time of an alarm for a quiet board moves with each post, so the line gives the rule and no time.
    const quiet = { minutes: 90, quiet: true, rings_at: rings };
    assert.equal(
      memberLine({ ...rested, alarm: quiet }, false, now).text,
      'Waits for its alarm: rings after 1 h 30 min with no new post.',
    );
    assert.deepEqual(memberLine(rested, false, now), {
      text: 'Its last turn ended 1 h 35 min ago, and no alarm is set. A post for it wakes it.',
      dot: 'idle',
    });
    assert.equal(
      memberLine({ ...rested, turn_ended_at: '2026-11-06T14:11:40Z' }, false, now).text,
      'Its last turn ended just now, and no alarm is set. A post for it wakes it.',
    );
    // No alarm rings in a lab that is out of time or closed, so the line names none.
    const held = { ...alarm, rings_at: null };
    assert.equal(memberLine({ ...rested, alarm: held }, true, now).text, 'Idle, 1 h 35 min');
    assert.equal(
      memberLine({ ...rested, alarm: { ...held, quiet: true } }, true, now).text,
      'Idle, 1 h 35 min',
    );
    // An agent that waits again after a restart and has no turn in the record keeps the plain line.
    assert.equal(
      memberLine(agentView('agent-1', { activity: idle }), false, now).text,
      'Idle, 1 h 35 min',
    );
    // A member in a turn, a stopped member, and one that left keep their lines, with an alarm or without.
    const working = { state: 'working', detail: 'Run pytest', at: '2026-11-06T14:10:00Z' } as const;
    assert.equal(
      memberLine({ ...rested, activity: working, alarm }, false, now).text,
      'Run pytest, 2 min',
    );
    const stopped = { state: 'stopped', detail: '', at: null } as const;
    assert.equal(memberLine({ ...rested, activity: stopped }, false, now).text, 'Stopped');
    const left = { at: '2026-11-06T14:00:00Z', by: 'person', reason: '' };
    assert.equal(memberLine({ ...rested, left }, false, now).text, 'Left, removed by you');
  });

  it('says what an agent does and what it costs', () => {
    const now = new Date('2026-11-06T14:12:00Z');
    const working = { state: 'working', detail: 'Run pytest', at: '2026-11-06T14:10:00Z' } as const;
    assert.deepEqual(stateLine(working, now), { text: 'Run pytest, 2 min', dot: 'live' });
    assert.deepEqual(stateLine({ state: 'stopped', detail: '', at: null }, now), {
      text: 'Stopped',
      dot: 'stop',
    });
    // The server gives the reason for an agent that no loop runs.
    const lacks = {
      state: 'stopped',
      detail: 'Its harness is not on this computer.',
      at: null,
    } as const;
    assert.equal(stateLine(lacks, now).text, 'Its harness is not on this computer.');
    const priced = agentView('agent-1', { turns: 4, cost_usd: 0.37 });
    const unpriced = agentView('agent-2', {
      turns: 3,
      usage: { input_tokens: 461_000, cached_input_tokens: 0, output_tokens: 2_000 },
    });
    assert.equal(costLine(priced), '$0.37 over 4 turns');
    assert.equal(
      costLine(unpriced),
      '461k tokens in, 2k out over 3 turns. Cost not reported by the harness.',
    );
    assert.equal(costLine(agentView('agent-3')), 'No turns yet');
    // An agent in its first turn has started one, and none has ended.
    assert.equal(costLine(agentView('agent-3', { turns_started: 1 })), 'In its first turn');
    assert.equal(costLine({ ...priced, turns_started: 5 }), '$0.37 over 4 turns');
    // An invited agent runs by itself. Verifold sees its board calls and nothing else.
    const guest = agentView('agent-4', {
      agent: { ...agentView('agent-4').agent, harness: 'guest' },
    });
    assert.equal(costLine(guest), 'Runs by itself, so Verifold sees no turns and no cost.');
    const at = '2026-11-06T14:10:00Z';
    assert.deepEqual(
      (['invited', 'listening', 'here'] as const).map(
        (state) => stateLine({ state, detail: '', at }, now).text,
      ),
      ['Invited, not joined yet', 'Waits for a post, 2 min', 'Last board call 2 min ago'],
    );
    assert.equal(stateLine({ state: 'here', detail: '', at: null }, now).text, 'Joined');
    assert.deepEqual(stateLine({ state: 'void', detail: '', at: null }, now), {
      text: 'Invitation is void. Invite again.',
      dot: 'stop',
    });
    // Nobody knows whether an invited agent came until its first post, so it is no member in the count before.
    assert.equal(counted([agentView('agent-1'), guest]).length, 1);
    assert.equal(
      turnLine([agentView('agent-1'), { ...guest, posts: 1 }]).text,
      'No agent in a turn, 2 in the lab',
    );
    assert.equal(
      stateLine({ state: 'here', detail: '', at: '2026-11-06T14:11:30Z' }, now).text,
      'Last board call just now',
    );
    assert.equal(
      labTotal([priced, unpriced]),
      '$0.37, and 463k tokens with cost not reported by the harness',
    );
    // A harness that reports tokens and no cost never shows as $0.
    assert.equal(labTotal([unpriced]), '463k tokens with cost not reported by the harness');
    assert.equal(labTotal([]), 'No cost reported yet');
    assert.equal(labTotal([priced]), '$0.37');
  });
});

describe('turns', () => {
  const name = (id: string): string => (id === 'person' ? 'you' : id);
  const reply = (kind: object): Post => ({ ...result('p-9', { reply_to: 'p-1' }), ...kind });
  const target = result('p-1', { author: 'agent-2' });

  it('writes a turn as one line from the post and the post that it answers', () => {
    const context = { called: name, author: null };
    const line = (kind: object, to: Post | null = target): string => act(reply(kind), to, context);
    assert.deepEqual(
      [
        act(result('p-1'), null, context),
        line({ kind: 'result' }),
        line({ kind: 'proposal' }),
        line({ kind: 'proposal', thread: 't-2', reply_to: null }),
        line({ kind: 'plan' }),
        line({ kind: 'ruled_out' }),
        line({ kind: 'objection' }),
        line({ kind: 'ask', choices: [] }),
        line({ kind: 'answer', accepts: true }, reply({ kind: 'objection', author: 'agent-3' })),
        line({ kind: 'answer', accepts: false }, reply({ kind: 'ask', author: 'person' })),
        line({ kind: 'check', method: 'rerun', outcome: 'holds' }),
        line({ kind: 'check', method: 'code_read', outcome: 'fails' }),
        line({ kind: 'check', method: 'ratings', outcome: 'holds' }),
        line({ kind: 'message' }),
        line({ kind: 'message', reply_to: null }, null),
        line({ kind: 'report', reply_to: null }, null),
        line({ kind: 'call', reply_to: null }, null),
        line({ kind: 'plan' }, reply({ kind: 'call', author: 'agent-3' })),
      ],
      [
        'posted a result',
        'posted a result in reply to agent-2’s result',
        'proposed an answer in reply to agent-2’s result',
        'proposed an answer',
        'posted a plan in reply to agent-2’s result',
        'ruled out a lead in reply to agent-2’s result',
        'objected to agent-2’s result',
        'asked a question in reply to agent-2’s result',
        'accepted agent-3’s objection',
        'answered you',
        'reran agent-2’s result: it holds',
        'read the code of agent-2’s result: it fails',
        'rated agent-2’s result: it holds',
        'replied to agent-2',
        'added a note',
        'reported to you',
        'called for an agent',
        'took agent-3’s call',
      ],
    );
  });

  it('says when an agent calls the lab done, who agrees, and how many stand behind it', () => {
    const close = result('p-1', { kind: 'close' });
    const agree = result('p-2', {
      kind: 'answer',
      reply_to: 'p-1',
      accepts: true,
    });
    const context = { called: () => 'Agent 1', author: null };
    assert.equal(act(close, null, context), 'said that the lab is done');
    assert.equal(act(agree, close, context), 'agreed that the lab is done');
    assert.equal(doneLine({ state: 'open', close_agreed: 0, close_among: 0 }), null);
    assert.equal(
      doneLine({ state: 'closing', close_agreed: 0, close_among: 3 }),
      'An agent says that the lab is done (1 of 3 agents so far).',
    );
    assert.equal(
      doneLine({ state: 'closed', close_agreed: 1, close_among: 3 }),
      'The agents say that the lab is done (2 of 3 agents). You can still steer it.',
    );
    // The agent that said it left since, and nobody else is in the lab. Its word still counts.
    assert.equal(
      doneLine({ state: 'closed', close_agreed: 0, close_among: 1 }),
      'The agents say that the lab is done (1 of 1 agent). You can still steer it.',
    );
  });

  it('says "blind" only for the rerun of the checker that Verifold started for that post', () => {
    const rerun = reply({ kind: 'check', method: 'rerun', outcome: 'fails' });
    const checker = (checks: string): object => ({
      called: name,
      author: { ...agentView('checker-7').agent, checks },
    });
    const line = (context: object): string => act(rerun, target, context as ActContext);
    assert.equal(line(checker('p-1')), 'reran agent-2’s result blind: it fails');
    // A member reran it and saw the thread. A checker for another post is not blind to this one.
    assert.equal(
      line({ called: name, author: agentView('agent-3').agent }),
      'reran agent-2’s result: it fails',
    );
    assert.equal(line(checker('p-5')), 'reran agent-2’s result: it fails');
    // A member that took the rerun ran it in the clean copy that Verifold made for that take.
    assert.equal(
      act({ ...rerun, take: 12 } as Post, target, {
        called: name,
        author: agentView('agent-3').agent,
      }),
      'reran agent-2’s result from a clean copy: it fails',
    );
  });

  it('names a post that the page does not have as "a post"', () => {
    const context = { called: name, author: null };
    const line = (kind: object): string => act(reply(kind), null, context);
    assert.deepEqual(
      [
        line({ kind: 'objection' }),
        line({ kind: 'answer', accepts: true }),
        line({ kind: 'answer', accepts: false }),
        line({ kind: 'check', method: 'rerun', outcome: 'fails' }),
        line({ kind: 'message' }),
        line({ kind: 'result' }),
      ],
      [
        'objected to a post',
        'accepted a post',
        'answered a post',
        'reran a post: it fails',
        'replied to a post',
        'posted a result in reply to a post',
      ],
    );
  });

  it('gives each kind of turn the tone of its mark', () => {
    const kinds: readonly object[] = [
      { kind: 'check', method: 'rerun', outcome: 'holds' },
      { kind: 'check', method: 'rerun', outcome: 'fails' },
      { kind: 'objection' },
      { kind: 'answer', accepts: true },
      { kind: 'answer', accepts: false },
      { kind: 'result' },
      { kind: 'ruled_out' },
      { kind: 'proposal' },
      { kind: 'ask', choices: [] },
      { kind: 'plan' },
      { kind: 'message' },
    ];
    assert.deepEqual(
      kinds.map((kind) => tone(reply(kind))),
      ['good', 'bad', 'bad', 'turn', 'quiet', 'claim', 'claim', 'answer', 'ask', 'quiet', 'quiet'],
    );
  });

  it('says what an author is to a thread', () => {
    const thread = { id: 't-2', title: 'A', opened_by: 'agent-1' };
    const lead = agentView('agent-1').agent;
    const visitor = agentView('agent-2').agent;
    const checker = { ...agentView('checker-7').agent, checks: 'p-1' };
    assert.equal(standingIn(lead, thread, 't-1', null), 'leads this thread');
    assert.equal(standingIn(visitor, thread, 't-1', null), 'visiting');
    assert.equal(standingIn(lead, thread, 't-2', null), null);
    assert.equal(standingIn(null, thread, 't-1', null), null);
    assert.equal(standingIn(checker, thread, 't-2', null), 'outside checker');
    assert.equal(standingIn(checker, thread, 't-1', 'anthropic'), 'outside checker');
    assert.equal(
      standingIn(checker, thread, 't-1', 'openai'),
      'outside checker, other model family',
    );
  });

  it('finds the question’s thread by the server’s rule: the first thread, the person, and the title', () => {
    const first = summary({ thread: { id: 't-1', title: 'The question', opened_by: 'person' } });
    const other = summary({ thread: { id: 't-2', title: 'The question', opened_by: 'person' } });
    const renamed = summary({ thread: { id: 't-1', title: 'Sort it', opened_by: 'person' } });
    assert.equal(questionThread([other, first]), first);
    assert.equal(questionThread([other, summary()]), null);
    assert.equal(questionThread([renamed]), null);
    assert.equal(questionThread([other]), null);
  });

  it('nests replies to two levels and folds runs of status notes in the question’s thread', () => {
    const note = (id: string, changes: Partial<Post> = {}): PostView =>
      postView(result(id, { kind: 'message', ...changes }));
    const posts = [
      note('p-1', { author: 'person' }),
      note('p-2'),
      note('p-3'),
      postView(result('p-4')),
      postView(result('p-5', { kind: 'objection', reply_to: 'p-4' })),
      postView(reply({ id: 'p-6', kind: 'answer', accepts: true, reply_to: 'p-5' })),
      note('p-7', { reply_to: 'p-6' }),
      note('p-8'),
      note('p-9', { reply_to: 'p-8' }),
      note('p-10', { reply_to: 'p-99' }),
    ];
    const shape = (question: string | null): readonly string[] =>
      rows(posts, question).map((row) =>
        row.kind === 'turn'
          ? `${row.item.post.id}:${row.depth}`
          : row.items.map((item) => item.post.id).join('+'),
      );
    assert.deepEqual(shape('t-1'), [
      'p-1:0',
      'p-2+p-3',
      'p-4:0',
      'p-5:1',
      'p-6:2',
      'p-7:2',
      'p-8:0',
      'p-9:1',
      'p-10',
    ]);
    assert.equal(shape(null).includes('p-2:0'), true);
    assert.equal(isStatusNote(result('p-1', { kind: 'message' }), 't-1'), true);
    assert.equal(isStatusNote(result('p-1', { kind: 'message', thread: 't-2' }), 't-1'), false);
    assert.equal(isStatusNote(result('p-1'), 't-1'), false);
  });

  it('finds what a thread stands on', () => {
    const proposal = (id: string): Post => result(id, { kind: 'proposal' });
    const posts = [
      postView(result('p-1'), 1, 'checked'),
      postView(proposal('p-2'), 2, 'disputed'),
      postView(proposal('p-3'), 3, 'conceded'),
      postView(result('p-4', { kind: 'message' }), 4),
    ];
    assert.equal(headClaim(posts)?.post.id, 'p-2');
    assert.equal(headClaim([postView(result('p-1'), 1, 'conceded')])?.post.id, 'p-1');
    assert.equal(headClaim([]), null);
    // A ruled-out lead is not what a thread stands on.
    const lead = postView(result('p-5', { kind: 'ruled_out' }), 5, 'checked');
    assert.equal(headClaim([...posts, lead])?.post.id, 'p-2');
    assert.equal(headClaim([lead]), null);
  });

  it('gives a closed card a status that the summary’s counts support', () => {
    const status = (changes: Partial<ThreadSummary>): string => {
      const { label, edge, openAsks } = cardStatus(summary(changes));
      return `${label} / ${edge} / ${openAsks}`;
    };
    assert.deepEqual(
      [
        status({}),
        status({ not_checked: 2 }),
        status({ checked: 2 }),
        status({ checked: 1, not_checked: 2, open_asks: 1 }),
        status({ disputed: 1, checked: 3, open_asks: 2 }),
      ],
      [
        'No result yet / none / null',
        'Not checked / none / null',
        'Checked / good / null',
        '1 of 3 checked / good / Open ask',
        '1 disputed / bad / 2 open asks',
      ],
    );
    assert.deepEqual(
      [0, 1, 3].map((calls) => cardStatus(summary({ open_calls: calls })).openCalls),
      [null, 'Needs an agent', '3 calls need an agent'],
    );
  });
});

describe('needs', () => {
  const waiting = { state: 'waiting', detail: '', at: null } as const;
  const needs = [
    postView({ ...ask('p-1', 'agent-1', [], null), text: 'Permission needed: which seed?' }),
    postView({ ...ask('p-2', 'agent-2', [], 'question'), text: 'Which branch?' }),
    postView(ask('p-3', 'agent-3')),
  ];
  const ids = (items: readonly PostView[]): readonly string[] => items.map((item) => item.post.id);

  it('puts the permission requests of paused agents first, and keeps the rest in order', () => {
    const lab = labView({
      agents: [
        agentView('agent-1', { activity: waiting }),
        agentView('agent-2', { activity: waiting }),
      ],
    });
    assert.deepEqual(ids(orderNeeds(needs, lab)), ['p-2', 'p-1', 'p-3']);
    assert.deepEqual(
      needs.map((item) => pauses(item, lab)),
      [false, true, false],
    );
  });

  it('pauses nothing once the lab is out of time', () => {
    const lab = labView({
      out_of_time: true,
      agents: [agentView('agent-2', { activity: waiting })],
    });
    assert.deepEqual(ids(orderNeeds(needs, lab)), ['p-1', 'p-2', 'p-3']);
  });
});

describe('seen', () => {
  it('remembers the last post that the person saw in each thread', () => {
    const store = memoryStore();
    assert.equal(hasNew(summary(), readSeen(store, 'lab')), true);
    markSeen(store, 'lab', 't-1', 7);
    markSeen(store, 'lab', 't-1', 3);
    assert.deepEqual(readSeen(store, 'lab'), { 't-1': 7 });
    assert.equal(hasNew(summary(), readSeen(store, 'lab')), false);
    const fromPerson = summary({
      latest: {
        id: 'p-4',
        thread: 't-1',
        author: 'person',
        kind: 'message',
        text: 'Go on.',
        reply_to: null,
        seq: 9,
        at: '2026-11-06T14:10:00Z',
        by: null,
      },
    });
    assert.equal(hasNew(fromPerson, readSeen(store, 'lab')), false);
  });

  it('treats damaged storage as nothing seen', () => {
    const store = memoryStore();
    store.setItem('verifold-seen:lab', '{not json');
    assert.deepEqual(readSeen(store, 'lab'), {});
    store.setItem('verifold-seen:lab', '{"t-1": "7", "t-2": 4}');
    assert.deepEqual(readSeen(store, 'lab'), { 't-2': 4 });
  });
});

describe('setup', () => {
  it('starts with one agent of each harness that this computer has', () => {
    const picks = firstSeats(HARNESSES, DEFAULTS);
    assert.deepEqual(
      picks.map((pick) => pick.count),
      [1, 0],
    );
    assert.equal(agentCount(step(step(picks, 0, 30), 1, -1)), 20);
    // The limit is for the whole lab: a second seat gets only the room that the first leaves.
    const both = [newSeat('claude-code', 15), newSeat('codex', 0)];
    assert.deepEqual(
      step(both, 1, 10).map((pick) => pick.count),
      [15, 5],
    );
    // Over the limit, a step down still works, and nothing goes below zero or grows.
    const over = [newSeat('claude-code', 18), newSeat('codex', 5)];
    assert.deepEqual(
      step(over, 1, -1).map((pick) => pick.count),
      [18, 4],
    );
    assert.deepEqual(
      step(over, 1, 1).map((pick) => pick.count),
      [18, 5],
    );
    assert.deepEqual(
      step(step(over, 1, -5), 1, -1).map((pick) => pick.count),
      [18, 0],
    );
    const many = Array.from({ length: 25 }, (_, number) => ({
      ...HARNESSES[0],
      name: `h${String(number)}`,
    })) as typeof HARNESSES;
    assert.equal(agentCount(firstSeats(many, DEFAULTS)), 20);
  });

  it('sends only the choices that the person made', () => {
    const picks = [
      { ...newSeat('claude-code', 3), model: ' opus ', mode: 'plan' },
      { ...newSeat('codex', 0), effort: 'low' },
    ];
    assert.deepEqual(startRequest(' Is it faster? ', picks, false, 30), {
      question: 'Is it faster?',
      agents: [{ harness: 'claude-code', count: 3, model: 'opus', mode: 'plan' }],
      auto_mode: false,
      minutes: 30,
    });
    assert.equal('minutes' in startRequest('Q?', picks, true, null), false);
    assert.deepEqual(['Claude Code', 'Codex'].map(initials), ['CC', 'CX']);
  });

  it('gives a harness several seats, each with its own model and facts', () => {
    const seats = addSeat([newSeat('claude-code'), newSeat('codex')], 'claude-code');
    assert.deepEqual(
      seats.map((seat) => seat.harness),
      ['claude-code', 'claude-code', 'codex'],
    );
    const driver = {
      ...newSeat('claude-code'),
      model: 'opus',
      role: ' driver ',
      family: 'anthropic',
    };
    const called = { ...newSeat('claude-code'), model: 'fable', typed: true, onCall: true };
    assert.deepEqual(startRequest('Q?', [driver, called, newSeat('codex', 2)], true, null).agents, [
      { harness: 'claude-code', count: 1, model: 'opus', role: 'driver', family: 'anthropic' },
      { harness: 'claude-code', count: 1, model: 'fable', on_call: true },
      { harness: 'codex', count: 2 },
    ]);
    assert.deepEqual(
      removeSeat(seats, 1).map((seat) => seat.harness),
      ['claude-code', 'codex'],
    );
    // A full lab still gets the seat, with no agent in it.
    assert.equal(addSeat([newSeat('codex', 20)], 'codex')[1]?.count, 0);
  });

  it('keeps one coordinator, in a seat of one agent', () => {
    const seats = [
      { ...newSeat('claude-code', 3), coordinator: true },
      newSeat('codex', 2),
      newSeat('codex', 0),
    ];
    const moved = withSeat(seats, 1, { ...newSeat('codex', 2), coordinator: true });
    assert.deepEqual(
      moved.map((seat) => [seat.coordinator, seat.count]),
      [
        [false, 3],
        [true, 1],
        [false, 0],
      ],
    );
    assert.equal(step(moved, 1, 1)[1]?.count, 1);
    assert.deepEqual(seatChoice(moved[1] ?? newSeat('codex')), {
      harness: 'codex',
      count: 1,
      coordinator: true,
    });
    // Any other change leaves the other seats as they are.
    assert.deepEqual(
      withSeat(moved, 0, { ...newSeat('claude-code', 3), role: 'driver' })[1],
      moved[1],
    );
    // An empty seat that becomes the coordinator's takes one agent only while the lab has room.
    const empty = { ...newSeat('codex', 0), coordinator: true };
    assert.equal(
      withSeat([newSeat('claude-code', 19), newSeat('codex', 0)], 1, empty)[1]?.count,
      1,
    );
    assert.equal(
      withSeat([newSeat('claude-code', 20), newSeat('codex', 0)], 1, empty)[1]?.count,
      0,
    );
  });

  it('asks for the ID of a typed model, and says when every seat is on call', () => {
    const typed = { ...newSeat('claude-code'), typed: true };
    assert.deepEqual(
      [typed, { ...typed, model: ' ' }, { ...typed, model: 'fable' }, { ...typed, count: 0 }].map(
        needsModel,
      ),
      [true, true, false, false],
    );
    const called = { ...newSeat('codex'), onCall: true };
    assert.equal(allOnCall([called, { ...called, harness: 'claude-code' }]), true);
    assert.equal(allOnCall([called, newSeat('claude-code')]), false);
    // A seat with no agent starts nothing, so it does not count.
    assert.equal(allOnCall([called, newSeat('claude-code', 0)]), true);
    assert.equal(allOnCall([newSeat('claude-code', 0)]), false);
  });

  it('lets the person type a model that the harness does not list', () => {
    const typed = withModel({ ...newSeat('claude-code'), effort: 'low' }, OFFER, OTHER_MODEL);
    assert.deepEqual([typed.typed, typed.model, typed.effort], [true, '', '']);
    assert.equal(withModel({ ...typed, model: 'fable' }, OFFER, 'opus').typed, false);
    assert.equal(modelSummary({ ...typed, model: 'fable' }, OFFER), 'fable');
    // The harness said nothing about the effort levels of a model that it does not list.
    assert.deepEqual(effortsOf(OFFER, 'fable').values, []);
  });

  it('names the choices with the names that the harness offered', () => {
    const pick = newSeat('claude-code');
    assert.equal(
      modelSummary({ ...pick, role: 'driver', coordinator: true, onCall: true }, OFFER),
      'Opus, High effort (your default) · driver, coordinator, on call',
    );
    assert.equal(modelSummary(pick, OFFER), 'Opus, High effort (your default)');
    // A family that is not the harness's own shows on the closed line, whatever its capitals.
    assert.equal(
      modelSummary({ ...pick, family: ' Other ', role: 'driver' }, OFFER, 'anthropic'),
      'Opus, High effort (your default) · Other family, driver',
    );
    assert.equal(
      modelSummary({ ...pick, family: 'Anthropic' }, OFFER, 'anthropic'),
      'Opus, High effort (your default)',
    );
    assert.equal(
      modelSummary({ ...pick, model: 'default' }, OFFER),
      'Default (recommended), default effort',
    );
    assert.equal(modelSummary({ ...pick, model: 'haiku' }, OFFER), 'Haiku');
    assert.equal(modelSummary({ ...pick, effort: 'low' }, OFFER), 'Opus, Low effort');
    assert.equal(
      modelSummary({ ...pick, mode: 'plan' }, OFFER),
      'Opus, High effort (your default), Plan mode',
    );
    assert.equal(modelSummary(pick, null), 'Your default model and effort');
    assert.equal(modelSummary({ ...pick, effort: 'low' }, null), 'Your default model, low effort');
    assert.equal(modelSummary({ ...pick, model: 'gpt-x' }, null), 'gpt-x, default effort');
  });

  it("puts the person's own setting first in each menu, and sends nothing for it", () => {
    assert.deepEqual(menuEntries(OFFER.models, OFFER.model), [
      { value: '', label: 'Opus (your default)' },
      { value: 'default', label: 'Default (recommended)' },
      { value: 'haiku', label: 'Haiku' },
      { value: 'sonnet', label: 'Sonnet' },
    ]);
    assert.deepEqual(menuEntries(OFFER.efforts, null)[0], { value: '', label: 'Your default' });
    assert.deepEqual(menuEntries([], 'opus'), []);
    assert.deepEqual(
      modeEntries(OFFER).map((entry) => entry.label),
      ['Your auto mode answer', 'Manual (your default)', 'Plan', 'Auto'],
    );
    assert.deepEqual(modeEntries({ ...OFFER, modes: [] }), []);
  });

  it('offers the effort levels of the chosen model, and drops a level that the model lacks', () => {
    const pick = { ...newSeat('claude-code'), effort: 'low' };
    assert.deepEqual(effortsOf(OFFER, ''), { values: OFFER.efforts, current: 'high' });
    assert.deepEqual(effortsOf(OFFER, 'default').current, null);
    assert.deepEqual(effortsOf(OFFER, 'haiku').values, []);
    assert.deepEqual(effortsOf(OFFER, 'sonnet').values, []);
    assert.equal(withModel(pick, OFFER, 'default').effort, 'low');
    assert.deepEqual(withModel(pick, OFFER, 'haiku'), { ...pick, model: 'haiku', effort: '' });
  });
});

describe('time', () => {
  const now = new Date('2026-11-06T14:26:00Z');

  it('says how long the lab has run and when it ends', () => {
    assert.equal(clockLine(labView(), now), 'Running, 26 min');
    assert.equal(clockLine(labView({ out_of_time: true }), now), 'Out of time');
    assert.equal(clockLine(labView({ ends_at: '2026-11-06T15:00:00Z' }), now), '26 min of 1 h');
    assert.equal(endLine(labView(), now), 'No time limit.');
    assert.match(endLine(labView({ ends_at: '2026-11-06T14:38:00Z' }), now), /, in 12 min\.$/);
  });

  it('adds more time to what is left, up to a week', () => {
    assert.equal(moreTime(labView({ ends_at: '2026-11-06T14:38:00Z' }), 30, now), 42);
    assert.equal(
      moreTime(labView({ ends_at: '2026-11-06T14:00:00Z', out_of_time: true }), 30, now),
      30,
    );
    assert.equal(moreTime(labView({ ends_at: '2026-11-20T14:00:00Z' }), 60, now), MAX_MINUTES);
  });
});

describe('an answer to an ask', () => {
  it('names a pressed choice as its choice, and sends typed words as words only', () => {
    const asked = ask('p-1', 'agent-1', ['Yes', 'No']);
    assert.deepEqual(personAnswer(asked, 'Yes', ' but not on prod '), {
      kind: 'answer',
      thread: 't-2',
      reply_to: 'p-1',
      text: 'Yes',
      body: 'but not on prod',
      choice: 'Yes',
    });
    assert.deepEqual(personAnswer(asked, null, 'Yes\n\nbut wait, not on prod'), {
      kind: 'answer',
      thread: 't-2',
      reply_to: 'p-1',
      text: 'Yes',
      body: 'but wait, not on prod',
    });
  });

  it('finds the long runs of blank lines in a text and keeps the rest as it is', () => {
    assert.deepEqual(gaps('a\n\n\nb'), ['a\n\n\nb']);
    assert.deepEqual(gaps(`a\n${'  \n'.repeat(5)}b\n`), ['a', 5, 'b\n']);
    assert.deepEqual(gaps(`${'\n'.repeat(6)}tail`), [6, 'tail']);
    assert.deepEqual(gaps(''), ['']);
  });

  it('gives each choice a key of its own, also when two have one name', () => {
    const groups = choiceGroups(['Same', 'Same'], null);
    assert.deepEqual(
      groups[0]?.options.map((option) => option.key),
      ['0:Same', '1:Same'],
    );
    assert.deepEqual(choiceGroups([], null), []);
  });
});

describe('settings', () => {
  it('reads a setting by its key with dots, and finds nothing where a file has nothing', () => {
    const values = { jobs: { at_exit: 'keep' }, harnesses: ['odd'] };
    assert.equal(valueAt(values, 'jobs.at_exit'), 'keep');
    assert.equal(valueAt(values, 'jobs.at_time_limit'), undefined);
    assert.equal(valueAt(values, 'harnesses.0'), undefined);
    assert.equal(valueAt({}, 'jobs.at_exit'), undefined);
    assert.equal(labelOf(AT_EXIT, 'keep'), 'Keep them');
    assert.equal(valueAt({ reviewers: { seats: 2 } }, 'reviewers.seats'), 2);
    // The reviewer seats are a whole number from 0 to 20, or an empty field for no number.
    assert.deepEqual(
      ['', ' 0 ', '3', '20', '21', '-1', '1.5', 'two'].map((text) => seatsValue(text)),
      [null, 0, 3, 20, undefined, undefined, undefined, undefined],
    );
    assert.deepEqual(parseRoute('#/settings'), { page: 'settings' });
    assert.deepEqual(parseRoute('#/norms'), { page: 'norms' });
    assert.equal(href({ page: 'norms' }), '#/norms');
    assert.equal(href({ page: 'settings' }), '#/settings');
  });

  it('says what a stop does to the processes that agents left running', () => {
    const settings = labView().settings;
    assert.match(stopLine(settings), /pause until you give the lab more time/);
    assert.match(
      stopLine({ ...settings, jobs: { ...settings.jobs, at_time_limit: 'stop' } }),
      /stop too/,
    );
    assert.match(
      stopLine({ ...settings, jobs: { ...settings.jobs, at_time_limit: 'finish' } }),
      /continue until they end/,
    );
  });
});

describe('choices for new labs', () => {
  const saved = {
    agents: [
      { harness: 'claude-code', count: 2, model: 'opus', effort: null, mode: 'plan' },
      { harness: 'codex', count: 3, model: null, effort: 'low', mode: null },
    ],
    auto_mode: false,
    minutes: 45,
  };

  it('start the setup, with nothing for a harness that this computer lacks', () => {
    assert.deepEqual(firstSeats(HARNESSES, saved), [
      { ...newSeat('claude-code', 2), model: 'opus', mode: 'plan' },
      newSeat('codex', 0),
    ]);
    assert.deepEqual(
      firstSeats(HARNESSES, DEFAULTS).map((pick) => pick.count),
      [1, 0],
    );
  });

  it('start the setup with each saved seat of a harness, and with a seat of none for a harness that they leave out', () => {
    const both = HARNESSES.map((option) => ({ ...option, available: true, offer: OFFER }));
    const seats = {
      agents: [
        {
          harness: 'claude-code',
          count: 1,
          model: 'opus',
          effort: null,
          mode: null,
          role: 'driver',
        },
        {
          harness: 'claude-code',
          count: 1,
          model: 'fable',
          effort: null,
          mode: null,
          role: 'direction creator',
          family: 'anthropic',
          on_call: true,
          coordinator: true,
        },
      ],
      auto_mode: true,
      minutes: null,
    };
    assert.deepEqual(firstSeats(both, seats), [
      { ...newSeat('claude-code'), model: 'opus', role: 'driver' },
      {
        ...newSeat('claude-code'),
        model: 'fable',
        // The harness does not list this model now, so the person sees it as a typed one.
        typed: true,
        role: 'direction creator',
        family: 'anthropic',
        onCall: true,
        coordinator: true,
      },
      newSeat('codex', 0),
    ]);
    assert.equal(
      defaultsLine(seats, both),
      'Claude Code: 1 agent (opus, role: driver); Claude Code: 1 agent (fable, anthropic family, role: direction creator, coordinator, on call). Auto mode. No time limit.',
    );
  });

  it('come from the setup as the person left it, and read as words', () => {
    const picks = firstSeats(HARNESSES, saved);
    assert.deepEqual(setupChoices(picks, false, 45), {
      agents: [{ harness: 'claude-code', count: 2, model: 'opus', mode: 'plan' }],
      auto_mode: false,
      minutes: 45,
    });
    assert.equal(
      defaultsLine(saved, HARNESSES),
      'Claude Code: 2 agents (opus, plan mode); Codex: 3 agents (low effort). No auto mode. Time limit: 45 min.',
    );
    assert.equal(
      defaultsLine(DEFAULTS, HARNESSES),
      'One agent of each harness that this computer has. Auto mode. No time limit.',
    );
  });

  it('keep a saved value in its menu when the harness no longer offers it', () => {
    assert.deepEqual(menuEntries(OFFER.models, OFFER.model, 'gone').at(-1), {
      value: 'gone',
      label: 'gone',
    });
    assert.equal(menuEntries(OFFER.models, OFFER.model, 'haiku').length, 4);
    assert.deepEqual(menuEntries([], null, 'high'), [
      { value: '', label: 'Your default' },
      { value: 'high', label: 'high' },
    ]);
    assert.deepEqual(modeEntries({ ...OFFER, modes: [] }, 'yolo'), [
      { value: '', label: 'Your auto mode answer' },
      { value: 'yolo', label: 'yolo' },
    ]);
  });
});

describe('crossings', () => {
  const agents = [agentView('agent-1'), agentView('agent-2'), agentView('agent-3')];
  const link = (thread: string, count: number, ...ids: string[]) => ({
    thread,
    agents: ids,
    count,
  });
  const threads = [
    summary({ thread: { id: 't-2', title: 'Baseline', opened_by: 'agent-1' } }),
    summary({ thread: { id: 't-3', title: 'Curves', opened_by: 'agent-2' } }),
    summary({ thread: { id: 't-4', title: 'Reading', opened_by: 'agent-3' } }),
  ];

  it('names the first linked threads with their agents, and leaves out a thread that the page lacks', () => {
    const links = [
      link('t-9', 4, 'agent-1'),
      link('t-4', 3, 'agent-3', 'agent-2'),
      link('t-3', 2, 'agent-2'),
      link('t-2', 1, 'agent-2'),
    ];
    assert.deepEqual(crossLines(links, threads, agents), [
      { thread: 't-4', title: 'Reading', agents: 'Agent 3, Agent 2' },
      { thread: 't-3', title: 'Curves', agents: 'Agent 2' },
    ]);
  });

  it('counts the posts that build on another agent’s work, and says nothing when there are none', () => {
    assert.equal(crossedLine(threads), null);
    assert.equal(
      crossedLine([summary({ crossed: 1 })]),
      'One post builds on another agent’s work in another thread.',
    );
    assert.equal(
      crossedLine([summary({ crossed: 4 }), summary({ crossed: 2 })]),
      '6 posts build on another agent’s work in another thread.',
    );
  });
});

describe('the question', () => {
  const version = { question: 'Faster?', at: '2026-11-06T14:00:00Z', note: '', post: null };

  it('says how often the person revised it, and nothing while they did not', () => {
    assert.equal(revisedLine([]), null);
    assert.equal(revisedLine([version]), null);
    assert.equal(revisedLine([version, version]), 'Revised 1 time.');
    assert.equal(revisedLine([version, version, version]), 'Revised 2 times.');
  });

  it('takes a new text as a revision, and not an empty text or the question as it is', () => {
    assert.equal(isRevision('Faster?', 'Faster on ARM?'), true);
    assert.equal(isRevision('Faster?', ' Faster? '), false);
    assert.equal(isRevision('Faster?', '  '), false);
  });
});

describe('side threads', () => {
  const agents = [agentView('agent-1'), agentView('agent-2'), agentView('agent-3')];
  const work = summary({ thread: { id: 't-2', title: 'Baseline', opened_by: 'agent-1' } });
  const pair = summary({
    thread: { id: 't-5', title: 'Who owns the account?', opened_by: 'agent-2' },
    members: ['agent-2', 'agent-1'],
    posts: 1,
  });
  const three = summary({
    thread: { id: 't-6', title: 'Scoreboard', opened_by: 'agent-1' },
    members: ['agent-1', 'agent-3', 'agent-9'],
    posts: 4,
    disputed: 1,
    not_checked: 2,
    checked: 3,
    open_asks: 2,
    open_calls: 1,
  });

  it('are the threads that have members', () => {
    assert.deepEqual([work, pair, three].map(isSide), [false, true, true]);
  });

  it('read as one line each, in the order given: who talks, the title, and the count', () => {
    assert.deepEqual(sideLines([three, work, pair], agents), [
      // An agent that the lab does not list keeps its ID.
      {
        id: 't-6',
        who: 'Agent 1, Agent 3, and agent-9',
        title: 'Scoreboard',
        count: '4 posts',
        // The same marks that a card has, and none for what the thread does not have.
        marks: ['1 disputed', '2 not checked', '2 open asks', 'Needs an agent'],
      },
      {
        id: 't-5',
        who: 'Agent 2 and Agent 1',
        title: 'Who owns the account?',
        count: '1 post',
        marks: [],
      },
    ]);
  });

  it('have a heading that counts them, and a line that says who they are between', () => {
    assert.equal(sideHeading([pair]), '1 side thread between two agents.');
    assert.equal(sideHeading([pair, three, pair]), '3 side threads between two or three agents.');
    const five = { ...three, members: ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5'] };
    assert.equal(sideHeading([three]), '1 side thread between three agents.');
    assert.equal(sideHeading([pair, five]), '2 side threads between two to 5 agents.');
    assert.equal(
      betweenLine(pair.members, agents),
      'A side thread between Agent 2 and Agent 1. Every agent and you can read it.',
    );
  });

  it('say that a reply reaches the members, and that it does not open a lab that is done', () => {
    assert.equal(sideReplyHint(false), 'The members of this side thread get your reply.');
    assert.equal(
      sideReplyHint(true),
      'The members of this side thread get your reply. It does not open the lab again. For that, post in another thread.',
    );
  });
});

describe('an agent’s identity', () => {
  const maren = agentView('agent-1', {
    agent: { ...agentView('agent-1').agent, name: 'Maren' },
    seat: 'Claude Code · Opus 5.5',
    chosen_name: 'Maren',
    picture: { shape: 'hex', color: '#f08c3a', symbol: 'orbit' },
    about: 'I keep the question in view.',
  });
  const plain = agentView('agent-2', {
    agent: { ...agentView('agent-2').agent, name: 'Codex · gpt-6.1-sol 2' },
    seat: 'Codex · gpt-6.1-sol 2',
  });

  it('shows the seat beside a name only when the agent chose a name', () => {
    assert.equal(seatBeside(maren), 'Claude Code · Opus 5.5');
    assert.equal(seatBeside(plain), null);
  });

  it('draws the chosen picture, or else the seat’s number, and marks on call, left, and the two dots', () => {
    assert.deepEqual(pictureLook(maren), {
      picture: { shape: 'hex', color: '#f08c3a', symbol: 'orbit' },
      number: 1,
      hollow: false,
      gone: false,
      dot: null,
    });
    // An agent that chose nothing has the number at the end of its seat's label, or 1 without one.
    assert.deepEqual([pictureLook(plain).picture, pictureLook(plain).number], [null, 2]);
    assert.deepEqual(
      ['Codex · gpt-6.1-sol', 'Codex · gpt-6.1-sol 12', 'Own harness · model not reported', ''].map(
        (seat) => seatNumber(seat),
      ),
      [1, 12, 1, 1],
    );
    assert.equal(pictureLook({ ...maren, on_call: true }).hollow, true);
    const left = { at: '2026-11-06T14:00:00Z', by: 'person', reason: '' };
    assert.equal(pictureLook({ ...maren, left, need: 'left' }).gone, true);
    // The green dot comes from the live turn, and no status alone gives it.
    assert.deepEqual(
      (['approval', 'answer', 'working', 'waiting', 'idle', 'stopped', 'left'] as const).map(
        (need) => pictureLook({ ...maren, need }).dot,
      ),
      ['wait', 'wait', null, null, null, null, null],
    );
    assert.equal(pictureLook({ ...maren, need: 'working', in_turn: true }).dot, 'live');
    // An agent whose turn waits for the person's approval keeps the yellow dot, which comes first.
    assert.equal(pictureLook({ ...maren, need: 'approval', in_turn: true }).dot, 'wait');
  });

  it('puts the seat marks in one order, before the given role with who gave it and the agent’s own role', () => {
    const all = { ...maren, on_call: true, reviewer: true, coordinator: true };
    assert.deepEqual(seatMarks(all), ['Coordinator', 'Reviewer seat', 'On call']);
    assert.deepEqual(seatMarks(maren), []);
    assert.deepEqual(
      roles({ ...maren, given_role: 'Direction creator', given_by: 'person', role: 'Builder' }),
      ['Direction creator (given by you)', 'Builder'],
    );
    assert.deepEqual(roles({ ...maren, given_role: 'Scout', given_by: 'agent-3' }), [
      'Scout (given by the coordinator)',
    ]);
    // A role that the agent repeats shows once, as the given one.
    assert.deepEqual(roles({ ...maren, given_role: 'reads', given_by: 'person', role: 'reads' }), [
      'reads (given by you)',
    ]);
    assert.deepEqual(roles(maren), []);
  });

  it('says each change to a profile in plain words, with the text from before', () => {
    const at = '2026-11-06T14:00:00Z';
    const line = (
      by: string,
      part: 'name' | 'about' | 'picture' | 'role' | 'flag',
      before: string,
      after: string,
    ): string => editLine({ at, by, part, before, after });
    assert.equal(line('person', 'name', 'Overlord', ''), 'You took back the name “Overlord”.');
    assert.equal(
      line('agent-1', 'about', 'I win.', 'I test claims.'),
      'The coordinator rewrote the about line. Before: I win.',
    );
    assert.equal(
      line('person', 'about', 'I win.', ''),
      'You took back the about line. Before: I win.',
    );
    assert.equal(
      line('person', 'picture', 'hex, #f08c3a, orbit', ''),
      'You took back the picture.',
    );
    assert.deepEqual(
      pictureBefore({
        at,
        by: 'person',
        part: 'picture',
        before: 'hex, #f08c3a, orbit',
        after: '',
      }),
      { shape: 'hex', color: '#f08c3a', symbol: 'orbit' },
    );
    assert.equal(
      pictureBefore({ at, by: 'person', part: 'about', before: 'a, b, c', after: '' }),
      null,
    );
    assert.equal(line('person', 'role', '', 'driver'), 'You gave the role “driver”.');
    assert.equal(
      line('agent-1', 'role', 'driver', 'reader'),
      'The coordinator changed the given role from “driver” to “reader”.',
    );
    assert.equal(line('person', 'role', 'driver', ''), 'You took back the role “driver”.');
    assert.equal(
      line('agent-1', 'flag', '', 'The name claims a rank.'),
      'The coordinator flagged this profile: The name claims a rank.',
    );
    assert.equal(
      line('agent-1', 'flag', 'The name claims a rank.', ''),
      'The coordinator took back the flag. Before: The name claims a rank.',
    );
  });

  it('counts what became of an agent’s posts, with the posts, and no score', () => {
    const post = (id: string): { id: string; thread: string } => ({ id, thread: 't-2' });
    const lines = outcomeLines({
      built_on: [post('p-1'), post('p-4')],
      held: [post('p-1')],
      refuted: [],
      open_asks: [post('p-9')],
    });
    assert.deepEqual(
      lines.map((line) => [line.label, line.posts.map((one) => one.id)]),
      [
        ['Results built on', ['p-1', 'p-4']],
        ['Checked and held', ['p-1']],
        ['Refuted or ruled out', []],
        ['Open asks', ['p-9']],
      ],
    );
  });

  it('gives the person the calls that take back, give a role, and change a seat', async () => {
    const calls: unknown[] = [];
    const api = {
      changeSeat: (id: string, change: unknown) => {
        calls.push(['seat', id, change]);
        return Promise.resolve(labView());
      },
      changeProfile: (id: string, change: unknown) => {
        calls.push(['profile', id, change]);
        return Promise.resolve(labView());
      },
    };
    // Only what the agent chose can go back: a plain agent has nothing to take back.
    assert.deepEqual(takeBacks(plain), []);
    assert.deepEqual(
      takeBacks(maren).map((action) => action.label),
      ['Take back the name', 'Take back the about line', 'Take back the picture'],
    );
    for (const action of takeBacks(maren)) await action.run(api);
    assert.deepEqual(
      seatSwitches(maren).map((action) => action.label),
      ['Put on call', 'Make coordinator', 'Give a reviewer seat'],
    );
    const held = { ...maren, on_call: true, coordinator: true, reviewer: true };
    assert.deepEqual(
      seatSwitches(held).map((action) => action.label),
      ['Take off call', 'Remove as coordinator', 'Take back the reviewer seat'],
    );
    for (const action of [...seatSwitches(maren), ...seatSwitches(held)]) await action.run(api);
    // A role is one line of at most 40 characters, and the same role again is no change.
    assert.equal(giveRole(maren, '  '), null);
    assert.equal(giveRole(maren, 'x'.repeat(41)), null);
    assert.equal(giveRole({ ...maren, given_role: 'driver' }, 'driver'), null);
    assert.equal(takeBackRole(maren), null);
    const give = giveRole(maren, ' driver ');
    const change = giveRole({ ...maren, given_role: 'driver' }, 'reader');
    const back = takeBackRole({ ...maren, given_role: 'driver' });
    assert.deepEqual(
      [give?.label, change?.label, back?.label],
      ['Give the role', 'Change the role', 'Take back the role'],
    );
    await give?.run(api);
    await back?.run(api);
    assert.deepEqual(calls, [
      ['profile', 'agent-1', { reset_name: true }],
      ['profile', 'agent-1', { reset_about: true }],
      ['profile', 'agent-1', { reset_picture: true }],
      ['seat', 'agent-1', { on_call: true }],
      ['seat', 'agent-1', { coordinator: true }],
      ['seat', 'agent-1', { reviewer: true }],
      ['seat', 'agent-1', { on_call: false }],
      ['seat', 'agent-1', { coordinator: false }],
      ['seat', 'agent-1', { reviewer: false }],
      ['profile', 'agent-1', { role: 'driver' }],
      ['profile', 'agent-1', { role: '' }],
    ]);
  });
});

describe('one status', () => {
  const now = new Date('2026-11-06T14:30:00Z');
  const wait = (kind: 'approval' | 'answer', agent: string, what: string, since: string): Wait => ({
    kind,
    agent,
    what,
    since,
    post: `p-${agent}-${since}`,
    thread: 't-2',
  });

  it('groups the members by status in the order of who needs the person, and leaves out a blind rerun', () => {
    const checker = agentView('checker-7', { need: 'working', in_turn: true });
    const agents = [
      agentView('agent-1', { need: 'left' }),
      agentView('agent-2', { need: 'stopped' }),
      agentView('agent-3', { need: 'idle' }),
      agentView('agent-4', { need: 'waiting' }),
      agentView('agent-5', { need: 'working', in_turn: true }),
      agentView('agent-6', { need: 'answer' }),
      agentView('agent-7', { need: 'approval' }),
      agentView('agent-8', { need: 'working', in_turn: true }),
      { ...checker, agent: { ...checker.agent, checks: 'p-1' } },
    ];
    assert.deepEqual(
      needGroups(agents).map((group) => [group.heading, group.rows.map((view) => view.agent.id)]),
      [
        ['Needs your approval (1)', ['agent-7']],
        ['Needs your answer (1)', ['agent-6']],
        ['Working (2)', ['agent-5', 'agent-8']],
        ['Waiting on others (1)', ['agent-4']],
        ['Idle (1)', ['agent-3']],
        ['Stopped (1)', ['agent-2']],
        ['Left (1)', ['agent-1']],
      ],
    );
    assert.deepEqual(needGroups([]), []);
  });

  it('counts what waits for the person, and says nothing when nothing waits', () => {
    assert.equal(waitsLine(0), null);
    assert.equal(waitsLine(1), '1 thing waits for you');
    assert.equal(waitsLine(3), '3 things wait for you');
  });

  it('lists the approvals and then the answers, each with who asks and how long it has waited', () => {
    const checker = agentView('checker-12');
    const lab = labView({
      agents: [
        agentView('agent-1'),
        { ...checker, agent: { ...checker.agent, name: 'Checker 12', checks: 'p-1' } },
      ],
      waits: [
        wait('approval', 'agent-1', 'Asks to run a command', '2026-11-06T14:24:00Z'),
        wait('approval', 'checker-12', 'Asks to run a command', '2026-11-06T14:26:00Z'),
        wait('answer', 'agent-1', 'Which seed counts?', '2026-11-06T13:18:00Z'),
      ],
    });
    assert.deepEqual(
      waitGroups(lab, now).map((group) => [
        group.heading,
        group.word,
        group.rows.map((row) => [row.name, row.wait.what, row.waited]),
      ]),
      [
        [
          'Needs your approval (2)',
          'Decide',
          [
            ['Agent 1', 'Asks to run a command', '6 min'],
            // Two checkers can ask at once, so each keeps its own name.
            ['Checker 12', 'Asks to run a command', '4 min'],
          ],
        ],
        ['Needs your answer (1)', 'Answer', [['Agent 1', 'Which seed counts?', '1 h 12 min']]],
      ],
    );
    assert.deepEqual(waitGroups(labView(), now), []);
  });

  it('says in a member’s row what it does now and where it works', () => {
    const idle = { state: 'idle', detail: '', at: '2026-11-06T14:12:00Z' } as const;
    const working = { state: 'working', detail: 'Run pytest', at: '2026-11-06T14:27:00Z' } as const;
    const lab = labView({
      waits: [wait('approval', 'agent-1', 'Asks to run a command', '2026-11-06T14:26:00Z')],
    });
    assert.equal(
      whereLine(
        agentView('agent-2', { activity: working, need: 'working', in_turn: true }),
        lab,
        now,
        'Baseline',
      ),
      'Run pytest, 3 min. Works in “Baseline”.',
    );
    // A member that waits for the person says for what, and for how long.
    assert.equal(
      whereLine(agentView('agent-1', { need: 'approval' }), lab, now, null),
      'Waits for your approval, 4 min.',
    );
    // A line that ends with a full stop keeps one.
    const rested = agentView('agent-2', { activity: idle, turn_ended_at: idle.at });
    assert.equal(
      whereLine(rested, lab, now, 'Baseline'),
      'Its last turn ended 18 min ago, and no alarm is set. A post for it wakes it. Works in “Baseline”.',
    );
    // An on-call member in no turn says what wakes it, and a plain post does not.
    assert.equal(ON_CALL, 'On call. An ask or a call that names it wakes it.');
    assert.equal(whereLine({ ...rested, on_call: true }, lab, now, null), ON_CALL);
    assert.equal(
      whereLine(
        { ...rested, on_call: true, activity: working, need: 'working', in_turn: true },
        lab,
        now,
        null,
      ),
      'Run pytest, 3 min.',
    );
    // In a lab that is out of time, nothing wakes an agent, so the row names no alarm and no call.
    assert.equal(
      whereLine({ ...rested, on_call: true }, { ...lab, out_of_time: true }, now, null),
      'Idle, 18 min.',
    );
    const left = { at: '2026-11-06T14:00:00Z', by: 'person', reason: '' };
    assert.equal(
      whereLine({ ...rested, left, need: 'left' }, lab, now, 'Baseline'),
      'Left, removed by you.',
    );
  });

  it('counts the reviewer seats and the free ones, and says when the number follows the lab’s size', () => {
    const agents = [
      agentView('agent-1', { reviewer: true }),
      agentView('agent-2'),
      agentView('agent-3', {
        reviewer: true,
        left: { at: '2026-11-06T14:00:00Z', by: 'person', reason: '' },
      }),
    ];
    assert.equal(
      reviewerLine(labView({ agents, reviewer_seats: 2, reviewer_seats_set: 2 })),
      '2 reviewer seats, 1 free.',
    );
    assert.equal(
      reviewerLine(labView({ agents, reviewer_seats: 1 })),
      '1 reviewer seat, 0 free. The number follows the lab’s size.',
    );
    assert.equal(
      reviewerLine(labView({ reviewer_seats: 0, reviewer_seats_set: 0 })),
      'No reviewer seats.',
    );
  });
});

describe('a quiet lab', () => {
  const now = new Date('2026-11-06T14:30:00Z');
  const ended = '2026-11-06T14:12:00Z';
  const idle = { state: 'idle', detail: '', at: ended } as const;
  const rested = (id: string, changes: Partial<AgentView> = {}): AgentView =>
    agentView(id, { activity: idle, turn_ended_at: ended, ...changes });
  const rings = '2026-11-06T15:11:00Z';
  const waits: readonly Wait[] = [
    {
      kind: 'answer',
      agent: 'agent-1',
      what: 'Which seed?',
      since: ended,
      post: 'p-8',
      thread: 't-2',
    },
  ];
  const lab = labView({
    agents: [
      rested('agent-1', { alarm: { minutes: 60, quiet: false, rings_at: rings } }),
      rested('agent-2', {
        turn_ended_at: '2026-11-06T13:00:00Z',
        alarm: { minutes: 20, quiet: false, rings_at: '2026-11-06T15:40:00Z' },
      }),
      rested('agent-3'),
    ],
    waits,
    ends_at: '2026-11-06T15:04:00Z',
  });

  it('says for how long no agent has been in a turn, with what waits, the alarms, and the time left', () => {
    assert.deepEqual(quietBand(lab, now), {
      title: 'The lab is quiet',
      // The time counts from the newest end of a turn.
      text: 'No agent has been in a turn for 18 min. An agent starts a turn when a post is for it, or when its alarm rings.',
      waits: 1,
      alarms: 2,
      next: `The next rings at ${clock(rings)}`,
      left: '34 min',
    });
  });

  it('says that only a post starts a turn when no alarm is set, and names no limit that the lab does not have', () => {
    const none = labView({ agents: [rested('agent-1'), rested('agent-2')] });
    const band = quietBand(none, now);
    assert.deepEqual(
      [band?.waits, band?.alarms, band?.next, band?.left],
      [0, 0, 'Only a post starts a turn now', 'No limit'],
    );
    // Without a turn that ended, the band gives no duration.
    const fresh = quietBand(labView({ agents: [agentView('agent-1')] }), now);
    assert.equal(
      fresh?.text,
      'No agent is in a turn. An agent starts a turn when a post is for it, or when its alarm rings.',
    );
  });

  it('gives the rule of an alarm for a quiet board, which has no time of day', () => {
    const quiet = { minutes: 30, quiet: true, rings_at: rings };
    const only = labView({ agents: [rested('agent-1', { alarm: quiet })] });
    assert.equal(quietBand(only, now)?.next, 'The next rings after 30 min with no new post');
    const both = labView({
      agents: [
        rested('agent-1', { alarm: quiet }),
        rested('agent-2', { alarm: { minutes: 60, quiet: false, rings_at: rings } }),
      ],
    });
    assert.equal(
      quietBand(both, now)?.next,
      `One rings at ${clock(rings)}. One rings after 30 min with no new post.`,
    );
  });

  it('does not show while an agent or a blind rerun is in a turn, or while no member is in the lab', () => {
    const [first, ...rest] = lab.agents;
    assert.ok(first);
    assert.equal(
      quietBand({ ...lab, agents: [{ ...first, need: 'working', in_turn: true }, ...rest] }, now),
      null,
    );
    const checker = agentView('checker-7', { need: 'working', in_turn: true });
    const rerun = { ...checker, agent: { ...checker.agent, checks: 'p-1' } };
    assert.equal(quietBand({ ...lab, agents: [...lab.agents, rerun] }, now), null);
    assert.equal(quietBand(labView(), now), null);
    // An agent with an ask to the person and no turn leaves the lab quiet.
    assert.ok(quietBand({ ...lab, agents: [{ ...first, need: 'answer' }, ...rest] }, now));
    // An approval inside a turn that runs hides the band: the turn goes on when the person answers.
    const asking = {
      state: 'waiting',
      detail: 'Asks you: run pytest',
      at: null,
      waits_for: 'person',
    } as const;
    assert.equal(
      quietBand(
        {
          ...lab,
          agents: [{ ...first, need: 'approval', in_turn: true, activity: asking }, ...rest],
        },
        now,
      ),
      null,
    );
  });

  it('shows the band of a lab that is out of time, where every agent waits for more time', () => {
    const waiting = {
      state: 'waiting',
      detail: 'The lab is out of time. The person can give it more.',
      at: '2026-11-06T14:20:00Z',
      waits_for: 'time',
    } as const;
    const agents = lab.agents.map((view) => ({
      ...view,
      activity: waiting,
      need: 'idle' as const,
      in_turn: false,
      alarm: view.alarm ? { ...view.alarm, rings_at: null } : null,
    }));
    const stopped = { ...lab, agents, out_of_time: true };
    assert.deepEqual(turnLine(agents), { text: 'No agent in a turn, 3 in the lab', live: false });
    assert.equal(quietBand(stopped, now)?.title, 'The lab is out of time');
    const [one] = agents;
    assert.ok(one);
    assert.equal(pictureLook(one).dot, null);
    // The row says what the server says, with no time after it.
    assert.equal(
      whereLine(one, stopped, now, 'Baseline'),
      'The lab is out of time. The person can give it more. Works in “Baseline”.',
    );
    const process = {
      state: 'waiting',
      detail: 'Waits for a process that it left running.',
      at: '2026-11-06T14:20:00Z',
      waits_for: 'process',
    } as const;
    assert.equal(
      whereLine({ ...one, activity: process }, lab, now, null),
      'Waits for a process that it left running.',
    );
    assert.equal(
      stateLine({ ...process, detail: '' }, now).text,
      'Waits for a process that it left running.',
    );
    assert.equal(stateLine({ ...waiting, detail: '' }, now).text, 'The lab is out of time.');
    // A harness that waits for the person inside its turn keeps the time.
    assert.equal(
      stateLine({ ...waiting, detail: 'Asks you: run pytest', waits_for: 'person' }, now).text,
      'Asks you: run pytest, 10 min',
    );
  });

  it('says what the person can do in a lab that is out of time or done, where no alarm rings', () => {
    const held = lab.agents.map((view) =>
      view.alarm ? { ...view, alarm: { ...view.alarm, rings_at: null } } : view,
    );
    assert.deepEqual(quietBand({ ...lab, agents: held, out_of_time: true }, now), {
      title: 'The lab is out of time',
      text: 'No agent has been in a turn for 18 min. No agent starts a turn until you give the lab more time.',
      waits: 1,
      alarms: 2,
      next: 'No alarm rings while the lab is out of time',
      left: 'None',
    });
    assert.deepEqual(quietBand({ ...lab, agents: held, state: 'closed' }, now), {
      title: 'The lab is quiet',
      text: 'No agent has been in a turn for 18 min. The agents say that the lab is done. Your post to the lab opens it again.',
      waits: 1,
      alarms: 2,
      next: 'No alarm rings while the lab is done',
      left: '34 min',
    });
    const bare = labView({ agents: [rested('agent-1')] });
    assert.equal(quietBand({ ...bare, out_of_time: true }, now)?.next, 'No turn starts now');
    assert.equal(quietBand({ ...bare, state: 'closed' }, now)?.next, 'No alarm is set');
  });
});

describe('focus in the profile', () => {
  it('goes from the last control to the first with Tab, and back with Shift+Tab', () => {
    assert.equal(wrapFocus(4, 3, false), 0);
    assert.equal(wrapFocus(4, 0, true), 3);
    // Between the edges, the browser's own Tab stays inside.
    assert.equal(wrapFocus(4, 1, false), null);
    assert.equal(wrapFocus(4, 2, true), null);
    // Focus that got outside comes back in.
    assert.equal(wrapFocus(4, -1, false), 0);
    assert.equal(wrapFocus(4, -1, true), 3);
    assert.equal(wrapFocus(1, 0, false), 0);
    assert.equal(wrapFocus(0, -1, false), null);
  });
});
