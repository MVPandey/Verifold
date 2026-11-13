import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Post, PostView, ThreadSummary } from '../src/api/types.ts';

import {
  authorName,
  called,
  costLine,
  face,
  labTotal,
  members,
  ownName,
  stateLine,
  workingLine,
} from '../src/model/agents.ts';
import { duration, minutesBetween, money, tokens } from '../src/model/format.ts';
import { orderNeeds, pauses } from '../src/model/needs.ts';
import {
  builtOnLabel,
  isPermission,
  personAnswer,
  personMessage,
  split,
  standingChip,
  titleOf,
} from '../src/model/posts.ts';
import { href, parseRoute } from '../src/model/route.ts';
import { hasNew, markSeen, readSeen } from '../src/model/seen.ts';
import { AT_EXIT, labelOf, stopLine, valueAt } from '../src/model/settings.ts';
import {
  agentCount,
  defaultsLine,
  effortsOf,
  firstPicks,
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
  answerSoFar,
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
  });
});

describe('posts', () => {
  it('splits the first line into the headline and keeps the rest as the body', () => {
    assert.deepEqual(split('  Try sorted input.\n\nAlso reversed.  '), {
      headline: 'Try sorted input.',
      body: 'Also reversed.',
    });
    const long = split('x'.repeat(400));
    assert.equal(long.headline.length, 300);
    assert.equal(long.body, 'x'.repeat(400));
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
    });
    assert.deepEqual(personAnswer(asked, null, 'No, use pure Python.'), {
      kind: 'answer',
      thread: 't-2',
      reply_to: 'p-4',
      text: 'No, use pure Python.',
    });
    assert.equal(personAnswer(asked, null, ''), null);
  });

  it('names standings, and gives every result a chip', () => {
    assert.deepEqual(standingChip(result('p-1'), 'open'), { label: 'Not checked', tone: 'none' });
    assert.deepEqual(standingChip(result('p-1'), 'held_up'), { label: 'Held up', tone: 'hold' });
    assert.equal(standingChip({ ...result('p-1'), kind: 'message' }, 'open'), null);
    assert.equal(builtOnLabel([]), null);
    assert.equal(builtOnLabel(['p-4']), 'Built on by 1 post');
    assert.equal(builtOnLabel(['p-4', 'p-9']), 'Built on by 2 posts');
    assert.equal(isPermission(ask('p-1', 'agent-1')), true);
    assert.equal(isPermission(result('p-1')), false);
  });
});

