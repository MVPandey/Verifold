import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  deskPage,
  renderDesk,
  renderSetup,
  terminalPage,
} from './desk-view.ts';
import { ptyLibrary, validLease } from './terminals.ts';
import {
  readDeskSnapshot,
  readDeskReport,
  validAttemptId,
} from './desk-records.ts';
import type { ResearchReport } from './research.ts';
import {
  SessionActionError,
  sessionTranscript,
  validSessionId,
} from './session.ts';
import type { SessionPool } from './workers.ts';
import { TranscriptFile, type TranscriptLog } from './transcript.ts';
import { markdownHtml } from './markdown.ts';
import type { ResearchRunner } from './research-runner.ts';
import type { SetupBridge } from './setup-bridge.ts';
import {
  validTaskId,
  type TaskInputFields,
  type TaskManager,
} from './tasks.ts';
import { coordinatorContext, type Coordinator } from './coordinator.ts';
import { loadWorkspace } from './storage.ts';

export interface DeskServer {
  /** The desk URL with its access token. Print it, but do not pass it to another process. */
  readonly url: string;
  /** A URL with a one-time code for a browser launch. Each code works once, for two minutes. */
  launchUrl(): string;
  /** Switch a setup desk to the project that setup created. */
  attach(
    root: string,
    sessions: SessionPool,
    research: ResearchRunner,
    tasks: TaskManager,
    coordinator: Coordinator,
  ): Promise<void>;
  readonly closed: Promise<void>;
}

