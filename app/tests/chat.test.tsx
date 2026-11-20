import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { NO_CANDIDATES, createApi } from '../src/api/client.ts';
import type { Api } from '../src/api/client.ts';
import type {
  ConversationView,
  DeskView,
  MoveView,
  PostView,
  ThreadView,
} from '../src/api/types.ts';
import { grantLine, kindLine, moveWords, sameKind } from '../src/model/moves.ts';
import type { ThreadRead } from '../src/ui/hooks.ts';
import { Wall } from '../src/ui/LabPage.tsx';
import { MovesCard, SpareSeatsForm } from '../src/ui/Moves.tsx';
import { HARNESSES, agentView, labView, postView, result, summary } from './fixtures.ts';

const NOW = new Date('2026-11-06T14:30:00Z');
const MAREN = agentView('agent-1', { coordinator: true });
const TESSEL = agentView('agent-2');
const DEE = agentView('agent-3', { desk: true });
const LONG = 'A title of a thread that runs long, about the tail of the cache under every load';

function move(post: PostView, changes: Partial<MoveView> = {}): MoveView {
  return {
    post,
    kind: 'round',
    at: '2026-11-06T14:17:00Z',
    by: 'agent-1',
    why: 'You set an 8-hour target.',
    agent: null,
    yes_by: null,
    ...changes,
  };
}

const ROUND = postView(
  result('p-4', { kind: 'round', minutes: 15, text: 'What can settle by 9:16 a.m.?' } as never),
);
const PAUSE = postView(
  result('p-5', {
    kind: 'request',
    thread: 't-9',
    move: { type: 'pause', agent: 'agent-2', until: '2026-11-06T16:30:00Z', why: 'No release.' },
  } as never),
);
const ADD = postView(
  result('p-6', {
    kind: 'request',
    thread: 't-9',
    move: {
      type: 'add_agent',
      seat: { harness: 'codex', model: null, effort: null, on_call: false, role: '', fresh: true },
    },
  } as never),
);
const MOVES = [
  move(ADD, {
    kind: 'add_agent',
    agent: 'agent-2',
    why: 'Every line looks alike.',
    yes_by: 'agent-1',
  }),
  move(PAUSE, {
    kind: 'pause',
    agent: 'agent-2',
    why: 'No release before then.',
    yes_by: 'person',
  }),
  move(ROUND),
  move(postView(result('p-7', { kind: 'reading', text: 'Progress is the verified value.' })), {
    kind: 'reading',
    why: 'You corrected the goal.',
  }),
];

