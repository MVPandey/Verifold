import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Agent, Call, Direction, Lab, Post } from '../src/protocol/api.ts';
import { Avatar, PostAuthor } from '../src/app/components/Avatar.tsx';
import { BoardThread } from '../src/app/components/BoardThread.tsx';
import { DirectionRow } from '../src/app/components/DirectionRow.tsx';
import { NeedsYouLine } from '../src/app/components/NeedsYouLine.tsx';
import { optionLines } from '../src/app/call.ts';
import {
  agentDetail,
  asked,
  authorHead,
  authorOf,
  avatarText,
} from '../src/app/format.ts';
import { changesOf, podAsker, podsAtOnceChoices } from '../src/app/pods.ts';
import { noSettingWords, undoWords } from '../src/ui/call-words.ts';
import { agentName, roleName, roleOf } from '../src/ui/lab-lines.ts';

const now = Date.UTC(2026, 10, 1, 12, 0);
const at = new Date(now - 60_000).toISOString();

function agent(handle: string, more: Partial<Agent> = {}): Agent {
  return {
    id: 'a-3',
    handle,
    harness: 'codex',
    model: null,
    direction: 'd-3',
    check: null,
    status: 'idle',
    until: null,
    live: { state: 'idle', text: 'Between turns', since: at },
    turns: { turns: [], more: false },
    spendUsd: null,
    ...more,
  };
}

const direction: Direction = {
  id: 'd-3',
  title: 'Topic controls',
  job: 'Controls',
  team: 'Evidence',
  bar: null,
  runs: null,
  noise: null,
  buildsOn: [],
  state: 'open',
  verdict: 'open',
  disputed: false,
  evidence: null,
  agent: 'a-3',
  openedBy: 'a-1',
  openedAt: at,
  stoppedAt: null,
  head: 'a'.repeat(40),
};

function post(more: Partial<Post>): Post {
  return {
    id: 'p-1',
    at,
    author: 'a-3',
    handle: 'agent-3',
    job: 'Controls',
    harness: 'codex',
    kind: 'claim',
    direction: 'd-3',
    text: 'It holds.',
    replyTo: null,
    mentions: [],
    proof: [],
    ...more,
  };
}

await test('one parser reads a role handle, and coordinator is a role with no number', () => {
  assert.deepEqual(roleOf('agent-3'), { word: 'Agent', number: '3' });
  assert.deepEqual(roleOf('checker-12'), { word: 'Checker', number: '12' });
  assert.deepEqual(roleOf('coordinator'), {
    word: 'Coordinator',
    number: null,
  });
  for (const word of ['claude-2', 'codex-1', 'agent-0', 'agent', 'You'])
    assert.equal(roleOf(word), null, word);
  assert.equal(avatarText({ harness: 'codex', handle: 'coordinator' }), 'Cx');
  assert.equal(
    agentDetail({ handle: 'coordinator', harness: 'claude' }),
    'Claude Code',
  );
});

await test('a role handle reads as a name, and an old handle stays', () => {
  assert.equal(roleName('agent-3'), 'Agent 3');
  assert.equal(roleName('checker-12'), 'Checker 12');
  assert.equal(roleName('coordinator'), 'Coordinator');
  assert.equal(roleName('claude-2'), 'claude-2');
  assert.equal(roleName('You'), 'You');
  assert.equal(agentName('agent-3', 'Controls'), 'Agent 3 · Controls');
  assert.equal(agentName('agent-3', null), 'Agent 3');
  assert.equal(agentName('agent-3', undefined), 'Agent 3');
  assert.equal(agentName('claude-2', null), 'claude-2');
});

await test('the avatar shows the agent number, and an old handle its harness', () => {
  assert.equal(avatarText({ harness: 'codex', handle: 'agent-14' }), '14');
  assert.equal(avatarText({ harness: 'claude', handle: 'checker-2' }), '2');
  assert.equal(avatarText({ harness: 'claude', handle: 'claude-2' }), 'Cl');
  assert.equal(avatarText({ harness: 'codex', handle: 'Codex' }), 'Cx');
  const html = renderToStaticMarkup(
    <Avatar who={{ harness: 'codex', handle: 'agent-3' }} size="md" labelled />,
  );
  assert.match(html, /avatar--codex/);
  assert.match(html, /aria-label="Codex, Agent 3"/);
  assert.match(html, />3<\/span>/);
});

await test('a post shows its author with the job and the harness in words', () => {
  assert.equal(authorOf(post({})), 'Agent 3 · Controls');
  assert.deepEqual(authorHead(post({})), {
    name: 'Agent 3',
    detail: 'Controls · Codex',
  });
  assert.deepEqual(authorHead(post({ job: null, harness: 'claude' })), {
    name: 'Agent 3',
    detail: 'Claude Code',
  });
  const html = renderToStaticMarkup(<PostAuthor post={post({})} />);
  assert.match(html, /<b>Agent 3<\/b>/);
  assert.match(html, /<span class="post__job">Controls · Codex<\/span>/);
});

