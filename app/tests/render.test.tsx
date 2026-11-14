import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Api } from '../src/api/client.ts';
import type {
  AnswerView,
  HarnessOption,
  Post,
  SettingsView,
  ThreadView,
} from '../src/api/types.ts';
import type { ThreadRead } from '../src/ui/hooks.ts';
import { LabPage, Wall } from '../src/ui/LabPage.tsx';
import { Markdown } from '../src/ui/Markdown.tsx';
import { SettingsForm } from '../src/ui/SettingsPage.tsx';
import { SetupPage } from '../src/ui/SetupPage.tsx';
import { Turns } from '../src/ui/Thread.tsx';
import { Top } from '../src/ui/Top.tsx';
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

const HOSTILE =
  '<img src="https://evil.example/x.png" onerror="alert(1)"> ![x](https://evil.example/y.png)';

describe('agent text', () => {
  it('reaches the page as text, so it cannot load an image or run a script', () => {
    const post = result('p-1', {
      text: HOSTILE,
      body: `First paragraph ${HOSTILE}\n\nSecond paragraph`,
      evidence: [{ type: 'file', path: 'bench<b>.py', commit: '9a41d07'.padEnd(40, '0') }],
    });
    const thread: ThreadView = {
      thread: { id: 't-1', title: 'A', opened_by: 'agent-1' },
      watching: false,
      posts: [postView(post)],
    };

    const html = renderToStaticMarkup(
      <Turns
        view={thread}
        agents={[agentView('agent-1')]}
        harnesses={HARNESSES}
        needs={[]}
        question={null}
        onRerun={() => Promise.resolve()}
        onSend={() => Promise.resolve()}
      />,
    );

    assert.equal(html.includes('<img'), false);
    assert.ok(html.includes('bench&lt;b&gt;.py'));
    assert.ok(html.includes('&lt;img src=&quot;https://evil.example/x.png&quot;'));
    assert.ok(html.includes('<p>Second paragraph</p>'));
    assert.ok(html.includes('Not checked'));
    assert.ok(html.includes('9a41d07'));
  });
});

