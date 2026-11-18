import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { NO_CANDIDATES } from '../src/api/client.ts';
import type { Api } from '../src/api/client.ts';
import type { DeskAction, DeskView, Post, PostView, ThreadView } from '../src/api/types.ts';
import { isDocked } from '../src/model/deliverables.ts';
import { seatMarks } from '../src/model/identity.ts';
import { NO_DESK, actionLine, actionsOn, byDesk, deskOf } from '../src/model/desk.ts';
import { newSeat, seatChoice, withSeat } from '../src/model/setup.ts';
import { ForYou } from '../src/ui/Coordinator.tsx';
import { DeskPanel, DeskSeat } from '../src/ui/Desk.tsx';
import type { PageProps } from '../src/ui/hooks.ts';
import { FactFields } from '../src/ui/SeatForm.tsx';
import { agentView, labView, postView, result } from './fixtures.ts';

const NOW = new Date('2026-11-06T14:30:00Z');
const DEE = agentView('agent-3', { desk: true });
const ADA = agentView('agent-1', { coordinator: true });
const AGENTS = [ADA, agentView('agent-2'), DEE];
const LAB = labView({ agents: AGENTS });
const LEFT = { at: '2026-11-06T14:00:00Z', by: 'person', reason: '' };
const CHAT = { id: 't-4', title: 'The person and the desk', opened_by: 'person', desk: true };

function said(id: string, author: string, text: string, changes: Partial<Post> = {}): PostView {
  return postView(result(id, { kind: 'message', thread: 't-4', author, text, ...changes }));
}

function action(kind: DeskAction['kind'], changes: Partial<DeskAction> = {}): DeskAction {
  return {
    on: 'p-5',
    at: '2026-11-06T14:20:00Z',
    kind,
    post: null,
    thread: null,
    agent: null,
    deliverable: null,
    change: null,
    ends_at: null,
    ...changes,
  };
}

function desk(posts: readonly PostView[], actions: readonly DeskAction[] = []): DeskView {
  const thread: ThreadView = { thread: CHAT, watching: false, members: [], posts };
  return { desk: 'agent-3', thread, actions };
}

function pageData(view: DeskView | null, agents = AGENTS): PageProps['data'] {
  return {
    setup: null,
    lab: labView({ agents }),
    threads: [],
    needs: [],
    report: null,
    candidates: NO_CANDIDATES,
    conversation: null,
    desk: view,
    version: 1,
    error: null,
    reload: () => undefined,
  };
}