/** Read a JSON request body up to `limit` bytes. Returns null when it is too large or unreadable. */
async function readJsonBody(
  request: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The fields of a task form, as the page sends them. */
function taskFields(body: Record<string, unknown>): TaskInputFields {
  return {
    title: body.title,
    objective: body.objective,
    inputs: body.inputs,
    writable: body.writable,
    output: body.output,
    host: body.host,
    model: body.model,
    minutes: body.minutes,
    dependencies: body.dependencies,
  };
}

/** Task actions. Errors that the person can fix are SessionActionError. */
async function taskAction(
  tasks: TaskManager,
  body: Record<string, unknown>,
): Promise<void> {
  switch (body.action) {
    case 'task-create':
      await tasks.create(taskFields(body));
      return;
    case 'task-edit':
      await tasks.edit(body.task, { ...taskFields(body), reason: body.reason });
      return;
    case 'task-start':
      await tasks.start(body.task);
      return;
    case 'task-stop':
      await tasks.stop(body.task);
      return;
    case 'task-changes':
      await tasks.askForChanges(body.task, body.note);
      return;
    case 'task-accept': {
      const result = await tasks.accept(body.task, body.version, body.files);
      if ('conflicts' in result)
        throw new SessionActionError(
          `These files changed in your project after the task started, so Verifold copied nothing: ${result.conflicts.join(', ')}. Ask for changes, or reject the version.`,
        );
      return;
    }
    case 'task-reject':
      await tasks.reject(body.task, body.version);
      return;
    case 'task-cancel':
      await tasks.cancel(body.task);
      return;
    case 'task-message':
      await tasks.post(body.to, body.text);
      return;
    case 'task-decide':
      await tasks.decideMessage(body.message, body.decision, body.reason);
      return;
    default:
      throw new SessionActionError('The desk sent an unknown task action.');
  }
}

/** True when terminal panes work here, or why they do not. */
async function terminalSupport(): Promise<true | string> {
  const library = await ptyLibrary();
  return typeof library === 'string' ? library : true;
}

/** Run one desk action on the project owner. Returns 200, or 400 for an unknown action. */
async function act(
  sessions: SessionPool | undefined,
  research: ResearchRunner | undefined,
  setup: SetupBridge | undefined,
  tasks: TaskManager | undefined,
  coordinator: Coordinator | undefined,
  root: string,
  body: Record<string, unknown>,
): Promise<number> {
  if (body.action === 'setup') {
    if (!setup) return 400;
    setup.answer(body.prompt, body.value);
    return 200;
  }
  if (!sessions)
    throw new SessionActionError(
      'The project does not exist yet. Finish setup first.',
    );
  if (
    research &&
    (body.action === 'research' ||
      body.action === 'cancel-research' ||
      body.action === 'select')
  ) {
    if (body.action === 'cancel-research') research.cancel();
    else if (body.action === 'select') await research.select(body.idea);
    else
      await research.start({
        ...(body.approve === true ? { approve: true } : {}),
        ...(typeof body.feedback === 'string'
          ? { feedback: body.feedback }
          : {}),
        ...(typeof body.topic === 'string' ? { topic: body.topic } : {}),
        ...(body.autonomy === 'guided' || body.autonomy === 'autonomous'
          ? { autonomy: body.autonomy }
          : {}),
      });
    return 200;
  }
  if (
    tasks &&
    typeof body.action === 'string' &&
    body.action.startsWith('task-')
  ) {
    await taskAction(tasks, body);
    return 200;
  }
  if (
    coordinator &&
    tasks &&
    typeof body.action === 'string' &&
    body.action.startsWith('coordinator-')
  ) {
    switch (body.action) {
      case 'coordinator-start': {
        const workspace = await loadWorkspace(root);
        await coordinator.start({
          objective: body.objective,
          host: body.host,
          model: body.model,
          context: coordinatorContext(workspace),
          guided: workspace.research?.autonomy !== 'autonomous',
        });
        return 200;
      }
      case 'coordinator-approve':
        await coordinator.approvePlan();
        return 200;
      case 'coordinator-stop':
        await coordinator.stop();
        return 200;
      case 'coordinator-resume':
        await coordinator.resume();
        return 200;
      case 'coordinator-message':
        await tasks.post('coordinator', body.text);
        return 200;
      default:
        return 400;
    }
  }
  if (body.action === 'terminal-open') {
    if (!validLease(body.lease))
      throw new SessionActionError('The desk sent an invalid input lease.');
    const id = typeof body.session === 'string' ? body.session : '';
    const task = sessions.view(id)?.record.task;
    // A task terminal goes through the task, so its end saves a version.
    if (task && tasks) await tasks.openTerminal(task.id, body.lease);
    else await sessions.takeTerminal(id, body.lease);
    return 200;
  }
  if (body.action === 'terminal-return') {
    sessions.returnFromTerminal(body.session);
    return 200;
  }
  switch (body.action) {
    case 'start':
      await sessions.start({
        host: body.host,
        mode: body.mode,
        model: body.model,
        prompt: body.prompt,
      });
      return 200;
    case 'resume':
      await sessions.resume(body.session);
      return 200;
    case 'restart':
      await sessions.restart(body.session);
      return 200;
    case 'send':
      sessions.send(body.session, body.text);
      return 200;
    case 'cancel':
      sessions.cancel(body.session);
      return 200;
    case 'end':
      sessions.end(body.session);
      return 200;
    case 'answer':
      if (body.decision !== 'allow' && body.decision !== 'deny')
        throw new SessionActionError('Choose allow or deny.');
      sessions.answer(body.request, body.decision === 'allow');
      return 200;
    case 'review':
      sessions.review(body.command);
      return 200;
    default:
      return 400;
  }
}

/**
 * Serve one selected project until its owning CLI is cancelled. With a session
 * owner, authenticated JSON POST requests to /api/action control its session.
 */
export async function startDesk(
  root: string | null,
  signal: AbortSignal,
  assetsRoot: URL = new URL('./', import.meta.url),
  sessions?: SessionPool,
  research?: ResearchRunner,
  setup?: SetupBridge,
  tasks?: TaskManager,
  coordinator?: Coordinator,
): Promise<DeskServer> {
  signal.throwIfAborted();
  // In setup mode the project does not exist yet. attach() sets it.
  let project: string | null = root === null ? null : await realpath(root);
  if (project) await readDeskSnapshot(project);
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${token}`);
  // A browser launch command line can be visible to other local users, so it carries a one-time code.
  const launchCodes = new Map<string, number>();
  const assets = new Map<string, { type: string; body: Buffer | string }>([
    ['/', { type: 'text/html; charset=utf-8', body: deskPage }],
    ['/terminal', { type: 'text/html; charset=utf-8', body: terminalPage }],
  ]);
  for (const [path, file, type] of [
    ['/desk.css', 'desk.css', 'text/css; charset=utf-8'],
    ['/desk-client.js', 'desk-client.js', 'text/javascript; charset=utf-8'],
    ['/desk-terminal.js', 'desk-terminal.js', 'text/javascript; charset=utf-8'],
    ['/desk-lease.js', 'desk-lease.js', 'text/javascript; charset=utf-8'],
    [
      '/desk-terminals.js',
      'desk-terminals.js',
      'text/javascript; charset=utf-8',
    ],
    ['/vendor/xterm.js', 'vendor/xterm.js', 'text/javascript; charset=utf-8'],
    ['/vendor/xterm.css', 'vendor/xterm.css', 'text/css; charset=utf-8'],
    [
      '/vendor/addon-fit.js',
      'vendor/addon-fit.js',
      'text/javascript; charset=utf-8',
    ],
    [
      '/desk-transcript.js',
      'desk-transcript.js',
      'text/javascript; charset=utf-8',
    ],
    ['/manrope.ttf', 'manrope.ttf', 'font/ttf'],
    ['/symbol.webp', 'symbol.webp', 'image/webp'],
    ['/ui/dom.js', '../ui/dom.js', 'text/javascript; charset=utf-8'],
    ['/vendor/purify.js', 'vendor/purify.js', 'text/javascript; charset=utf-8'],
  ] as const) {
    assets.set(path, { type, body: await readFile(new URL(file, assetsRoot)) });
  }
  let origin = '';
  let pending = 0;
  /** Open long polls of terminal output. */
  let terminalReads = 0;
  /** Transcript files that the page follows. The least recently used one leaves first. */
  const followed = new Map<string, TranscriptFile>();

  /** The transcript for one source: `setup`, `attempt:<id>`, or `session:<id>`. */
  async function transcript(source: string): Promise<{
    readonly log: TranscriptLog;
    readonly found: boolean;
  } | null> {
    if (source === 'setup')
      return !project && setup ? { log: setup.transcript, found: true } : null;
    const match = /^(attempt|session):(.{1,100})$/.exec(source);
    if (!project || !match) return null;
    const [, kind, id = ''] = match;
    const path =
      kind === 'attempt'
        ? validAttemptId(id)
          ? join(project, '.verifold', 'runs', id, 'transcript.jsonl')
          : null
        : sessionTranscript(project, id);
    if (!path) return null;
    const file = followed.get(path) ?? new TranscriptFile(path);
    followed.delete(path);
    followed.set(path, file);
    if (followed.size > 8) followed.delete(followed.keys().next().value ?? '');
    await file.refresh();
    return { log: file.log, found: file.found };
  }
  const server = createServer(
    { maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000 },
    (request, response) => {
      void respond(request, response).catch(() => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            error:
              'Project records could not be read. Inspect the selected workspace and refresh.',
          }),
        );
      });
    },
  );
  server.maxConnections = 20;
  server.setTimeout(10000, (socket) => socket.destroy());

  async function respond(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    if (
      request.headers.host !== origin.slice(7) ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== origin) ||
      (request.headers['sec-fetch-site'] !== undefined &&
        request.headers['sec-fetch-site'] !== 'same-origin' &&
        request.headers['sec-fetch-site'] !== 'none')
    ) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url ?? '/', origin);
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const authorized =
      supplied.length === authorization.length &&
      timingSafeEqual(supplied, authorization);
    // A JSON content type keeps plain cross-site forms out, in addition to the token or code.
    const json = /^application\/json(;|$)/i.test(
      request.headers['content-type'] ?? '',
    );
    if (
      request.method === 'POST' &&
      url.pathname === '/api/launch' &&
      !url.search
    ) {
      const body = json ? await readJsonBody(request, 1000) : null;
      const code = Buffer.from(
        record(body) && typeof body.code === 'string' ? body.code : '',
      );
      let valid = false;
      for (const [candidate, expires] of launchCodes) {
        const known = Buffer.from(candidate);
        if (known.length === code.length && timingSafeEqual(known, code)) {
          launchCodes.delete(candidate);
          valid = expires > Date.now();
        }
      }
      response
        .writeHead(valid ? 200 : 403, {
          'Content-Type': 'application/json; charset=utf-8',
        })
        .end(valid ? JSON.stringify({ token }) : '{}');
      return;
    }
    if (
      request.method === 'POST' &&
      (sessions || setup) &&
      url.pathname === '/api/action' &&
      !url.search
    ) {
      if (!authorized) {
        response.writeHead(401).end();
        return;
      }
      if (!json) {
        response.writeHead(415).end();
        return;
      }
      const body = await readJsonBody(request, 512_000);
      let status = 400;
      let message = 'The desk sent an unreadable action.';
      if (record(body))
        try {
          status = await act(
            sessions,
            research,
            setup,
            tasks,
            coordinator,
            project ?? '',
            body,
          );
        } catch (error) {
          if (!(error instanceof SessionActionError)) throw error;
          status = 409;
          message = error.message;
        }
      response
        .writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
        })
        .end(
          JSON.stringify(status === 200 ? { ok: true } : { error: message }),
        );
      return;
    }
    if (
      request.method === 'POST' &&
      sessions &&
      url.pathname === '/api/terminal' &&
      !url.search
    ) {
      if (!authorized) {
        response.writeHead(401).end();
        return;
      }
      if (!json) {
        response.writeHead(415).end();
        return;
      }
      const body = await readJsonBody(request, 200_000);
      const terminal = record(body) ? sessions.terminal(body.session) : null;
      let status = 200;
      let message = '';
      if (!record(body) || !validLease(body.lease)) {
        status = 400;
        message = 'The terminal sent an unreadable request.';
      } else if (!terminal) {
        status = 404;
        message = 'The terminal is not open.';
      } else
        try {
          if (body.take === true) terminal.take(body.lease);
          if (body.input !== undefined) terminal.write(body.lease, body.input);
          if (body.cols !== undefined || body.rows !== undefined)
            terminal.resize(body.lease, body.cols, body.rows);
        } catch (error) {
          if (!(error instanceof SessionActionError)) throw error;
          status = 409;
          message = error.message;
        }
      response
        .writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
        })
        .end(
          JSON.stringify(status === 200 ? { ok: true } : { error: message }),
        );
      return;
    }
    if (request.method !== 'GET') {
      response
        .writeHead(405, { Allow: sessions || setup ? 'GET, POST' : 'GET' })
        .end();
      return;
    }
    // The terminal page needs inline styles for xterm.js, so only it gets them. Only the desk may frame it.
    if (url.pathname === '/terminal') {
      const id = url.searchParams.get('session') ?? '';
      if (
        !validSessionId(id) ||
        [...url.searchParams.keys()].some((key) => key !== 'session')
      ) {
        response.writeHead(400).end();
        return;
      }
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
      );
      response.setHeader('X-Frame-Options', 'SAMEORIGIN');
      response
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(terminalPage);
      return;
    }
    if (url.pathname === '/api/terminal') {
      if (!authorized) {
        response.writeHead(401).end();
        return;
      }
      const id = url.searchParams.get('session') ?? '';
      const after = Number(url.searchParams.get('after') ?? '0');
      if (
        !validSessionId(id) ||
        !Number.isSafeInteger(after) ||
        after < 0 ||
        [...url.searchParams.keys()].some(
          (key) => key !== 'session' && key !== 'after',
        )
      ) {
        response.writeHead(400).end();
        return;
      }
      const terminal = sessions?.terminal(id);
      if (!terminal) {
        response.writeHead(404).end();
        return;
      }
      if (terminalReads >= 8) {
        response.writeHead(503).end();
        return;
      }
      terminalReads++;
      try {
        // A long poll: the answer comes at once with new output, or after a few seconds without.
        const output = await terminal.read(after, 8000);
        response
          .writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
          })
          .end(JSON.stringify(output));
      } finally {
        terminalReads--;
      }
      return;
    }
    const asset = assets.get(url.pathname);
    if (asset && !url.search) {
      response.writeHead(200, { 'Content-Type': asset.type }).end(asset.body);
      return;
    }
    if (url.pathname === '/api/transcript') {
      if (!authorized) {
        response.writeHead(401).end();
        return;
      }
      const source = url.searchParams.get('source') ?? '';
      const after = Number(url.searchParams.get('after') ?? '0');
      const epoch = url.searchParams.get('epoch');
      if (
        [...url.searchParams.keys()].some(
          (key) => !['source', 'after', 'epoch'].includes(key),
        ) ||
        [...url.searchParams.values()].some((value) => value.length > 120) ||
        !Number.isSafeInteger(after) ||
        after < 0 ||
        (epoch !== null && !/^[a-f0-9]{1,32}$/.test(epoch))
      ) {
        response.writeHead(400).end();
        return;
      }
      if (pending >= 4) {
        response.writeHead(503).end();
        return;
      }
      pending++;
      try {
        const found = await transcript(source);
        if (!found) {
          response.writeHead(404).end();
          return;
        }
        const page = found.log.page(epoch, after);
        // Harness Markdown becomes HTML here. The page sanitizes it again before display.
        response
          .writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
          })
          .end(
            JSON.stringify({
              ...page,
              found: found.found,
              entries: page.entries.map((entry) =>
                entry.kind === 'text'
                  ? { ...entry, html: markdownHtml(entry.text ?? '') }
                  : entry,
              ),
            }),
          );
      } finally {
        pending--;
      }
      return;
    }
    if (url.pathname === '/api/task-diff') {
      if (!authorized) {
        response.writeHead(401).end();
        return;
      }
      const id = url.searchParams.get('task');
      const number = Number(url.searchParams.get('version'));
      const file = url.searchParams.get('file') ?? '';
      if (
        !tasks ||
        !validTaskId(id) ||
        !Number.isSafeInteger(number) ||
        number < 1 ||
        !file ||
        file.length > 300 ||
        [...url.searchParams.keys()].some(
          (key) => !['task', 'version', 'file'].includes(key),
        )
      ) {
        response.writeHead(400).end();
        return;
      }
      try {
        const shown = await tasks.diff(id, number, file);
        response
          .writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
          })
          .end(JSON.stringify(shown));
      } catch (error) {
        if (!(error instanceof SessionActionError)) throw error;
        response
          .writeHead(404, {
            'Content-Type': 'application/json; charset=utf-8',
          })
          .end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (url.pathname !== '/api/view') {
      response.writeHead(404).end();
      return;
    }
    if (!authorized) {
      response.writeHead(401).end();
      return;
    }
    const selected = url.searchParams.get('attempt') ?? undefined;
    const chosenTask = url.searchParams.get('task') ?? undefined;
    const chosenWorker = url.searchParams.get('worker') ?? undefined;
    if (
      (selected !== undefined && !validAttemptId(selected)) ||
      (chosenTask !== undefined && !validTaskId(chosenTask)) ||
      (chosenWorker !== undefined && !validSessionId(chosenWorker)) ||
      [...url.searchParams.keys()].some(
        (key) => !['attempt', 'task', 'worker'].includes(key),
      ) ||
      ['attempt', 'task', 'worker'].some(
        (key) => url.searchParams.getAll(key).length > 1,
      )
    ) {
      response.writeHead(400).end();
      return;
    }
    if (pending >= 4) {
      response.writeHead(503).end();
      return;
    }
    if (!project) {
      response
        .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify(renderSetup(setup?.view() ?? null)));
      return;
    }
    const root = project;
    pending++;
    try {
      const snapshot = await readDeskSnapshot(root);
      const id =
        selected ??
        snapshot.workspace.research?.latestAttempt ??
        snapshot.attempts[0]?.id;
      if (
        selected &&
        !snapshot.attempts.some((attempt) => attempt.id === selected)
      ) {
        response.writeHead(404).end();
        return;
      }
      const taskList = tasks ? await tasks.list() : [];
      const task = chosenTask
        ? taskList.find((entry) => entry.id === chosenTask)
        : (taskList.find((entry) =>
            ['claimed', 'running', 'review'].includes(entry.state),
          ) ?? taskList.at(-1));
      if (chosenTask && !task) {
        response.writeHead(404).end();
        return;
      }
      let report: ResearchReport | null = null;
      if (id) {
        try {
          report = await readDeskReport(root, id);
        } catch {
          /* Missing or unsafe reports remain unavailable. */
        }
      }
      const workers = sessions?.views() ?? [];
      // A worker that left its slot falls back to a live one, then to the first.
      const worker =
        workers.find((view) => view.record.id === chosenWorker) ??
        workers.find((view) => view.live) ??
        workers[0] ??
        null;
      const body = JSON.stringify(
        renderDesk(snapshot, selected, report, {
          workers,
          session: worker,
          full: sessions?.full ?? false,
          terminals: await terminalSupport(),
          controllable: sessions !== undefined,
          paused: sessions?.paused() ?? [],
          ...(research ? { research: research.view() } : {}),
          ...(coordinator ? { coordinator: coordinator.view() } : {}),
          ...(tasks
            ? {
                tasks: {
                  list: taskList,
                  selected: task ?? null,
                  idle: workers
                    .filter((view) => sessions?.idle(view.record.id))
                    .map((view) => view.record.id),
                  messages: (await tasks.messageList()).slice(-300),
                },
              }
            : {}),
        }),
      );
      if (Buffer.byteLength(body) > 2_000_000)
        throw new Error('Desk view exceeds its output limit.');
      response
        .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(body);
    } finally {
      pending--;
    }
  }

  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not start the local desk.');
  }
  origin = `http://127.0.0.1:${address.port}`;
  const stop = (): void => {
    server.closeAllConnections();
    server.close();
  };
  const closed = once(server, 'close').then(() => {
    signal.removeEventListener('abort', stop);
  });
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  return {
    url: `${origin}/#${token}`,
    launchUrl: () => {
      for (const [code, expires] of launchCodes)
        if (expires <= Date.now()) launchCodes.delete(code);
      const code = randomBytes(24).toString('hex');
      launchCodes.set(code, Date.now() + 120_000);
      return `${origin}/#launch-${code}`;
    },
    attach: async (next, owner, runner, taskManager, lead) => {
      const resolved = await realpath(next);
      await readDeskSnapshot(resolved);
      sessions = owner;
      research = runner;
      tasks = taskManager;
      coordinator = lead;
      project = resolved;
    },
    closed,
  };
}

/** Browser launch is optional. The printed URL remains usable if it fails. */
export async function openDeskBrowser(
  url: string,
  signal: AbortSignal,
  executable?: string,
): Promise<boolean> {
  const command =
    executable ??
    (process.platform === 'darwin'
      ? 'open'
      : process.platform === 'linux'
        ? 'xdg-open'
        : undefined);
  if (!command) return false;
  try {
    await promisify(execFile)(command, [url], {
      timeout: 3000,
      maxBuffer: 8192,
      signal,
    });
    return true;
  } catch {
    return false;
  }
}