describe('an opened thread', () => {
  const checker = agentView('checker-9');
  const agents = [
    agentView('agent-1'),
    agentView('agent-2'),
    {
      ...checker,
      agent: {
        ...checker.agent,
        checks: 'p-1',
        model: { family: 'openai', name: null, effort: null },
      },
    },
  ];
  const asked = { ...ask('p-6', 'agent-2', ['Allow once', 'Reject']), thread: 't-1' };
  const posts = [
    postView(
      result('p-1', { evidence: [{ type: 'file', path: 'bench.py', commit: 'a'.repeat(40) }] }),
      1,
      'disputed',
      ['p-5', 'p-70'],
    ),
    postView(result('p-2', { kind: 'objection', author: 'agent-2', reply_to: 'p-1' }), 2),
    postView({ ...result('p-3', { reply_to: 'p-2' }), kind: 'answer', accepts: true }, 3),
    postView(
      {
        ...result('p-4', { author: 'checker-9', reply_to: 'p-1' }),
        kind: 'check',
        method: 'rerun',
        outcome: 'fails',
      },
      4,
    ),
    postView(result('p-5', { author: 'agent-2', builds_on: ['p-1', 'p-60'] }), 5, 'held_up'),
    postView(asked, 6),
  ];
  const html = renderToStaticMarkup(
    <Turns
      view={{ thread: { id: 't-1', title: 'A', opened_by: 'agent-1' }, watching: false, posts }}
      agents={agents}
      harnesses={HARNESSES}
      needs={[postView(asked, 6)]}
      question={null}
      onRerun={() => Promise.resolve()}
      onSend={() => Promise.resolve()}
    />,
  );

  it('gives each turn its act in one line, its mark, and its place under what it answers', () => {
    assert.ok(html.includes('posted a result'));
    assert.ok(html.includes('objected to Agent 1’s result'));
    assert.ok(html.includes('accepted Agent 2’s objection'));
    assert.ok(html.includes('reran Agent 1’s result blind: it fails'));
    assert.ok(html.includes('<li id="p-2" class="f-turn d1">'));
    assert.ok(html.includes('<li id="p-3" class="f-turn d2">'));
    assert.ok(html.includes('class="f-mark fm-bad"'));
    assert.ok(html.includes('leads this thread'));
    assert.ok(html.includes('visiting'));
    assert.ok(html.includes('outside checker, other model family'));
    assert.ok(html.includes('Blind rerun'));
    assert.ok(html.includes('Claude Code'));
  });

  it('keeps what the person can do in a thread', () => {
    assert.ok(html.includes('<span class="f-st fs-dis">Disputed</span>'));
    assert.ok(html.includes('<span class="f-st fs-hold">Held up</span>'));
    // A result with files that is not Held up can get a blind rerun. The Held up one has no files.
    assert.equal(html.split('Ask for a blind rerun').length - 1, 1);
    assert.ok(html.includes('bench.py <code>aaaaaaa</code>'));
    assert.ok(html.includes('Choices: Allow once · Reject'));
    assert.ok(html.includes('<a href="#/needs">Answer it on the Needs you page</a>'));
    assert.ok(html.includes('aria-label="Message to everyone in this thread"'));
    assert.ok(html.includes('>Post</button>'));
  });

  it('links a post to the posts that it builds on and that build on it', () => {
    assert.ok(
      html.includes(
        '<a class="f-port" href="#/thread/t-1/p-1">After an idea from <b>Agent 1</b></a>',
      ),
    );
    assert.ok(html.includes('<span class="f-port">Builds on p-60 in another thread</span>'));
    assert.ok(
      html.includes('<a class="f-port" href="#/thread/t-1/p-5">Built on by <b>Agent 2</b></a>'),
    );
    assert.ok(html.includes('<span class="f-port">Built on by 1 post</span>'));
  });

  it('folds a run of status notes in the question’s thread into one row', () => {
    const note = (id: string): Post => result(id, { kind: 'message', author: 'agent-1' });
    const folded = renderToStaticMarkup(
      <Turns
        view={{
          thread: { id: 't-1', title: 'The question', opened_by: 'person' },
          watching: false,
          posts: [postView(note('p-1')), postView(note('p-2'))],
        }}
        agents={agents}
        harnesses={HARNESSES}
        needs={[]}
        question="t-1"
        onRerun={() => Promise.resolve()}
        onSend={() => Promise.resolve()}
      />,
    );
    assert.ok(folded.includes('<summary>2 short notes</summary>'));
    assert.equal(folded.includes('leads this thread'), false);
  });
});