await test('an old lab shows its old handle, with no job and no harness label', () => {
  const old = post({ handle: 'claude-2', harness: 'claude', job: null });
  assert.equal(authorOf(old), 'claude-2');
  assert.deepEqual(authorHead(old), { name: 'claude-2', detail: null });
  assert.equal(
    agentDetail({ handle: 'claude-2', harness: 'claude', job: null }),
    null,
  );
  // An old handle names its harness already, so it keeps only its job.
  assert.equal(
    agentDetail({ handle: 'claude-2', harness: 'claude', job: 'Controls' }),
    'Controls',
  );
  const row = renderToStaticMarkup(
    <DirectionRow
      direction={{ ...direction, job: null, team: null }}
      agent={agent('claude-2', { harness: 'claude' })}
      now={now}
    />,
  );
  assert.doesNotMatch(row, /row__who/);
  assert.match(row, /aria-label="Claude, claude-2"/);
  assert.match(row, />Cl<\/span>/);
  assert.equal(authorOf(post({ author: 'person', handle: null })), 'You');
  assert.equal(
    authorOf(post({ author: 'verifold', handle: null })),
    'Verifold',
  );
});

await test('a direction row names its agent, its job, and its harness', () => {
  const row = renderToStaticMarkup(
    <DirectionRow
      direction={direction}
      agent={agent('agent-3', { job: 'Controls' })}
      now={now}
    />,
  );
  assert.match(
    row,
    /<span class="row__who">Agent 3 · Controls · Codex<\/span>/,
  );
});

const call: Call = {
  id: 'c-1',
  at,
  kind: 'cost',
  question: 'Raise pods at once?',
  why: 'Runs wait.',
  askers: [
    {
      agent: 'a-3',
      handle: 'agent-3',
      job: 'Controls',
      direction: 'd-3',
      why: 'Runs wait.',
    },
  ],
  byVerifold: false,
  options: [
    {
      label: 'Raise it',
      usd: 1,
      minutes: null,
      effect: { type: 'podsAtOnce', pods: 2 },
    },
    {
      label: 'Leave it',
      usd: 0,
      minutes: null,
      effect: null,
      noSetting: true,
    },
  ],
  pick: 0,
  undoMinutes: 10,
  wordsLimit: 2000,
  applying: false,
  state: 'open',
  answer: null,
  words: null,
  undoUntil: null,
  note: null,
  post: null,
};

function lab(more: Partial<Lab> = {}): Lab {
  return {
    directions: [direction],
    agents: [agent('agent-3', { job: 'Controls' })],
    ...more,
  } as Lab;
}

await test('needs you says who asked by name', () => {
  assert.equal(asked(call.askers), 'Agent 3 · Controls asked');
  assert.equal(
    asked([
      { ...call.askers[0], agent: 'a-1', handle: 'claude-2', job: null },
      { ...call.askers[0], agent: 'a-2', handle: 'codex-1', job: null },
    ] as Call['askers']),
    'claude-2 and codex-1 asked',
  );
  const html = renderToStaticMarkup(
    <NeedsYouLine call={call} more={0} now={now} />,
  );
  assert.match(html, /Agent 3 · Controls asked · waiting 1 min/);
});

await test('the plan card names who wrote it, not a planner', () => {
  const plan = post({
    id: 'p-2',
    kind: 'plan',
    handle: 'agent-1',
    job: 'Second pattern',
    harness: 'claude',
  });
  const shown = lab({
    plan: {
      post: 'p-2',
      at,
      reading: 'How I read it.',
      cost: 'Nothing yet.',
      directions: ['d-3'],
      facts: [],
    },
    board: { posts: [plan], more: false },
  });
  const html = renderToStaticMarkup(
    <BoardThread thread={{ root: plan, replies: [] }} lab={shown} />,
  );
  assert.match(html, /<b>Agent 1<\/b>/);
  assert.match(html, /Second pattern · Claude Code/);
  assert.doesNotMatch(html, /Planner/);
});

await test('the call card says what each option does before the person answers', () => {
  const lines = optionLines(call.options[0] as Call['options'][0], call, lab());
  assert.equal(
    lines?.does,
    "Sets pods at once to 2 in the project's settings.",
  );
  assert.equal(
    lines?.undo,
    'Undo restores the earlier limit. A running pod does not stop.',
  );
  assert.equal(
    optionLines(call.options[1] as Call['options'][0], call, lab()),
    null,
  );
  assert.match(noSettingWords, /changes no setting/);
  assert.match(undoWords(10, null), /undo it for 10 minutes/);
});

await test('the control of pods at once offers each value up to the limit', () => {
  assert.deepEqual(podsAtOnceChoices, ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.deepEqual(changesOf({ maxRunningPods: '5' }, null), {
    maxRunningPods: 5,
  });
});

await test('a pod names the agent that asked by its role', () => {
  const shown = podAsker(
    { asker: 'agent', directions: ['d-3'] } as unknown as Parameters<
      typeof podAsker
    >[0],
    lab(),
  );
  assert.equal(shown, 'Agent 3');
});