describe('agents', () => {
  it('gives each member two letters and a color from its position, and a blind rerun neither', () => {
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
    assert.deepEqual(face(agents, 'agent-2'), {
      kind: 'member',
      initials: 'A2',
      color: 1,
      name: 'Agent 2',
    });
    assert.deepEqual(face(agents, 'checker-7'), {
      kind: 'rerun',
      initials: '',
      color: null,
      name: 'Blind rerun',
    });
    assert.deepEqual(face(agents, 'person'), {
      kind: 'person',
      initials: 'You',
      color: null,
      name: 'You',
    });
    const many = Array.from({ length: 10 }, (_, index) => agentView(`agent-${index + 1}`));
    assert.deepEqual(
      [face(many, 'agent-9').color, face(many, 'agent-10').initials, face(many, 'agent-10').color],
      [0, '10', 1],
    );
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

  it('counts the members and the blind reruns that work now', () => {
    const working = { state: 'working', detail: '', at: null } as const;
    const checker = agentView('checker-7', { activity: working });
    const rerun = { ...checker, agent: { ...checker.agent, checks: 'p-1' } };
    assert.equal(
      workingLine([agentView('agent-1', { activity: working }), agentView('agent-2')]),
      '1 of 2 members working',
    );
    assert.equal(
      workingLine([agentView('agent-1'), rerun]),
      '0 of 1 member working, 1 blind rerun',
    );
    assert.equal(workingLine([rerun, rerun]), '0 of 0 members working, 2 blind reruns');
  });

  it('says what an agent does and what it costs', () => {
    const now = new Date('2026-11-06T14:12:00Z');
    const working = { state: 'working', detail: 'Run pytest', at: '2026-11-06T14:10:00Z' } as const;
    assert.deepEqual(stateLine(working, now), { text: 'Run pytest, 2 min', dot: 'live' });
    assert.deepEqual(stateLine({ state: 'stopped', detail: '', at: null }, now), {
      text: 'Stopped',
      dot: 'stop',
    });
    const priced = agentView('agent-1', { turns: 4, cost_usd: 0.37 });
    const unpriced = agentView('agent-2', {
      turns: 3,
      usage: { input_tokens: 461_000, cached_input_tokens: 0, output_tokens: 2_000 },
    });
    assert.equal(costLine(priced), '$0.37 over 4 turns');
    assert.equal(costLine(unpriced), '461k tokens in, 2k out over 3 turns. No price.');
    assert.equal(costLine(agentView('agent-3')), 'No turns yet');
    assert.equal(labTotal([priced, unpriced]), '$0.37 and 463k tokens');
    assert.equal(labTotal([priced]), '$0.37');
  });
});

describe('turns', () => {
  const name = (id: string): string => (id === 'person' ? 'you' : id);
  const reply = (kind: object): Post => ({ ...result('p-9', { reply_to: 'p-1' }), ...kind });
  const target = result('p-1', { author: 'agent-2' });

  it('writes a turn as one line from the post and the post that it answers', () => {
    const context = { called: name, author: null, question: 't-1' };
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
      ],
      [
        'posted a result',
        'posted a result in reply to agent-2’s result',
        'proposed an answer in reply to agent-2’s result',
        'made a proposal',
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
      ],
    );
  });

  it('says "blind" only for the rerun of the checker that Verifold started for that post', () => {
    const rerun = reply({ kind: 'check', method: 'rerun', outcome: 'fails' });
    const checker = (checks: string): object => ({
      called: name,
      author: { ...agentView('checker-7').agent, checks },
      question: null,
    });
    const line = (context: object): string => act(rerun, target, context as ActContext);
    assert.equal(line(checker('p-1')), 'reran agent-2’s result blind: it fails');
    // A member reran it and saw the thread. A checker for another post is not blind to this one.
    assert.equal(
      line({ called: name, author: agentView('agent-3').agent, question: null }),
      'reran agent-2’s result: it fails',
    );
    assert.equal(line(checker('p-5')), 'reran agent-2’s result: it fails');
  });

  it('names a post that the page does not have as "a post"', () => {
    const context = { called: name, author: null, question: null };
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

  it('finds what a thread stands on, and the answer so far', () => {
    const proposal = (id: string): Post => result(id, { kind: 'proposal' });
    const posts = [
      postView(result('p-1'), 1, 'checked'),
      postView(proposal('p-2'), 2, 'disputed'),
      postView(proposal('p-3'), 3, 'conceded'),
      postView(result('p-4', { kind: 'message' }), 4),
    ];
    assert.equal(headClaim(posts)?.post.id, 'p-2');
    assert.equal(answerSoFar(posts)?.post.id, 'p-2');
    assert.equal(headClaim([postView(result('p-1'), 1, 'conceded')])?.post.id, 'p-1');
    assert.equal(answerSoFar([postView(proposal('p-1'), 1, 'conceded')]), null);
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
  });
});

describe('needs', () => {
  const waiting = { state: 'waiting', detail: '', at: null } as const;
  const needs = [
    postView({ ...ask('p-1', 'agent-1'), text: 'Which seed counts?' }),
    postView(ask('p-2', 'agent-2')),
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
    const picks = firstPicks(HARNESSES, DEFAULTS);
    assert.deepEqual(
      picks.map((pick) => pick.count),
      [1, 0],
    );
    assert.equal(agentCount(step(step(picks, 'claude-code', 30), 'codex', -1)), 20);
    // The limit is for the whole lab: a second harness gets only the room that the first leaves.
    const both = [
      { harness: 'claude-code', count: 15, model: '', effort: '', mode: '' },
      { harness: 'codex', count: 0, model: '', effort: '', mode: '' },
    ];
    assert.deepEqual(
      step(both, 'codex', 10).map((pick) => pick.count),
      [15, 5],
    );
    // Over the limit, a step down still works, and nothing goes below zero or grows.
    const over = [
      { harness: 'claude-code', count: 18, model: '', effort: '', mode: '' },
      { harness: 'codex', count: 5, model: '', effort: '', mode: '' },
    ];
    assert.deepEqual(
      step(over, 'codex', -1).map((pick) => pick.count),
      [18, 4],
    );
    assert.deepEqual(
      step(over, 'codex', 1).map((pick) => pick.count),
      [18, 5],
    );
    assert.deepEqual(
      step(step(over, 'codex', -5), 'codex', -1).map((pick) => pick.count),
      [18, 0],
    );
    const many = Array.from({ length: 25 }, (_, number) => ({
      ...HARNESSES[0],
      name: `h${String(number)}`,
    })) as typeof HARNESSES;
    assert.equal(agentCount(firstPicks(many, DEFAULTS)), 20);
  });

  it('sends only the choices that the person made', () => {
    const picks = [
      { harness: 'claude-code', count: 3, model: ' opus ', effort: '', mode: 'plan' },
      { harness: 'codex', count: 0, model: '', effort: 'low', mode: '' },
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

  it('names the choices with the names that the harness offered', () => {
    const pick = { harness: 'claude-code', count: 1, model: '', effort: '', mode: '' };
    assert.equal(modelSummary(pick, OFFER), 'Opus, High effort (your default)');
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
    const pick = { harness: 'claude-code', count: 1, model: '', effort: 'low', mode: '' };
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

describe('settings', () => {
  it('reads a setting by its key with dots, and finds nothing where a file has nothing', () => {
    const values = { jobs: { at_exit: 'keep' }, harnesses: ['odd'] };
    assert.equal(valueAt(values, 'jobs.at_exit'), 'keep');
    assert.equal(valueAt(values, 'jobs.at_time_limit'), undefined);
    assert.equal(valueAt(values, 'harnesses.0'), undefined);
    assert.equal(valueAt({}, 'jobs.at_exit'), undefined);
    assert.equal(labelOf(AT_EXIT, 'keep'), 'Keep them');
    assert.deepEqual(parseRoute('#/settings'), { page: 'settings' });
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
    assert.deepEqual(firstPicks(HARNESSES, saved), [
      { harness: 'claude-code', count: 2, model: 'opus', effort: '', mode: 'plan' },
      { harness: 'codex', count: 0, model: '', effort: 'low', mode: '' },
    ]);
    assert.deepEqual(
      firstPicks(HARNESSES, DEFAULTS).map((pick) => pick.count),
      [1, 0],
    );
  });

  it('come from the setup as the person left it, and read as words', () => {
    const picks = firstPicks(HARNESSES, saved);
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