describe('the coordinator’s moves in words', () => {
  it('says what each move did in the app’s words, with the agent’s text and the why apart', () => {
    const agents = [MAREN, TESSEL];
    assert.deepEqual(moveWords(MOVES[0] as MoveView, agents), {
      what: 'Added a seat with a fresh view',
      seat: 'Agent 2',
      theirs: '',
      why: 'Every line looks alike.',
    });
    assert.equal(moveWords(MOVES[1] as MoveView, agents).what.endsWith(', with your yes'), true);
    assert.ok(moveWords(MOVES[1] as MoveView, agents).what.startsWith('Paused a seat until'));
    assert.deepEqual(moveWords(MOVES[2] as MoveView, agents), {
      what: 'Opened a 15-minute round',
      seat: null,
      theirs: 'What can settle by 9:16 a.m.?',
      why: 'You set an 8-hour target.',
    });
    assert.equal(moveWords(MOVES[3] as MoveView, agents).what, 'Posted a new reading');
    // A number said with a vowel sound first takes `an`.
    const opened = (minutes: number): string =>
      moveWords(
        move(postView(result('p-9', { kind: 'round', minutes, text: 'Which line?' } as never))),
        agents,
      ).what;
    assert.deepEqual([8, 11, 5, 1].map(opened), [
      'Opened an 8-minute round',
      'Opened an 11-minute round',
      'Opened a 5-minute round',
      'Opened a 1-minute round',
    ]);
    const cap = postView(
      result('p-8', {
        kind: 'request',
        move: { type: 'cap', agent: null, tokens_per_hour: 5000000, why: 'Spend slower.' },
      } as never),
    );
    assert.equal(
      moveWords(move(cap, { kind: 'cap' }), agents).what,
      'Limited the lab to 5M tokens an hour',
    );
  });

  it('says what the grant of spare seats leaves, and names each kind with the harness’s own names', () => {
    assert.equal(
      grantLine(null, 'Maren'),
      'Maren adds no agent by itself. Each add waits for your yes.',
    );
    assert.equal(
      grantLine({ left: 1, of: 2, kinds: [] }, 'Maren'),
      'Maren may add 1 seat more by itself, of 2 that you granted.',
    );
    assert.equal(
      grantLine({ left: 0, of: 1, kinds: [] }, 'Maren'),
      'Maren used the 1 seat that you granted.',
    );
    const kind = { harness: 'claude-code', model: 'opus', effort: null, mode: 'plan' };
    assert.equal(
      kindLine(kind, HARNESSES),
      'Claude Code · model Opus · effort default · mode Plan',
    );
    assert.equal(sameKind(kind, { ...kind }), true);
    assert.equal(sameKind(kind, { ...kind, mode: null }), false);
  });

  it('lists the newest three moves beside the chat, and the way to all of them', () => {
    const html = renderToStaticMarkup(
      <MovesCard moves={MOVES} agents={[MAREN, TESSEL]} seated onAll={() => undefined} />,
    );
    const empty = renderToStaticMarkup(
      <MovesCard moves={[]} agents={[MAREN]} seated onAll={() => undefined} />,
    );
    const nobody = renderToStaticMarkup(
      <MovesCard moves={[]} agents={[TESSEL]} seated={false} onAll={() => undefined} />,
    );

    assert.ok(html.includes('The coordinator’s moves</h2>'));
    assert.equal(html.split('<li>').length - 1, 3);
    assert.ok(
      html.indexOf('Added a seat with a fresh view') < html.indexOf('Opened a 15-minute round'),
    );
    // Each move is one line, and its words and its why open under it.
    assert.equal(html.split('<li><details><summary>').length - 1, 3);
    const line = html.slice(html.indexOf('<summary>'), html.indexOf('</summary>'));
    assert.equal(line.includes('Why:'), false);
    assert.ok(html.includes('<p class="m-theirs">What can settle by 9:16 a.m.?</p>'));
    assert.ok(html.includes('Why: <span class="m-text">You set an 8-hour target.</span>'));
    assert.ok(html.includes('See all 4 moves</button>'));
    assert.equal(html.includes('Posted a new reading'), false);
    assert.ok(empty.includes('No move yet. Each move shows here with its one line of why.'));
    assert.equal(nobody, '');
    // A move that an agent objects to says so.
    const disputed = renderToStaticMarkup(
      <MovesCard
        moves={[{ ...(MOVES[2] as MoveView), post: { ...ROUND, standing: 'disputed' } }]}
        agents={[MAREN]}
        seated
        onAll={() => undefined}
      />,
    );
    assert.ok(disputed.includes('<span class="m-mark">An agent objects</span>'));
  });

  it('grants spare seats from the panel: the line of the grant, its kinds, and the way to take it back', () => {
    const view: ConversationView = {
      coordinator: 'agent-1',
      thread: null,
      waits: [],
      no_reply: [],
      asks: [],
      powers: [],
      deeds: [],
      moves: [],
      grant: {
        left: 1,
        of: 2,
        kinds: [{ harness: 'claude-code', model: 'opus', effort: 'high', mode: null }],
      },
    };
    const html = renderToStaticMarkup(
      <SpareSeatsForm
        api={{} as Api}
        view={view}
        harnesses={HARNESSES}
        name="Maren"
        reload={() => undefined}
      />,
    );

    assert.ok(html.includes('Maren may add 1 seat more by itself, of 2 that you granted.'));
    assert.ok(html.includes('Claude Code · model Opus · effort High · mode default'));
    assert.ok(html.includes('Take the grant back</button>'));
    assert.ok(html.includes('Grant 2 seats</button>'));
    assert.ok(html.includes('Only you remove an agent.'));
  });

  it('sends a grant to the server', async () => {
    const calls: [string, string | undefined][] = [];
    const api = createApi('secret', (input, init) => {
      calls.push([input, typeof init.body === 'string' ? init.body : undefined]);
      return Promise.resolve(new Response('{"powers": []}', { status: 200 }));
    });
    const choices = [{ harness: 'codex', model: null, effort: null, mode: null }];
    await api.grantSeats({ seats: 2, choices });

    assert.deepEqual(calls, [['/api/grant', JSON.stringify({ seats: 2, choices })]]);
  });
});

