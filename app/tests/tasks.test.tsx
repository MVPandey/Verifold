import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { NO_CANDIDATES } from '../src/api/client.ts';
import type { Api } from '../src/api/client.ts';
import type { PostView, TaskCard, ThreadView } from '../src/api/types.ts';
import { cardTasks, onItLine, partsOf, workOf } from '../src/model/tasks.ts';
import { act, repliesLabel } from '../src/model/turns.ts';
import { LabPage } from '../src/ui/LabPage.tsx';
import { Turns } from '../src/ui/Thread.tsx';
import {
  DEFAULTS,
  FINDINGS,
  HARNESSES,
  agentView,
  labView,
  postView,
  result,
  summary,
} from './fixtures.ts';

const now = new Date('2026-11-06T14:26:00Z');
const agents = [agentView('agent-1'), agentView('agent-2')];

function work(changes: Partial<TaskCard>): TaskCard {
  return {
    task: 'p-4',
    author: 'agent-2',
    text: 'Rerun the tail test on the 2025 data.',
    state: 'open',
    agent: null,
    until: null,
    ...changes,
  };
}

const task = result('p-4', {
  kind: 'task',
  author: 'agent-2',
  text: 'Rerun the tail test on the 2025 data.',
  output: 'One table with the five runs.',
  bounds: 'The 2025 data only.',
});

const handBack = result('p-5', {
  kind: 'hand_back',
  author: 'agent-1',
  reply_to: 'p-4',
  text: 'Ran all five.',
  findings: 'The tail holds in four.',
  concerns: '',
  deviations: 'Used 19 minutes.',
});

describe('a piece of work', () => {
  it('says who is on it and for how long, in the person’s words', () => {
    const line = (changes: Partial<TaskCard>): string => onItLine(work(changes), agents, now);

    assert.equal(
      line({ state: 'claimed', agent: 'agent-1', until: '2026-11-06T14:38:00Z' }),
      'Agent 1 is on this, 12 min left',
    );
    assert.equal(
      line({ state: 'claimed', agent: 'agent-1', until: '2026-11-06T14:26:40Z' }),
      'Agent 1 is on this, less than a minute left',
    );
    assert.equal(
      line({ state: 'claimed', agent: 'agent-1', until: '2026-11-06T16:31:00Z' }),
      'Agent 1 is on this, 2 h 5 min left',
    );
    assert.equal(line({}), 'Nobody has taken this yet');
    assert.equal(line({ state: 'handed_back', agent: 'agent-1' }), 'Agent 1 handed this back');
    assert.equal(line({ state: 'done' }), 'Done');
    assert.equal(line({ state: 'withdrawn' }), 'Withdrawn');
  });

  it('reads a task’s post with its holder, or with the agent whose work came back', () => {
    const held: PostView = {
      ...postView(task),
      task: {
        state: 'claimed',
        held_by: { agent: 'agent-1', since: '2026-11-06T14:20:00Z', until: '2026-11-06T14:50:00Z' },
      },
    };
    const back: PostView = { ...postView(task), task: { state: 'handed_back', hand_back: 'p-5' } };

    assert.deepEqual(workOf(held, [held]), {
      state: 'claimed',
      agent: 'agent-1',
      until: '2026-11-06T14:50:00Z',
    });
    assert.deepEqual(workOf(back, [back, postView(handBack, 2)]), {
      state: 'handed_back',
      agent: 'agent-1',
      until: null,
    });
    // A view from before tasks has no state, and an open task has none either.
    assert.deepEqual(workOf(postView(task), []), { state: 'open', agent: null, until: null });
    assert.equal(workOf(postView(handBack), []), null);
  });

  it('shows the parts of its brief and of the work that came back, and leaves an empty part out', () => {
    assert.deepEqual(partsOf(task), [
      ['Wanted', 'One table with the five runs.'],
      ['Within', 'The 2025 data only.'],
    ]);
    assert.deepEqual(partsOf(handBack), [
      ['Found', 'The tail holds in four.'],
      ['Differs from the ask', 'Used 19 minutes.'],
    ]);
    assert.deepEqual(partsOf(result('p-1')), []);
    const called = (id: string): string => (id === 'agent-2' ? 'Agent 2' : 'Agent 1');
    assert.equal(act(task, null, { called, author: null }), 'handed out a piece of work');
    assert.equal(
      act(handBack, task, { called, author: null }),
      'handed back Agent 2’s piece of work',
    );
    assert.equal(
      repliesLabel([postView(handBack), postView(task)]),
      '2 replies: 1 piece of work, 1 piece of work handed back',
    );
  });

  it('lists a few pieces of work on a closed card and every one on the opened thread', () => {
    const many = ['p-4', 'p-5', 'p-6', 'p-7'].map((id) => work({ task: id }));

    assert.deepEqual(cardTasks(many, false), { shown: many.slice(0, 3), more: 1 });
    assert.deepEqual(cardTasks(many, true), { shown: many, more: 0 });
  });
});

