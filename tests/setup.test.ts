import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SetupBridge } from '../src/cli/setup-bridge.ts';
import { runCli, type CliIO } from '../src/cli/commands.ts';
import { loadWorkspace } from '../src/cli/storage.ts';
import type { HarnessRequest, HarnessResult } from '../src/cli/harness.ts';

const terminal = (lines: string[]): CliIO => ({
  interactive: true,
  ask: () =>
    Promise.reject(new Error('The terminal must not ask during desk setup.')),
  out: () => {},
  progress: (line) => lines.push(line),
});

await test('the setup bridge turns each question into one desk prompt', async () => {
  const lines: string[] = [];
  const controller = new AbortController();
  const bridge = new SetupBridge(terminal(lines), controller.signal);
  const { io } = bridge;
  io.step?.('Connect');
  const host = io.select?.(
    '01 / Connect · Choose your agent harness',
    [
      { value: 'claude', label: 'Claude Code', description: 'Claude' },
      { value: 'codex', label: 'Codex', description: 'Codex' },
    ],
    'claude',
  );
  let view = bridge.view();
  assert.equal(view.step, 'Connect');
  assert.equal(view.prompt?.kind, 'choice');
  const choice = view.prompt?.id ?? 0;
  assert.throws(() => bridge.answer(choice, 'gemini'), /listed options/);
  assert.throws(() => bridge.answer(choice + 1, 'claude'), /no longer open/);
  bridge.answer(choice, 'codex');
  assert.equal(await host, 'codex');
  const consent = io.ask('Read this file? [y/N]: ', {
    kind: 'confirm',
    yes: 'Read it',
    no: 'Skip',
  });
  view = bridge.view();
  assert.equal(
    view.prompt?.kind === 'ask' && view.prompt.question,
    'Read this file?',
  );
  bridge.answer(view.prompt?.id, 'y');
  assert.equal(await consent, 'y');
  const review = io.review?.('# Research brief\n\nDraft', false);
  const reviewId = bridge.view().prompt?.id;
  assert.throws(
    () => bridge.answer(reviewId, { action: 'edit', brief: ' ' }),
    /Accept the brief/,
  );
  bridge.answer(reviewId, { action: 'edit', brief: '# Mine' });
  assert.deepEqual(await review, { action: 'edit', brief: '# Mine' });
  io.progress?.('Which baseline?', 'agent');
  assert.deepEqual(
    bridge.view().lines.map((line) => [line.source, line.text]),
    [
      ['you', 'Codex'],
      ['you', 'Read it'],
      ['you', 'Edited the brief and accepted my version.'],
      ['agent', 'Which baseline?'],
    ],
  );
  assert.ok(lines.some((line) => line.includes('Connect')));
  const waiting = io.ask('Anything else? ');
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(bridge.view().prompt, null);
});