describe('the lab page', () => {
  const working = { state: 'working', detail: 'Run pytest', at: null } as const;
  const lab = labView({
    agents: [
      agentView('agent-1', { activity: working, turns: 2, cost_usd: 0.5 }),
      agentView('agent-2'),
    ],
    ends_at: '2026-11-06T15:00:00Z',
  });
  const threads = [
    summary({ thread: { id: 't-3', title: 'Merge sort', opened_by: 'agent-2' }, disputed: 1 }),
    summary({ thread: { id: 't-2', title: 'Sorted input', opened_by: 'agent-1' }, checked: 1 }),
    summary({ thread: { id: 't-1', title: 'The question', opened_by: 'person' } }),
  ];
  const needs = [postView({ ...ask('p-8', 'agent-2'), text: 'Which seed counts?' })];
  const setup = {
    folder: '~/code/sort-bench',
    harnesses: HARNESSES,
    question: lab.question,
    defaults: DEFAULTS,
    defaults_from: null,
  };
  const now = new Date('2026-11-06T14:26:00Z');
  const data = {
    setup,
    lab,
    threads,
    needs,
    report: null,
    answer: null,
    version: 1,
    error: null,
    reload: () => undefined,
  };
  const page = (seen: string): string => {
    // The page reads what the person has seen from the browser's storage.
    Object.assign(globalThis, { window: { localStorage: { getItem: () => seen } } });
    return renderToStaticMarkup(
      <LabPage api={{} as Api} data={data} now={now} open={null} post={null} />,
    );
  };

  it('shows the seat and one closed card for each thread but the question’s', () => {
    const html = page('{}');
    assert.ok(html.includes('<h1>Is sorted() faster?</h1>'));
    assert.ok(html.includes('<a class="f-label" href="#/thread/t-1" aria-expanded="false">'));
    assert.ok(html.includes('Steer the lab'));
    assert.ok(html.includes('<a class="f-need" href="#/needs"><b>Agent 2 needs you</b>'));
    assert.ok(html.includes('Which seed counts?'));
    // The cards come in the order that the threads opened, and none repeats the question's thread.
    assert.ok(html.indexOf('Sorted input') < html.indexOf('Merge sort'));
    assert.equal(html.includes('id="card-t-1"'), false);
    assert.ok(html.includes('<section id="card-t-3" class="f-card c-bad">'));
    assert.ok(html.includes('<a href="#/thread/t-2" aria-expanded="false">Sorted input</a>'));
    assert.ok(html.includes('<span class="f-st fs-count-good">Checked</span>'));
    assert.ok(html.includes('<span class="f-st fs-count-bad">1 disputed</span>'));
    assert.equal(html.split('<span class="f-new">New</span>').length - 1, 3);
    assert.ok(html.includes('role="img" aria-label="Agent 2"'));
    // A closed card never shows a post's text.
    assert.equal(html.includes('Reran it.'), false);
  });

  it('shows the newest report above the cards, with its detail folded and a link to its thread', () => {
    Object.assign(globalThis, { window: { localStorage: { getItem: () => '{}' } } });
    const report = postView(
      {
        ...result('p-30', { author: 'agent-2', thread: 't-3' }),
        kind: 'report',
        text: 'Merge sort is ahead on random input.',
        body: 'Three runs agree.',
      },
      30,
      'disputed',
    );
    const html = renderToStaticMarkup(
      <LabPage api={{} as Api} data={{ ...data, report }} now={now} open={null} post={null} />,
    );
    assert.equal(page('{}').includes('Where the lab is'), false);
    assert.ok(html.includes('<section class="f-report" aria-labelledby="report-title">'));
    assert.ok(html.includes('<h2 id="report-title">Where the lab is</h2>'));
    // The fixture's posts are from 14:04, and the page's clock says 14:26.
    assert.ok(html.includes('Agent 2 reported <time dateTime="2026-11-06T14:04:00Z" title='));
    assert.ok(html.includes('>22 min ago</time>'));
    // An agent objected to the report, so the card does not show it as plain fact.
    assert.ok(html.includes('Disputed'));
    assert.ok(html.includes('<p class="f-report-text">Merge sort is ahead on random input.</p>'));
    assert.ok(html.includes('<a href="#/thread/t-3/p-30">See it in its thread</a>'));
    assert.ok(html.includes('<details class="f-detail">'));
    assert.ok(html.includes('Three runs agree.'));
    assert.ok(html.indexOf('f-report') < html.indexOf('f-wall'));
  });

  it('names on each card the threads that it builds on and that build on it', () => {
    Object.assign(globalThis, { window: { localStorage: { getItem: () => '{}' } } });
    const linked = [
      summary({
        thread: { id: 't-3', title: 'Merge sort', opened_by: 'agent-2' },
        builds_on_threads: [{ thread: 't-2', agents: ['agent-1'], count: 2 }],
        crossed: 2,
      }),
      summary({
        thread: { id: 't-2', title: 'Sorted input', opened_by: 'agent-1' },
        built_on_by_threads: [{ thread: 't-3', agents: ['agent-2'], count: 2 }],
      }),
    ];
    const html = renderToStaticMarkup(
      <LabPage
        api={{} as Api}
        data={{ ...data, threads: linked }}
        now={now}
        open={null}
        post={null}
      />,
    );
    assert.ok(html.includes('2 posts build on another agent’s work in another thread.'));
    assert.ok(
      html.includes(
        '<b>Builds on</b><span><a href="#/thread/t-2">Sorted input</a> (Agent 1)</span>',
      ),
    );
    assert.ok(
      html.includes(
        '<b>Built on by</b><span><a href="#/thread/t-3">Merge sort</a> (Agent 2)</span>',
      ),
    );
    assert.equal(page('{}').includes('f-cross'), false);
  });

  it('shows a closed card’s team, and says when a thread has work that no agent has taken', () => {
    Object.assign(globalThis, { window: { localStorage: { getItem: () => '{}' } } });
    const staffed = [
      summary({
        thread: { id: 't-3', title: 'Merge sort', opened_by: 'agent-2' },
        team: ['agent-2', 'agent-1'],
        open_calls: 1,
      }),
    ];
    const html = renderToStaticMarkup(
      <LabPage
        api={{} as Api}
        data={{ ...data, threads: staffed }}
        now={now}
        open={null}
        post={null}
      />,
    );
    assert.ok(html.includes('<span class="f-st fs-ask">Needs an agent</span>'));
    assert.ok(html.includes('<div class="f-faces" role="group" aria-label="The team">'));
    // Both members show at full strength: nobody in a team is a faint face.
    const faces = html.slice(html.indexOf('aria-label="The team"'));
    assert.ok(faces.includes('aria-label="Agent 2"') && faces.includes('aria-label="Agent 1"'));
    assert.equal(faces.slice(0, faces.indexOf('<time')).includes('ghost'), false);
  });

  it('shows when each thread was last active, and names a checker that asks by its own name', () => {
    const checker = agentView('checker-12');
    const asking = { ...checker, agent: { ...checker.agent, name: 'Checker 12', checks: 'p-1' } };
    Object.assign(globalThis, { window: { localStorage: { getItem: () => '{}' } } });
    const html = renderToStaticMarkup(
      <LabPage
        api={{} as Api}
        data={{
          ...data,
          lab: { ...lab, agents: [...lab.agents, asking] },
          needs: [postView(ask('p-9', 'checker-12'))],
        }}
        now={now}
        open={null}
        post={null}
      />,
    );
    assert.ok(html.includes('<b>Checker 12 asks for permission</b>'));
    assert.equal(html.split('<time dateTime="2026-11-06T14:09:00Z"').length - 1, 2);
  });

  const none: ThreadRead = { view: null, error: null };
  const wall = (
    open: string,
    questionRead: ThreadRead,
    cardRead: ThreadRead,
    answer: AnswerView | null = null,
  ): string => {
    Object.assign(globalThis, { window: { localStorage: { getItem: () => '{}' } } });
    return renderToStaticMarkup(
      <Wall
        api={{} as Api}
        data={{ ...data, answer }}
        now={now}
        open={open}
        post={null}
        questionRead={questionRead}
        cardRead={cardRead}
      />,
    );
  };
  const thread = (id: string, opener: string, posts: readonly Post[]): ThreadRead => ({
    view: {
      thread: { id, title: id, opened_by: opener },
      watching: false,
      posts: posts.map((post, index) => postView({ ...post, thread: id }, index + 1)),
    },
    error: null,
  });

  it('opens a card in place, with who opened it and the standing of what it stands on', () => {
    const posts = [
      result('p-1', { kind: 'proposal' }),
      // A ruled-out lead is newer, and the thread still stands on the proposal.
      result('p-2', { kind: 'ruled_out', text: 'Dead end.' }),
    ];
    const html = wall('t-2', none, thread('t-2', 'agent-1', posts));
    assert.ok(html.includes('<section id="card-t-2" class="f-card c-good open">'));
    assert.ok(html.includes('<a href="#/" aria-expanded="true">Sorted input</a>'));
    assert.ok(html.includes('<p class="f-by">Agent 1 opened it</p>'));
    assert.ok(html.includes('<p class="f-head">sorted() is 12x faster</p>'));
    // The proposal has no check, so the header says so. The summary's "Checked" is not beside the headline.
    assert.ok(
      html.includes(
        '<div class="f-card-st"><span class="f-st fs-none">Not checked</span></div><p class="f-head">',
      ),
    );
    assert.equal(html.includes('<span class="f-st fs-count-good">Checked</span>'), false);
    assert.ok(html.includes('made a proposal'));
    assert.ok(html.includes('<li id="p-2" class="f-turn claim d0">'));
    // The other card stays closed, and the open one drops its mark for new posts.
    assert.ok(html.includes('<section id="card-t-3" class="f-card c-bad">'));
    assert.equal(html.split('<span class="f-new">New</span>').length - 1, 2);
  });

  it('says who opened a thread that the person opened, and waits for an open card’s posts', () => {
    const mine = summary({ thread: { id: 't-4', title: 'Try numpy', opened_by: 'person' } });
    Object.assign(globalThis, { window: { localStorage: { getItem: () => '{}' } } });
    const html = renderToStaticMarkup(
      <Wall
        api={{} as Api}
        data={{ ...data, threads: [...threads, mine] }}
        now={now}
        open="t-4"
        post={null}
        questionRead={none}
        cardRead={thread('t-4', 'person', [])}
      />,
    );
    assert.ok(html.includes('<p class="f-by">You opened it</p>'));
    // With no result or proposal to stand on, the open card keeps the summary's status.
    assert.ok(html.includes('<span class="f-st fs-count-none">No result yet</span>'));
    const loading = wall('t-3', none, none);
    assert.ok(loading.includes('<p class="f-by">Agent 2 opened it</p>'));
    assert.ok(loading.includes('<p class="f-wait" role="status">Loading the thread.</p>'));
    const failed = wall('t-3', none, { view: null, error: 'No connection.' });
    assert.ok(failed.includes('<p class="f-wait" role="status">No connection.</p>'));
  });

  it('says so when the link names a thread that the lab does not have', () => {
    const html = wall('t-9', none, none);
    assert.ok(html.includes('<p class="f-wait" role="alert">This lab has no thread t-9.</p>'));
    assert.equal(html.includes('f-card c-good open'), false);
    assert.equal(html.includes('Loading the thread.'), false);
  });

  it('opens the question’s thread under the seat, with the answer so far in full', () => {
    const posts = [
      result('p-1', { kind: 'message', author: 'person', text: 'Is sorted() faster?' }),
      result('p-2', { kind: 'proposal', text: 'Yes, 12x.' }),
    ];
    const html = wall('t-1', thread('t-1', 'person', posts), none);
    assert.ok(html.includes('<a class="f-label" href="#/" aria-expanded="true">'));
    assert.ok(html.includes('<div class="f-answer on">'));
    assert.ok(html.includes('<p>Yes, 12x.</p>'));
    assert.ok(html.includes('<span class="f-st fs-none">Not checked</span>'));
    assert.ok(
      html.includes(
        '<section id="card-t-1" class="f-card open f-answer-thread" aria-label="The question">',
      ),
    );
    assert.ok(html.includes('proposed an answer'));
    assert.ok(html.includes('aria-label="Message to everyone in this thread"'));
    // Closed, the seat clamps the answer.
    assert.ok(
      wall('t-2', thread('t-1', 'person', posts), none).includes('<p class="clamp">Yes, 12x.</p>'),
    );
  });

  it('links the answer’s files, and says which results under it have no blind rerun', () => {
    const file = { type: 'file' as const, path: 'answer.md', commit: 'c'.repeat(40) };
    const proposal = result('p-2', { kind: 'proposal', text: 'Yes, 12x.', evidence: [file] });
    const posts = [result('p-1', { kind: 'message', author: 'person', text: 'Faster?' }), proposal];
    const answer: AnswerView = {
      answer: postView({ ...proposal, thread: 't-1' }, 2),
      builds_on: [
        postView(
          result('p-7', { thread: 't-2', text: 'Rerun blind.', evidence: [file] }),
          7,
          'held_up',
        ),
        postView(result('p-8', { thread: 't-2', text: 'Not rerun.', evidence: [file] }), 8),
        postView(result('p-9', { thread: 't-2', text: 'A reading.' }), 9),
      ],
      results: 2,
      no_blind_rerun: ['p-8'],
    };
    const closed = wall('t-2', thread('t-1', 'person', posts), none, answer);
    assert.ok(closed.includes('href="#/file/p-2/answer.md"'));
    assert.ok(closed.includes('Builds on 3 posts. 1 of 2 results with files has no blind rerun.'));
    assert.ok(!closed.includes('Not rerun.'));
    const open = wall('t-1', thread('t-1', 'person', posts), none, answer);
    assert.ok(
      open.includes(
        '<a href="#/thread/t-2/p-8">Not rerun.</a><span class="dim"> · no blind rerun</span>',
      ),
    );
    // Nothing under the answer can be rerun, so the page says nothing about reruns.
    const reading = {
      ...answer,
      builds_on: answer.builds_on.slice(2),
      results: 0,
      no_blind_rerun: [],
    };
    const plain = wall('t-2', thread('t-1', 'person', posts), none, reading);
    assert.ok(plain.includes('Builds on 1 post.') && !plain.includes('blind rerun'));
    // An answer from before the newest proposal says nothing about this one.
    const stale = { ...answer, answer: postView({ ...proposal, id: 'p-1' }, 1) };
    assert.ok(!wall('t-1', thread('t-1', 'person', posts), none, stale).includes('Builds on'));
  });

  it('shows a Markdown file as a page of text, with no image, HTML, or script link', () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={[
          '# The answer',
          '',
          'No use **today**. See [the paper](https://arxiv.org/abs/2408.08292) and `answer_v3.md`.',
          '',
          '1. First',
          '   - under it',
          '2. Second',
          '',
          'Results:',
          '',
          '| Method | Score |',
          '| --- | --- |',
          '| DQI | 0.51 |',
          '',
          '<b>raw</b> [bad](javascript:alert(1)) ![pic](https://x.test/a.png)',
        ].join('\n')}
      />,
    );
    assert.ok(html.includes('<h1>The answer</h1>'));
    assert.ok(html.includes('<strong>today</strong>'));
    assert.ok(
      html.includes(
        '<a href="https://arxiv.org/abs/2408.08292" target="_blank" rel="noreferrer noopener">the paper</a>',
      ),
    );
    assert.ok(html.includes('<code>answer_v3.md</code>'));
    assert.match(
      html,
      /<ol>\s*<li>First\s*<ul>\s*<li>under it<\/li>\s*<\/ul>\s*<\/li>\s*<li>Second<\/li>/,
    );
    assert.ok(html.includes('<div class="md-table"><table>'));
    assert.ok(html.includes('<td>DQI</td>'));
    // HTML in the file is not markup, a link that is no web page keeps only its words, and so does an image.
    assert.ok(html.includes('<span>bad</span> <span>pic</span>'));
    assert.ok(!html.includes('<b>') && !html.includes('<img') && !html.includes('javascript:'));
  });

  it('reads a file with very long odd lines in well under two seconds', () => {
    const long = (mark: string): string => mark.repeat(20_000);
    const started = Date.now();
    renderToStaticMarkup(<Markdown text={`# a${long(' ')}b\n${long('[')}\n|${long(' ')}x`} />);
    assert.ok(Date.now() - started < 2_000);
  });

  it('marks only the threads with posts that the person has not seen', () => {
    const html = page('{"t-1": 7, "t-2": 7}');
    assert.equal(html.split('<span class="f-new">New</span>').length - 1, 1);
  });

  it('keeps the members, their state and cost, the lab total, and the time in the top bar', () => {
    const html = renderToStaticMarkup(
      <Top
        folder="~/code/sort-bench"
        route={{ page: 'lab' }}
        open={{
          lab,
          harnesses: HARNESSES,
          needs: 1,
          now,
          api: {} as Api,
          onChange: () => undefined,
        }}
      />,
    );
    assert.ok(html.includes('sort-bench'));
    assert.ok(html.includes('1 of 2 members working'));
    assert.ok(html.includes('Run pytest'));
    assert.ok(html.includes('$0.50 over 2 turns'));
    assert.ok(html.includes('3 posts in 1 thread'));
    assert.ok(html.includes('Lab total <b>$0.50</b>'));
    assert.ok(html.includes('26 min of 1 h'));
    assert.ok(html.includes('30 more min'));
    assert.ok(html.includes('Stop the lab'));
    assert.ok(html.includes('<a href="#/needs">Needs you<span class="count">1</span></a>'));
    assert.ok(html.includes('<a href="#/settings">Settings</a>'));
    assert.ok(html.includes('<a href="#/" aria-current="page">Lab</a>'));
  });
});

