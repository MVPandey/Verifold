import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SetupBridge, type SetupView } from '../src/cli/setup-bridge.ts';
import { renderSetup } from '../src/cli/desk-view.ts';
import { runCli, type CliIO } from '../src/cli/commands.ts';
import { loadWorkspace } from '../src/cli/storage.ts';
import type { HarnessRequest, HarnessResult } from '../src/cli/harness.ts';

// After setup, the project starts a lab, whose first agent starts a harness
// process from PATH. Fake claude and codex commands that stop at once come
// first for the whole file, so no test reaches a real harness.
const fakeBin = await mkdtemp(join(tmpdir(), 'verifold-fake-bin-'));
for (const name of ['claude', 'codex'])
  await writeFile(join(fakeBin, name), '#!/bin/sh\nexit 1\n', {
    mode: 0o700,
  });
process.env.PATH = `${fakeBin}:${process.env.PATH ?? ''}`;
process.on('exit', () => {
  rmSync(fakeBin, { recursive: true, force: true });
});

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
  io.step?.('Question');
  const host = io.select?.(
    '01 / Connect · Choose your agent harness',
    [
      { value: 'claude', label: 'Claude Code', description: 'Claude' },
      { value: 'codex', label: 'Codex', description: 'Codex' },
    ],
    'claude',
  );
  let view = bridge.view();
  assert.equal(view.step, 'Question');
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
  assert.ok(lines.some((line) => line.includes('Question')));
  const waiting = io.ask('Anything else? ');
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(bridge.view().prompt, null);
});