describe('the wall', () => {
  it('says on a card who is on each piece of work and for how long, and which one nobody has taken', () => {
    Object.assign(globalThis, { window: { localStorage: { getItem: () => '{}' } } });
    const long = 'Rerun the tail test on the 2025 data with every filter that the lab tried. '
      .repeat(4)
      .trim();
    const lab = labView({ agents });
    const threads = [
      summary({
        thread: { id: 't-3', title: 'Merge sort', opened_by: 'agent-2' },
        tasks: [
          work({ text: long, state: 'claimed', agent: 'agent-1', until: '2026-11-06T14:38:00Z' }),
          work({ task: 'p-5', text: 'Chart the runs.' }),
          work({ task: 'p-6', text: 'Check the loader.', state: 'handed_back', agent: 'agent-1' }),
          work({ task: 'p-7', text: 'Read the paper.' }),
        ],
      }),
    ];
    const data = {
      setup: {
        folder: '~/code/sort-bench',
        harnesses: HARNESSES,
        question: lab.question,
        defaults: DEFAULTS,
        defaults_from: null,
        findings_deliverable: FINDINGS,
      },
      lab,
      threads,
      needs: [],
      report: null,
      candidates: NO_CANDIDATES,
      version: 1,
      error: null,
      reload: () => undefined,
    };

    const html = renderToStaticMarkup(
      <LabPage api={{} as Api} data={data} now={now} open={null} post={null} />,
    );

    assert.ok(html.includes('<ul class="f-work" aria-label="Pieces of work">'));
    assert.ok(
      html.includes(
        `<li class="fw-claimed"><span class="f-work-text">${long}</span>` +
          '<span class="f-work-on">Agent 1 is on this, 12 min left</span></li>',
      ),
    );
    assert.ok(html.includes('<span class="f-work-on">Nobody has taken this yet</span>'));
    assert.ok(html.includes('<span class="f-work-on">Agent 1 handed this back</span>'));
    // A closed card lists three pieces of work and counts the others.
    assert.equal(html.includes('Read the paper.'), false);
    assert.ok(html.includes('<li class="f-work-more">1 more piece of work</li>'));
    // A thread without pieces of work has no list.
    const plain = renderToStaticMarkup(
      <LabPage
        api={{} as Api}
        data={{ ...data, threads: [summary()] }}
        now={now}
        open={null}
        post={null}
      />,
    );
    assert.equal(plain.includes('f-work'), false);
  });

  it('shows a task’s post with its parts and who is on it, and the work that came back with its parts', () => {
    const held: PostView = {
      ...postView(task),
      task: {
        state: 'claimed',
        held_by: { agent: 'agent-1', since: '2026-11-06T14:20:00Z', until: '2026-11-06T14:50:00Z' },
      },
    };
    const view: ThreadView = {
      thread: { id: 't-1', title: 'A', opened_by: 'agent-2' },
      watching: false,
      members: [],
      posts: [held, postView(handBack, 2)],
    };

    const html = renderToStaticMarkup(
      <Turns
        view={view}
        agents={agents}
        needs={[]}
        question={null}
        reruns={[]}
        seats={0}
        now={now}
        onRerun={() => Promise.resolve()}
        onSend={() => Promise.resolve()}
      />,
    );

    assert.ok(html.includes('handed out a piece of work'));
    assert.ok(
      html.includes(
        '<dl class="f-parts"><div><dt>Wanted</dt><dd>One table with the five runs.</dd></div>' +
          '<div><dt>Within</dt><dd>The 2025 data only.</dd></div></dl>',
      ),
    );
    assert.ok(html.includes('<p class="f-work-on">Agent 1 is on this, 24 min left</p>'));
    assert.ok(html.includes('<div><dt>Found</dt><dd>The tail holds in four.</dd></div>'));
    assert.equal(html.includes('<dt>Concerns</dt>'), false);
  });
});
