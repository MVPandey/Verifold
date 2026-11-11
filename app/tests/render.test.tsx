import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Api } from '../src/api/client.ts';
import type { HarnessOption, Post, SettingsView, ThreadView } from '../src/api/types.ts';
import { LabPage } from '../src/ui/LabPage.tsx';
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
    assert.ok(html.includes('class="f-mark fm-bad fk-objection"'));
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
  const data = { setup, lab, threads, needs, version: 1, error: null, reload: () => undefined };
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