describe('the desk', () => {
  it('finds the agent that holds the desk seat and marks its posts for the person', () => {
    assert.equal(deskOf(AGENTS)?.agent.id, 'agent-3');
    assert.equal(deskOf([ADA]), null);
    assert.equal(deskOf([{ ...DEE, left: LEFT }]), null);
    assert.equal(byDesk(result('p-6', { author: 'agent-3', for_person: true, on: 'p-5' })), true);
    assert.equal(byDesk(result('p-6', { author: 'agent-1', for_person: true })), false);
    const marked = renderToStaticMarkup(<ForYou marked agents={AGENTS} author="agent-3" desk />);
    const coordinator = renderToStaticMarkup(<ForYou marked agents={AGENTS} author="agent-1" />);
    assert.equal(marked, '<span class="k-for">the desk, for you</span>');
    assert.deepEqual(seatMarks(DEE), ['Desk']);
    assert.equal(coordinator, '<span class="k-for">posted for you by Agent 1</span>');
  });

  it('says each action in one line of the app, with IDs and names and no text of an agent', () => {
    const lines = [
      action('post', { thread: 't-1', post: 'p-6' }),
      action('round', { thread: 't-1', post: 'p-7' }),
      action('question'),
      action('deliverable', { deliverable: 'd-2', change: 'added' }),
      action('deliverable', { deliverable: 'd-2', change: 'changed' }),
      action('deliverable', { deliverable: 'd-2', change: 'removed' }),
      action('interrupt', { agent: 'agent-2' }),
    ].map((item) => actionLine(item, AGENTS));

    assert.deepEqual(lines, [
      'Posted for you in t-1',
      'Opened a round for you in t-1',
      'Revised the question for you',
      'Stated the deliverable d-2 for you',
      'Changed the sentence of the deliverable d-2 for you',
      'Removed the deliverable d-2 for you',
      'Ended the turn of Agent 2, so it reads its news now',
    ]);
    assert.ok(
      actionLine(action('time', { ends_at: NOW.toISOString() }), AGENTS).startsWith(
        'Set the lab to end at ',
      ),
    );
    assert.deepEqual(
      actionsOn(desk([], [action('question'), action('time', { on: 'p-8' })]), 'p-5').map(
        (item) => item.kind,
      ),
      ['question'],
    );
  });

  it('shows the desk chat as rows with each action under the message that it rests on', () => {
    const view = desk(
      [
        said('p-5', 'person', 'Where does it stand? Tell ada to look at the tail.'),
        said('p-6', 'agent-3', 'Two lines are alive. I told ada.'),
      ],
      [action('post', { thread: 't-1', post: 'p-7' }), action('interrupt', { agent: 'agent-1' })],
    );
    const html = renderToStaticMarkup(
      <DeskPanel
        api={{} as Api}
        view={view}
        holder={DEE}
        lab={LAB}
        now={NOW}
        onClose={() => undefined}
        reload={() => undefined}
      />,
    );

    assert.ok(html.includes('<aside class="k-panel" aria-label="Agent 3, the desk">'));
    assert.ok(html.includes('<span class="i-seat coord">Desk</span>'));
    assert.ok(html.includes('Only you and the desk post here, and no other agent hears it.'));
    const person = html.indexOf('Where does it stand?');
    const posted = html.indexOf('Posted for you in t-1');
    const ended = html.indexOf('Ended the turn of Agent 1, so it reads its news now');
    const answer = html.indexOf('Two lines are alive.');
    assert.ok(person > 0 && person < posted && posted < ended && ended < answer);
    assert.ok(html.includes('<a href="#/thread/t-1/p-7">See it</a>'));
    assert.ok(html.includes('Your message wakes Agent 3 at once.'));
    assert.ok(html.includes('placeholder="Ask Agent 3, or tell it what to do"'));
  });

  it('offers the desk chat above the conversation when the lab has a desk, and nothing without one', () => {
    const closed = renderToStaticMarkup(
      <DeskSeat
        api={{} as Api}
        data={pageData(NO_DESK)}
        now={NOW}
        open={false}
        onOpen={() => undefined}
      />,
    );
    const open = renderToStaticMarkup(
      <DeskSeat
        api={{} as Api}
        data={pageData(desk([said('p-5', 'person', 'Status?')]))}
        now={NOW}
        open
        onOpen={() => undefined}
      />,
    );
    const none = renderToStaticMarkup(
      <DeskSeat
        api={{} as Api}
        data={pageData(null, [ADA])}
        now={NOW}
        open
        onOpen={() => undefined}
      />,
    );

    assert.ok(closed.includes('aria-expanded="false">Talk to Agent 3</button>'));
    assert.equal(closed.includes('k-panel'), false);
    assert.ok(open.includes('aria-expanded="true">Close the desk chat</button>'));
    assert.ok(open.includes('Status?'));
    assert.equal(none, '');
    // The page docks one panel at a time, and the desk chat only while the lab has a desk.
    assert.equal(isDocked('desk', true, true), true);
    assert.equal(isDocked('desk', true, false), false);
    assert.equal(isDocked('talk', true, true), true);
  });

  it('lets one seat be the desk, with one agent and no other seat, and offers it only to a seat that Verifold starts', () => {
    const codex = newSeat('codex', 2);
    const claude = newSeat('claude-code');
    const desked = withSeat([codex, claude], 0, { ...codex, desk: true, coordinator: true });
    const moved = withSeat(desked, 1, { ...claude, desk: true });
    const coordinator = withSeat(moved, 1, { ...claude, desk: true, coordinator: true });

    assert.deepEqual(
      desked.map((seat) => [seat.count, seat.desk, seat.coordinator]),
      [
        [1, true, false],
        [1, false, false],
      ],
    );
    assert.deepEqual(
      moved.map((seat) => seat.desk),
      [false, true],
    );
    assert.deepEqual(
      coordinator.map((seat) => [seat.desk, seat.coordinator]),
      [
        [false, false],
        [false, true],
      ],
    );
    assert.deepEqual(seatChoice({ ...claude, desk: true }), {
      harness: 'claude-code',
      count: 1,
      desk: true,
    });
    assert.equal('desk' in seatChoice(newSeat('codex')), false);
    const facts = { role: '', family: '', onCall: false, coordinator: false };
    const started = renderToStaticMarkup(
      <FactFields value={facts} family="openai" onChange={() => undefined} desk />,
    );
    const invited = renderToStaticMarkup(
      <FactFields value={facts} family="unknown" onChange={() => undefined} />,
    );
    assert.ok(
      started.includes(
        'Desk. It answers you in the desk chat and acts on your word. A lab has one.',
      ),
    );
    assert.equal(invited.includes('Desk.'), false);
  });
});
