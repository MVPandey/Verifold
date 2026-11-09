import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import type { Api } from '../src/api/client.ts';
import type { HarnessOption, SettingsView, ThreadView } from '../src/api/types.ts';
import { SettingsForm } from '../src/ui/SettingsPage.tsx';
import { SetupPage } from '../src/ui/SetupPage.tsx';
import { PostItem } from '../src/ui/ThreadPage.tsx';
import { HARNESSES, OFFER, agentView, postView, result } from './fixtures.ts';

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
      <PostItem
        item={postView(post)}
        thread={thread}
        agents={[agentView('agent-1')]}
        harnesses={HARNESSES}
        waitsForYou={false}
        onRerun={() => Promise.resolve()}
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

describe('the setup screen', () => {
  it('offers one agent of each harness that this computer has', () => {
    const api = {} as Api;
    const html = renderToStaticMarkup(
      <SetupPage
        api={api}
        setup={{ folder: '~/code/sort-bench', harnesses: HARNESSES, question: null }}
        onStarted={() => undefined}
        onRefresh={() => undefined}
      />,
    );

    assert.ok(html.includes('~/code/sort-bench'));
    assert.ok(html.includes('Not found on this computer'));
    assert.ok(html.includes('Start lab with 1 agent'));
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
          setup={{ folder: '~/code', harnesses: [option], question: null }}
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
    },
    project: {
      path: '~/code/sort-bench/.verifold/settings.json',
      values: { jobs: { at_exit: 'keep' } },
      revision: 'abc',
      settings: { ...pause, jobs: { ...pause.jobs, at_exit: 'keep' } },
    },
    lab: pause,
  };
  const page = (level: 'project' | 'all'): string =>
    renderToStaticMarkup(
      <SettingsForm
        view={view}
        level={level}
        labOpen
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
  });
});