await test('the setup log keeps the latest lines in a scroll area, newest first, and folds long ones', () => {
  const at = new Date().toISOString();
  const brief = `# Research brief\n\n${'The question narrows to road graphs. '.repeat(20)}`;
  const view: SetupView = {
    step: 'Brief',
    lines: [
      ...Array.from({ length: 70 }, (_, index) => ({
        at,
        source: 'verifold' as const,
        text: `Step ${index}`,
      })),
      { at, source: 'you', text: 'Fast graph search on CPUs' },
      { at, source: 'agent', text: brief },
    ],
    prompt: { id: 3, kind: 'review', brief, final: false },
    busy: null,
    outcome: 'running',
    error: null,
  };
  const { html } = renderSetup(view);
  const log =
    /<ol class="setup-lines" reversed>([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? '';
  // The latest 60 of 72 lines, newest first.
  assert.equal(log.match(/<li /g)?.length, 60);
  assert.ok(log.indexOf('Research brief') < log.indexOf('Step 69'));
  assert.doesNotMatch(log, /Step 11</);
  // A long line shows its lead and folds the rest.
  assert.match(log, /<details class="more" id="setup-line-71">/);
  // The review shows the brief once: not again as harness text above it.
  assert.doesNotMatch(html, /class="setup-said"/);
  assert.match(
    html,
    /Review the brief[\s\S]*The question narrows to road graphs\./,
  );
});

// With a background owner (D93), setup hands the project over, and the same tab keeps working.
for (const background of [false, true])
  await test(`bare verifold sets up a new project in the desk and opens the project there${background ? ', in a background owner' : ''}`, async (t) => {
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
      'desk-map.js',
      'desk-motion.js',
      'manrope.ttf',
      'symbol.webp',
    ])
      await writeFile(join(assets, 'cli', name), 'fixture asset');
    await writeFile(join(assets, 'cli', 'vendor', 'purify.js'), 'fixture');
    await writeFile(join(assets, 'cli', 'vendor', 'idiomorph.js'), 'fixture');
    for (const name of ['xterm.js', 'xterm.css', 'addon-fit.js'])
      await writeFile(join(assets, 'cli', 'vendor', name), 'fixture');
    await writeFile(join(assets, 'ui', 'dom.js'), 'fixture module');
    let interview = 0;
    // The research requests that reach the harness. A lab starts none.
    const asked: string[] = [];
    const harness = (request: HarnessRequest): Promise<HarnessResult> => {
      request.onActivity?.('Claude Code requested WebSearch.', 'event');
      if (request.prompt.includes('\nTopic: ')) {
        asked.push(request.prompt);
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
      }
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
    const owner = new AbortController();
    // A failed assertion must not leave the desk and its owner running.
    t.after(() => {
      controller.abort();
      owner.abort();
    });
    const keys = join(root, 'keys');
    const handoffs: string[] = [];
    let ownerDone: Promise<void> | undefined;
    // The test runs the background owner in this process. The executable spawns it detached.
    const backgroundIo = {
      keys,
      start: (folder: string, input: string): Promise<void> => {
        handoffs.push(input);
        ownerDone = runCli(
          ['owner', '--workspace', folder],
          folder,
          {
            interactive: false,
            ask: () => Promise.reject(new Error('The owner asks nothing.')),
            out: () => {},
            browse: (url) => {
              opened.push(url);
              return Promise.resolve(true);
            },
            deskAssets: pathToFileURL(`${assets}/cli/`),
            background: {
              keys,
              start: () =>
                Promise.reject(new Error('The owner starts no owner.')),
              input: () => Promise.resolve(input),
            },
          },
          owner.signal,
          harness,
        );
        return Promise.resolve();
      },
      input: () => Promise.reject(new Error('A terminal has no owner input.')),
    };
    const done = runCli(
      ['--agency-dir', agencyDir, '--workspace', project],
      root,
      {
        interactive: true,
        ask: () =>
          Promise.reject(
            new Error('The terminal must not ask during desk setup.'),
          ),
        // Bare verifold opens setup in the desk without a choice in the terminal.
        select: () =>
          Promise.reject(
            new Error('The terminal must not choose during desk setup.'),
          ),
        out: (value) => urls.push(value),
        progress: (line) => lines.push(line),
        browse: (url) => {
          opened.push(url);
          return Promise.resolve(true);
        },
        deskAssets: pathToFileURL(`${assets}/cli/`),
        ...(background ? { background: backgroundIo } : {}),
      },
      controller.signal,
      harness,
    );
    for (let tries = 0; tries < 200 && !urls.length; tries++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const url = new URL((JSON.parse(urls[0] ?? '{}') as { url: string }).url);
    assert.equal(opened.length, 1);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
    // The page server's origin, which the open tab's CSP lets the desk frame.
    const frames = async (): Promise<string | undefined> =>
      /frame-src [^;]*/.exec(
        (await fetch(`${url.origin}/`)).headers.get(
          'content-security-policy',
        ) ?? '',
      )?.[0];
    const framed = await frames();
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
    // One question at a time: the question with its settings, at most three quick questions, then the brief.
    const answers: [RegExp, unknown][] = [
      [
        // With both harnesses on the PATH, the default team has a helper.
        /What do you want to find out\?[\s\S]*Claude Code(?: leads)?, with its default model(?:, and Codex helps)?\. Folder: /,
        '/settings',
      ],
      [/Which harnesses run the research/, 'claude'],
      [/Which model should Claude Code use/, ''],
      // A lab follows setup, and a lab has no stop before its work, so the settings offer none.
      [
        /What do you want to find out\?[\s\S]*Claude Code, with its default model\. Folder: [^<]*\.</,
        'Fast graph search on CPUs',
      ],
      [
        /class="setup-said"[\s\S]*Which baseline do you trust\?[\s\S]*Question 1 of up to 3/,
        'The speedrun baseline',
      ],
      [
        /Review the brief/,
        { action: 'edit', brief: '# Research brief\n\nEdited by me.' },
      ],
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
      assert.doesNotMatch(html, /source search/);
      seen.push(pattern.source);
      if (pattern.source === 'Review the brief') {
        // The setup log holds the earlier steps and, under Details, the harness runs of setup.
        assert.match(
          html,
          /<details class="setup-log"[\s\S]*data-source="setup"/,
        );
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
    // After setup, the project starts a lab on its question. No research step starts.
    let html = '';
    for (
      let tries = 0;
      tries < 1500 && !/class="lab-screen"/.test(html);
      tries++
    ) {
      // While the background owner takes over, the desk does not answer for a moment.
      html = await view().catch(() => '');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(
      html,
      /<h1 id="view-title" tabindex="-1">Fast graph search on CPUs<\/h1>/,
    );
    assert.equal(
      (
        JSON.parse(
          await readFile(join(project, '.verifold', 'lab.json'), 'utf8'),
        ) as { question: string }
      ).question,
      'Fast graph search on CPUs',
    );
    assert.equal(asked.length, 0);
    // After setup, the setup transcript is gone with the setup desk.
    assert.equal(
      (await fetch(`${url.origin}/api/transcript?source=setup`, { headers }))
        .status,
      404,
    );
    // The lab keeps the question for the project once it runs, a moment after it starts.
    let workspace = await loadWorkspace(project);
    for (let tries = 0; tries < 1500 && !workspace.research; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      workspace = await loadWorkspace(project);
    }
    assert.equal(workspace.context, '# Research brief\n\nEdited by me.');
    assert.equal(workspace.research?.topic, 'Fast graph search on CPUs');
    assert.equal(workspace.research?.phase, 'needs-plan');
    assert.ok(
      lines.some((line) =>
        line.includes('Setup step in the desk: Quick questions'),
      ),
    );
    assert.ok(existsSync(join(project, '.verifold', 'owner.json')));
    if (background) {
      // The owner opened its desk on the port and token of the setup desk, so the tab needed no new URL.
      assert.equal(handoffs.length, 1);
      assert.equal(opened.length, 1);
      assert.ok(
        lines.includes('The desk in your browser now shows the project.'),
      );
      // The page server moved to the same port too, so the tab can still frame pages.
      assert.equal(await frames(), framed);
      // Ctrl+C detaches the terminal. The owner keeps the project.
      controller.abort();
      await done;
      assert.ok(existsSync(join(project, '.verifold', 'owner.json')));
      owner.abort();
      await ownerDone;
    } else {
      controller.abort();
      await done.catch(() => {});
    }
    assert.equal(existsSync(join(project, '.verifold', 'owner.json')), false);
    assert.match(
      await readFile(join(project, '.verifold.md'), 'utf8'),
      /Edited by me/,
    );
  });