describe('the setup screen', () => {
  it('offers one agent of each harness that this computer has', () => {
    const api = {} as Api;
    const html = renderToStaticMarkup(
      <SetupPage
        api={api}
        setup={{
          folder: '~/code/sort-bench',
          harnesses: HARNESSES,
          question: null,
          defaults: DEFAULTS,
          defaults_from: '~/code/sort-bench/.verifold/settings.json',
        }}
        onStarted={() => undefined}
        onRefresh={() => undefined}
      />,
    );

    assert.ok(html.includes('~/code/sort-bench'));
    assert.ok(html.includes('Not found on this computer'));
    assert.ok(html.includes('Start lab with 1 agent'));
    assert.ok(
      html.includes(
        'Its first choices come from <code>~/code/sort-bench/.verifold/settings.json</code>.',
      ),
    );
    assert.ok(html.includes('<summary>Opus, High effort (your default)</summary>'));
    assert.ok(html.includes('<option value="" selected="">Opus (your default)</option>'));
    assert.ok(html.includes('<option value="plan">Plan</option>'));
  });

  it('waits for a harness that Verifold still asks, and takes typed choices from one that did not answer', () => {
    const [claude] = HARNESSES;
    const page = (option: HarnessOption): string =>
      renderToStaticMarkup(
        <SetupPage
          api={{} as Api}
          setup={{
            folder: '~/code',
            harnesses: [option],
            question: null,
            defaults: DEFAULTS,
            defaults_from: null,
          }}
          onStarted={() => undefined}
          onRefresh={() => undefined}
        />,
      );
    assert.ok(claude);

    const asking = page({ ...claude, probing: true, offer: null });
    const typed = page({ ...claude, offer: null });
    const empty = page({ ...claude, offer: { ...OFFER, models: [], efforts: [], modes: [] } });

    assert.ok(asking.includes('Asking Claude Code what it offers.'));
    assert.equal(asking.includes('<select'), false);
    assert.ok(typed.includes('placeholder="Your default"'));
    assert.ok(typed.includes('Leave a field blank to keep your own setting for Claude Code.'));
    assert.ok(empty.includes('Claude Code offers no model, effort, or mode choices.'));
  });
});