await test('bare verifold sets up a new project in the desk and opens the project there', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-setup-'));
  const agencyDir = join(root, 'agency');
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const assets = join(root, 'assets');
  await mkdir(join(assets, 'cli', 'vendor'), { recursive: true });
  await mkdir(join(assets, 'ui'));
  for (const name of [
    'desk.css',
    'desk-client.js',
    'desk-transcript.js',
    'desk-terminal.js',
    'desk-terminals.js',
    'desk-lease.js',
    'manrope.ttf',
    'symbol.webp',
  ])
    await writeFile(join(assets, 'cli', name), 'fixture asset');
  await writeFile(join(assets, 'cli', 'vendor', 'purify.js'), 'fixture');
  for (const name of ['xterm.js', 'xterm.css', 'addon-fit.js'])
    await writeFile(join(assets, 'cli', 'vendor', name), 'fixture');
  await writeFile(join(assets, 'ui', 'dom.js'), 'fixture module');
  let interview = 0;
  const harness = (request: HarnessRequest): Promise<HarnessResult> => {
    request.onActivity?.('Claude Code requested WebSearch.', 'event');
    if (request.prompt.includes('\nTopic: '))
      return Promise.resolve({
        text: JSON.stringify({
          scope: 'Compare graph search on CPUs.',
          personas: [
            { name: 'Historian', task: 'Find prior art.' },
            { name: 'Skeptic', task: 'Find counterexamples.' },
          ],
        }),
        sessionId: 'research-1',
      });
    interview++;
    request.onTranscript?.({
      kind: 'request',
      parent: null,
      text: request.prompt,
    });
    request.onTranscript?.({
      kind: 'text',
      parent: null,
      text: `Interview step ${interview}`,
    });
    return Promise.resolve({
      text:
        interview === 1
          ? JSON.stringify({ question: 'Which baseline do you trust?' })
          : '# Research brief\n\nDraft from the harness.',
      sessionId: 'interview-1',
    });
  };
  const urls: string[] = [];
  const lines: string[] = [];
  const opened: string[] = [];
  const controller = new AbortController();
  // A failed assertion must not leave the desk and its owner running.
  t.after(() => controller.abort());
  const done = runCli(
    ['--agency-dir', agencyDir, '--workspace', project],
    root,
    {
      interactive: true,
      ask: () =>
        Promise.reject(
          new Error('The terminal must not ask during desk setup.'),
        ),
      select: (question, _choices, initial) => {
        assert.match(question, /set up this project/);
        return Promise.resolve(initial);
      },
      out: (value) => urls.push(value),
      progress: (line) => lines.push(line),
      browse: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
      deskAssets: pathToFileURL(`${assets}/cli/`),
    },
    controller.signal,
    harness,
  );
  for (let tries = 0; tries < 200 && !urls.length; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const url = new URL((JSON.parse(urls[0] ?? '{}') as { url: string }).url);
  assert.equal(opened.length, 1);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const view = async (): Promise<string> =>
    (
      (await (await fetch(`${url.origin}/api/view`, { headers })).json()) as {
        html: string;
      }
    ).html;
  const answer = async (prompt: number, value: unknown): Promise<void> => {
    const response = await fetch(`${url.origin}/api/action`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'setup', prompt, value }),
    });
    assert.equal(response.status, 200, await response.text());
  };
  const answers: [RegExp, unknown][] = [
    [/Choose your agent harness/, 'claude'],
    [/Which model should your harness use/, ''],
    [/Give your agents useful research context/, 'skip'],
    [/What do you want to research/, 'Fast graph search on CPUs'],
    [/Reply to your harness/, 'The speedrun baseline'],
    [
      /Review the brief/,
      { action: 'edit', brief: '# Research brief\n\nEdited by me.' },
    ],
    [/How should your agents explore/, 'guided'],
  ];
  const seen: string[] = [];
  for (const [pattern, value] of answers) {
    let html = '';
    for (let tries = 0; tries < 300; tries++) {
      html = await view();
      if (pattern.test(html) && /data-prompt="\d+"/.test(html)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(html, pattern);
    seen.push(pattern.source);
    if (pattern.source === 'Review the brief') {
      // Details shows the harness runs of setup, with Markdown as HTML.
      assert.match(html, /data-source="setup"/);
      const page = (await (
        await fetch(`${url.origin}/api/transcript?source=setup`, { headers })
      ).json()) as { entries: { kind: string; html?: string }[] };
      assert.deepEqual(
        page.entries.map((entry) => entry.kind),
        ['request', 'text', 'request', 'text'],
      );
      assert.match(page.entries[3]?.html ?? '', /<p>Interview step 2<\/p>/);
    }
    await answer(Number(/data-prompt="(\d+)"/.exec(html)?.[1]), value);
  }
  let html = '';
  for (let tries = 0; tries < 300 && !/Review the plan/.test(html); tries++) {
    html = await view();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(html, /Review the plan/);
  // After setup, the setup transcript is gone with the setup desk.
  assert.equal(
    (await fetch(`${url.origin}/api/transcript?source=setup`, { headers }))
      .status,
    404,
  );
  const workspace = await loadWorkspace(project);
  assert.equal(workspace.context, '# Research brief\n\nEdited by me.');
  assert.equal(workspace.research?.phase, 'awaiting-plan-review');
  assert.ok(
    lines.some((line) => line.includes('Setup step in the desk: Interview')),
  );
  assert.ok(existsSync(join(project, '.verifold', 'owner.json')));
  controller.abort();
  await done.catch(() => {});
  assert.equal(existsSync(join(project, '.verifold', 'owner.json')), false);
  assert.match(
    await readFile(join(project, '.verifold.md'), 'utf8'),
    /Edited by me/,
  );
});