describe('one chat with the lab', () => {
  const work = summary({ thread: { id: 't-2', title: LONG, opened_by: 'agent-1' } });
  const question = summary({ thread: { id: 't-1', title: 'The question', opened_by: 'person' } });
  const card: ThreadView = {
    thread: work.thread,
    watching: false,
    members: [],
    posts: [postView(result('p-2', { thread: 't-2', text: 'The tail holds.' }))],
  };
  const read: ThreadRead = { view: card, error: null };
  const none: ThreadRead = { view: null, error: null };
  const chat: DeskView = {
    desk: 'agent-3',
    thread: {
      thread: { id: 't-9', title: 'Desk', opened_by: 'person', desk: true },
      watching: false,
      members: [],
      posts: [],
    },
    actions: [],
  };
  const reading = postView(
    result('p-3', { kind: 'reading', text: 'Progress is the verified value.' }),
  );
  const conversation: ConversationView = {
    coordinator: 'agent-1',
    thread: null,
    waits: [],
    no_reply: [],
    asks: [],
    powers: [],
    deeds: [],
    moves: MOVES,
    grant: null,
  };
  const wall = (agents: (typeof MAREN)[], desk: DeskView | null, open: string | null): string => {
    Object.assign(globalThis, { window: { localStorage: { getItem: () => '{}' } } });
    return renderToStaticMarkup(
      <Wall
        api={{} as Api}
        data={{
          setup: null,
          lab: labView({ agents }),
          threads: [question, work],
          needs: [],
          report: null,
          reading,
          candidates: NO_CANDIDATES,
          conversation,
          desk,
          version: 1,
          error: null,
          reload: () => undefined,
        }}
        now={NOW}
        open={open}
        post={null}
        questionRead={none}
        cardRead={open ? read : none}
      />,
    );
  };

  it('with a desk, is the desk chat alone: no box that steers, no box in a thread, and no reply to the reading', () => {
    const html = wall([MAREN, TESSEL, DEE], chat, 't-2');

    assert.ok(html.includes('Chat with the lab</h2>'));
    assert.ok(html.includes(`<span>About this thread:</span> <b class="c-title">${LONG}</b>`));
    assert.equal(html.includes('Steer the lab'), false);
    assert.equal(html.includes('Say something in this thread'), false);
    assert.ok(html.includes('Write about this thread</button>'));
    assert.equal(html.includes('Reply to the reading'), false);
    assert.ok(html.includes('To correct the reading, say so in the chat with the lab.'));
    // The coordinator's conversation is no second chat: its seat opens the moves.
    assert.ok(html.includes('Agent 1’s moves and powers</button>'));
    assert.ok(html.includes('The coordinator’s moves</h2>'));
    // The person still votes on a post in the thread.
    assert.ok(html.includes('aria-label="Vote up'));
  });

  it('with no desk, is the conversation with the coordinator, beside the box that steers the lab', () => {
    const html = wall([MAREN, TESSEL], null, 't-2');

    assert.equal(html.includes('Chat with the lab'), false);
    assert.ok(html.includes('Steer the lab'));
    assert.ok(html.includes('Say something in this thread'));
    assert.ok(html.includes('Reply to the reading'));
    assert.ok(html.includes('Talk to Agent 1</button>'));
  });
});