describe('the settings page', () => {
  const pause = { version: 1, jobs: { at_time_limit: 'pause', at_exit: 'stop' } } as const;
  const view: SettingsView = {
    all_projects: {
      path: '~/.verifold/settings.json',
      values: {},
      revision: '',
      settings: pause,
      defaults: DEFAULTS,
    },
    project: {
      path: '~/code/sort-bench/.verifold/settings.json',
      values: {
        jobs: { at_exit: 'keep' },
        setup: {
          agents: [{ harness: 'claude-code', count: 2, model: 'opus' }],
          auto_mode: false,
          minutes: 90,
        },
      },
      revision: 'abc',
      settings: { ...pause, jobs: { ...pause.jobs, at_exit: 'keep' } },
      defaults: {
        agents: [{ harness: 'claude-code', count: 2, model: 'opus', effort: null, mode: null }],
        auto_mode: false,
        minutes: 90,
      },
    },
    lab: pause,
  };
  const page = (level: 'project' | 'all'): string =>
    renderToStaticMarkup(
      <SettingsForm
        view={view}
        level={level}
        labOpen
        harnesses={HARNESSES}
        disabled={false}
        onChange={() => undefined}
      />,
    );

  it('lets a project follow the setting for all projects, or hold its own', () => {
    const html = page('project');

    assert.ok(html.includes('~/code/sort-bench/.verifold/settings.json'));
    assert.ok(html.includes('A change applies to the running lab now'));
    assert.ok(
      html.includes(
        '<button type="button" aria-pressed="true"><b>Same as all projects</b><span>Now: Pause them.</span>',
      ),
    );
    assert.ok(html.includes('<button type="button" aria-pressed="true"><b>Keep them</b>'));
    assert.equal(html.split('aria-pressed="true"').length - 1, 2);
    // The lab started before the project kept its processes, and follows its own copy until the person chooses.
    assert.ok(
      html.includes('The running lab still follows “Stop them”. Choose an answer to change it.'),
    );
    assert.equal(html.includes('has its own setting'), false);
    assert.ok(html.includes('Claude Code: 2 agents (opus). No auto mode. Time limit: 1 h 30 min.'));
    assert.ok(html.includes('Use the choices for all projects'));
  });

  it('shows the settings for all projects with the defaults where the file has nothing', () => {
    const html = page('all');

    assert.ok(html.includes('~/.verifold/settings.json'));
    assert.equal(html.includes('Same as all projects'), false);
    assert.ok(html.includes('<button type="button" aria-pressed="true"><b>Pause them</b>'));
    assert.ok(html.includes('<button type="button" aria-pressed="true"><b>Stop them</b>'));
    assert.ok(
      html.includes('This project has its own setting, “Keep them”, and it wins over this one.'),
    );
    assert.equal(html.split('has its own setting').length - 1, 1);
    // No answer here changes the lab where the project has its own setting, so the page doesn't offer one.
    assert.equal(html.includes('The running lab still follows'), false);
    assert.ok(
      html.includes('One agent of each harness that this computer has. Auto mode. No time limit.'),
    );
    assert.equal(html.includes('Use Verifold&#x27;s defaults'), false);
    assert.ok(html.includes('This project has saved choices of its own, and they win over these.'));
  });
});
