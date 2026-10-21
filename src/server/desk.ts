import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { copyFile, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { extname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  deskPage,
  parseFrame,
  renderDesk,
  renderSetup,
  terminalPage,
} from '../desk/desk-view.ts';
import { ptyLibrary, validLease } from '../core/terminals.ts';
import {
  readDeskSnapshot,
  readDeskReport,
  validAttemptId,
} from './desk-records.ts';
import type { ResearchReport } from '../legacy/research.ts';
import {
  SessionActionError,
  hostName,
  readRecord,
  sessionTranscript,
  validSessionId,
  type SessionRecord,
  type SessionView,
} from '../core/session.ts';
import type { SessionPool } from '../core/workers.ts';
import { TranscriptFile, type TranscriptLog } from '../core/transcript.ts';
import { markdownHtml } from '../desk/markdown.ts';
import type { ResearchRunner } from '../legacy/research-runner.ts';
import type { ProjectMemory } from '../core/memory.ts';
import {
  archiveRun,
  listArchives,
  restoreRun,
  validArchiveId,
} from '../core/archive.ts';
// eslint-disable-next-line no-restricted-imports -- old setup flow, replaced in A3 (#282)
import type { SetupBridge } from '../cli/setup-bridge.ts';
import {
  validTaskId,
  type TaskInputFields,
  type TaskManager,
} from '../legacy/tasks.ts';
import { coordinatorContext, type Coordinator } from '../legacy/coordinator.ts';
import { labGpu, type Compute } from '../core/compute.ts';
import { commitId, directionId, proofRef, runId } from '../core/board.ts';
import {
  startLabOn,
  type BringList,
  type Lab,
  type LabView,
} from '../core/lab.ts';
import type { Away, LabDiff, LabWork } from '../desk/desk-lab.ts';
import {
  changeWorkspace,
  loadWorkspace,
  readJson,
  writePrivateFile,
} from '../core/storage.ts';
import { validAgents } from '../core/contracts.ts';
import { startPageServer, type PageServer } from '../legacy/pages.ts';
import { ApiFeed, ApiReader, answerApi } from './api.ts';
import { readJsonBody, record } from './http.ts';

export interface DeskServer {
  /** The desk URL with its access token. Print it, but do not pass it to another process. */
  readonly url: string;
  /** The new app's URL with the same token, or null when the package has no app build. */
  readonly appUrl: string | null;
  /**
   * A URL with a one-time code for a browser launch. Each code works once, for
   * two minutes. `/app/` opens the new app instead of the desk.
   */
  launchUrl(path?: '/' | '/app/'): string;
  /** Switch a setup desk to the project that setup created. */
  attach(
    root: string,
    sessions: SessionPool,
    research: ResearchRunner,
    tasks: TaskManager,
    coordinator: Coordinator,
    compute: Compute,
    memory: ProjectMemory,
    lab?: Lab,
  ): Promise<void>;
  /** The origin of the page server, the only other origin that the desk frames. */
  readonly pages: string;
  readonly closed: Promise<void>;
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
    network: body.network,
  };
}

/** Task actions. Errors that the person can fix are SessionActionError. */
async function taskAction(
  tasks: TaskManager,
  body: Record<string, unknown>,
  coordinator: Coordinator | undefined,
): Promise<void> {
  switch (body.action) {
    case 'task-switch-host': {
      // A task whose start failed can run on the other harness of the team, as the person's revision.
      const task = await tasks.get(body.task);
      if (!task) throw new SessionActionError('That task does not exist.');
      const state = coordinator?.view()?.state;
      const team = state
        ? [state.host, ...(state.helper ? [state.helper] : [])]
        : [];
      const other = team.find((name) => name !== task.assignment.host);
      if (!other)
        throw new SessionActionError(
          'The team has no other harness for this task.',
        );
      const current = task.assignment;
      await tasks.edit(task.id, {
        title: current.title,
        objective: current.objective,
        inputs: current.inputs.map((input) => input.path),
        writable: current.writable,
        output: current.output,
        host: other,
        minutes: current.minutes,
        dependencies: current.dependencies,
        network: current.network,
        reason: `You moved the task to ${hostName(other)} after its start failed.`,
      });
      await tasks.start(task.id);
      return;
    }
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

/** Compute actions. The key and secret values come only in a request body, and no reply or record holds them. */
async function computeAction(
  compute: Compute,
  body: Record<string, unknown>,
): Promise<number> {
  switch (body.action) {
    case 'compute-key-save':
      await compute.setKey(body.key, body.file);
      return 200;
    case 'compute-key-check':
      await compute.checkKey();
      return 200;
    case 'compute-key-remove':
      await compute.removeKey();
      return 200;
    case 'compute-secret-save':
      await compute.setSecret(body.name, body.value, body.file);
      return 200;
    case 'compute-secret-remove':
      await compute.removeSecret(body.secret);
      return 200;
    case 'compute-gpus':
      await compute.refreshGpus();
      return 200;
    case 'compute-settings':
      await compute.saveSettings(body);
      return 200;
    case 'compute-lease-approve':
      await compute.leases.approve(body.lease);
      return 200;
    case 'compute-lease-deny':
      await compute.leases.deny(body.lease);
      return 200;
    case 'compute-lease-stop':
      await compute.leases.stop(body.lease, 'person', 'you stopped it.');
      return 200;
    case 'compute-lease-start':
      await compute.leases.start(body.lease, 'person', 'you started it.');
      return 200;
    case 'compute-lease-end':
      await compute.leases.end(body.lease, 'person', 'you ended it.');
      return 200;
    case 'compute-lease-dismiss':
      await compute.leases.dismiss(body.lease);
      return 200;
    default:
      return 400;
  }
}

/**
 * Draft the plan for another direction. The coordinator stops, and the open
 * tasks of its plan are cancelled. After the work started (`started`), the
 * running turns also stop: their work becomes versions for review. Done work
 * stays in the project, and the results of the earlier direction stay saved.
 */
async function redraft(
  root: string,
  research: ResearchRunner,
  coordinator: Coordinator | undefined,
  tasks: TaskManager | undefined,
  idea: unknown,
  started = false,
): Promise<void> {
  const workspace = await loadWorkspace(root);
  if (
    typeof idea !== 'string' ||
    !workspace.candidates.some((candidate) => candidate.id === idea)
  )
    throw new SessionActionError('Choose a direction from the list.');
  if (idea === workspace.selectedId)
    throw new SessionActionError('The plan already uses this direction.');
  const state = coordinator?.view()?.state;
  if (!started && state && !state.stoppedAt && state.planApproved)
    throw new SessionActionError(
      'The work on the chosen direction already started. Change the direction instead.',
    );
  if (state && !state.stoppedAt) await coordinator?.stop();
  for (const task of (await tasks?.list()) ?? [])
    if (started && task.state === 'running') await tasks?.stop(task.id);
    else if (task.assignment.by === 'coordinator' && task.state === 'open')
      await tasks?.cancel(task.id);
  // One results file holds the chosen direction. A copy keeps the earlier direction's results.
  if (started && workspace.selectedId)
    await copyFile(
      join(root, '.verifold', 'results.json'),
      join(root, '.verifold', `results-${workspace.selectedId}.json`),
    ).catch((error: unknown) => {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    });
  await research.select(idea, true);
}

/** Start a coordinator with an objective, on the project's harness unless the person chose one. In a guided project, its first plan waits for the person. */
async function startCoordinator(
  root: string,
  coordinator: Coordinator,
  objective: unknown,
  host?: unknown,
  model?: unknown,
): Promise<void> {
  const workspace = await loadWorkspace(root);
  await coordinator.start({
    objective,
    host: host ?? workspace.host,
    model: model ?? workspace.model,
    ...(workspace.helper ? { helper: workspace.helper } : {}),
    context: coordinatorContext(workspace),
    guided: workspace.research?.autonomy !== 'autonomous',
  });
}

/** The projects whose run moves now. */
const changing = new Set<string>();

/**
 * Start over, or bring back an archived run. Nothing may run: no research
 * step, no task turn, and no session of the person. The coordinator stops,
 * and the tasks that wait (open or in review) are cancelled, so their
 * sessions end and their task folders go. Then the run moves to the archive,
 * the parts of the owner read their records again, and a new run starts its
 * research from the same question.
 */
async function changeRun(
  root: string,
  sessions: SessionPool,
  research: ResearchRunner | undefined,
  tasks: TaskManager,
  coordinator: Coordinator | undefined,
  memory: ProjectMemory | undefined,
  labRun: Lab | undefined,
  restore?: unknown,
): Promise<void> {
  if (restore !== undefined && !validArchiveId(restore))
    throw new SessionActionError('Choose an archive from Records.');
  // One Start over or restore at a time: a second one would move the records while the first moves them.
  if (changing.has(root))
    throw new SessionActionError(
      'Start over or a restore already runs. Wait for it to end.',
    );
  changing.add(root);
  try {
    await changeRunNow(
      root,
      sessions,
      research,
      tasks,
      coordinator,
      memory,
      labRun,
      restore,
    );
  } finally {
    changing.delete(root);
  }
}

async function changeRunNow(
  root: string,
  sessions: SessionPool,
  research: ResearchRunner | undefined,
  tasks: TaskManager,
  coordinator: Coordinator | undefined,
  memory: ProjectMemory | undefined,
  labRun: Lab | undefined,
  restore?: unknown,
): Promise<void> {
  // A step that checks its input, or chooses a direction for the coordinator, counts as running too.
  if (research?.busy)
    throw new SessionActionError(
      'Research is running. Wait for its step to end, or cancel it first.',
    );
  const list = await tasks.list();
  if (list.some((task) => task.state === 'claimed' || task.state === 'running'))
    throw new SessionActionError(
      'A task turn is running. Stop it first, or wait for its version.',
    );
  if (
    sessions
      .views()
      .some((view) => view.live && !view.record.task && !view.record.agent)
  )
    throw new SessionActionError('Your session is running. End it first.');
  // The lab's agents park and its records reach the disk before they move. A restored lab comes back paused.
  const lab = labRun?.exists ?? false;
  const paused = (await labRun?.suspend()) ?? false;
  try {
    const state = coordinator?.view()?.state;
    if (state && !state.stoppedAt) await coordinator?.stop();
    for (const task of list)
      if (task.state === 'open' || task.state === 'review')
        await tasks.cancel(task.id);
    // The memory keeps what this run did, decided, and found, as an earlier run.
    await memory?.freeze(
      `archived ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    );
    if (restore === undefined) await archiveRun(root);
    else await restoreRun(root, restore);
  } catch (error) {
    // The records moved in part or not at all. The lab reads them again and works as before.
    await labRun?.reload();
    if (paused) await labRun?.resume().catch(() => {});
    throw error;
  }
  memory?.schedule();
  try {
    await coordinator?.reload();
  } finally {
    // The records moved, so the lab is read again even when the coordinator's reload fails.
    await labRun?.reload();
  }
  research?.clear();
  await sessions.forget();
  // A new run starts its research from the question. A restored run continues where it was.
  // After a lab, Home offers the lab again instead.
  if (
    restore === undefined &&
    !lab &&
    research &&
    (await loadWorkspace(root)).research
  )
    await research.start({});
}

/** The lab in a project owner's desk: the lab and the lab actions. */
interface LabDesk {
  lab: Lab | undefined;
  /** Each lab request by its key, for a minute: a request that arrives twice runs once. */
  readonly requests: Map<
    string,
    { readonly status: Promise<number>; readonly at: number }
  >;
  /** The lab actions that run in the background, and the ones that failed there. */
  works: LabWork[];
  /** The person's last look at the lab, loaded once for each lab. */
  look?:
    | { readonly lab: string; readonly loaded: Promise<LabLook> }
    | undefined;
  /** Saves of the look, one after another. */
  saving: Promise<void>;
}

/** A person who comes back to a lab after this long sees on Home what changed. */
const awayMs = 30 * 60_000;

/** A look is saved at most this often. A new time away is saved at once. */
const lookSaveMs = 60_000;

/**
 * The person's last look at a lab, with the header's two costs then, and the
 * time away that Home lists until the person dismisses it. It lives in
 * .verifold/lab/look.json, so it lasts across tabs, browsers, and restarts
 * of Verifold, and Start over archives it with the lab.
 */
interface LabLook {
  /** The start of the lab that it belongs to. */
  readonly lab: string;
  at: number;
  claude: number;
  gpu: number;
  away: Away | null;
  saved: number;
}

const lookPath = (root: string): string =>
  join(root, '.verifold', 'lab', 'look.json');

/** A dollar amount in a saved look, or null. */
function dollars(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** The saved look of this lab, or a new one. A file of another lab or one that is not valid counts as none. */
async function readLook(root: string, lab: string): Promise<LabLook> {
  const fresh: LabLook = {
    lab,
    at: 0,
    claude: 0,
    gpu: 0,
    away: null,
    saved: 0,
  };
  const saved: unknown = await readJson(lookPath(root)).catch(() => null);
  if (!saved || typeof saved !== 'object') return fresh;
  const entry = saved as Record<string, unknown>;
  const at = typeof entry.at === 'string' ? Date.parse(entry.at) : NaN;
  const claude = dollars(entry.claude);
  const gpu = dollars(entry.gpu);
  if (
    entry.lab !== lab ||
    !Number.isFinite(at) ||
    claude === null ||
    gpu === null
  )
    return fresh;
  const away =
    entry.away && typeof entry.away === 'object'
      ? (entry.away as Record<string, unknown>)
      : null;
  const spent =
    away?.spent && typeof away.spent === 'object'
      ? (away.spent as Record<string, unknown>)
      : null;
  const since = typeof away?.since === 'string' ? away.since : '';
  const before = { claude: dollars(spent?.claude), gpu: dollars(spent?.gpu) };
  return {
    ...fresh,
    at,
    claude,
    gpu,
    away:
      Number.isFinite(Date.parse(since)) &&
      before.claude !== null &&
      before.gpu !== null
        ? {
            since: new Date(since).toISOString(),
            spent: { claude: before.claude, gpu: before.gpu },
          }
        : null,
  };
}

/** The look of the lab that the desk shows, loaded once. */
function lookOf(root: string, desk: LabDesk, lab: string): Promise<LabLook> {
  if (desk.look?.lab !== lab) desk.look = { lab, loaded: readLook(root, lab) };
  return desk.look.loaded;
}

/** Save a look after the saves before it. A save that fails leaves the look in memory. */
function saveLook(root: string, desk: LabDesk, look: LabLook): void {
  look.saved = Date.now();
  const body = `${JSON.stringify({
    schemaVersion: 1,
    lab: look.lab,
    at: new Date(look.at).toISOString(),
    claude: look.claude,
    gpu: look.gpu,
    away: look.away,
  })}\n`;
  desk.saving = desk.saving
    .then(() => writePrivateFile(lookPath(root), body))
    .catch(() => {});
}

/**
 * The person looks at the lab's desk now, with the header's two costs. A last
 * look 30 minutes ago or more becomes the time away that Home lists, also
 * when the computer slept with the page open. Returns that time away.
 */
async function noteLook(
  root: string,
  desk: LabDesk,
  view: LabView,
  gpu: number,
): Promise<Away | null> {
  const look = await lookOf(root, desk, view.state.startedAt);
  const now = Date.now();
  const back = look.at > 0 && now - look.at >= awayMs;
  if (back)
    look.away = {
      since: new Date(look.at).toISOString(),
      spent: { claude: look.claude, gpu: look.gpu },
    };
  look.at = now;
  look.claude = view.claudeUsd;
  look.gpu = gpu;
  if (back || now - look.saved >= lookSaveMs) saveLook(root, desk, look);
  return look.away;
}

/** How long a lab request's answer stays for the same request again. */
const labAnswerMs = 60_000;

/**
 * Lab actions that can take long: a new folder, an agent's start, or every
 * agent parking. An action that has not ended after `labWaitMs` goes on in
 * the background, and the lab view shows it and its result.
 */
const slowLabActions: Readonly<Record<string, string>> = {
  'lab-start': 'Starting the lab',
  'lab-direction-add': 'Opening the direction',
  'lab-pause': 'Pausing the lab',
  'lab-resume': 'Resuming the lab',
  'lab-call-answer': 'Applying your answer',
  'lab-call-undo': 'Undoing your answer',
  'lab-bring-look': 'Taking the newest work',
  'lab-bring': 'Bringing in the files',
};
const labWaitMs = 2_000;

/** Actions that make a new folder or take the run: one runs at a time. */
const openingLabActions: ReadonlySet<string> = new Set([
  'lab-start',
  'lab-direction-add',
]);

/** One lab action. The lab checks its input and its state. */
async function labAction(
  root: string,
  lab: Lab,
  body: Record<string, unknown>,
): Promise<number> {
  switch (body.action) {
    case 'lab-start':
      await startLabOn(root, lab, body.question, undefined, body.hours);
      return 200;
    case 'lab-budget':
      await lab.extend(body.hours);
      return 200;
    case 'lab-post':
      await lab.post({
        text: body.text,
        kind: body.kind,
        direction: body.direction,
        replyTo: body.replyTo,
      });
      return 200;
    case 'lab-direction-add':
      await lab.addDirection({
        title: body.title,
        harness: body.harness,
        bar: body.bar,
      });
      return 200;
    case 'lab-direction-stop':
      await lab.stopDirection(body.direction);
      return 200;
    case 'lab-agent-restart':
      await lab.restartAgent(body.agent);
      return 200;
    case 'lab-run-cancel':
      await lab.cancelRun(body.run);
      return 200;
    case 'lab-pause':
      await lab.pause();
      return 200;
    case 'lab-resume':
      await lab.resume();
      return 200;
    case 'lab-call-answer':
      await lab.answerCall(body.call, body.option);
      return 200;
    case 'lab-call-undo':
      await lab.undoCall(body.call);
      return 200;
    case 'lab-call-words':
      await lab.answerCallInWords(body.call, body.text);
      return 200;
    case 'lab-terminal-open':
      if (!validLease(body.lease))
        fail('The desk sent an invalid input lease.');
      await lab.openTerminal(body.agent, body.lease);
      return 200;
    case 'lab-bring-look':
      await lab.lookToBring(body.direction);
      return 200;
    case 'lab-bring':
      await lab.bring(body.direction, body.commit, body.files);
      return 200;
    case 'lab-signoff':
      await lab.signOff(body.note);
      return 200;
    default:
      return 400;
  }
}

function fail(message: string): never {
  throw new SessionActionError(message);
}

/**
 * What the lab's panels read, kept between the page's polls: a session
 * record by the time its file changed, and a diff by its commits.
 */
interface LabReads {
  readonly records: Map<
    string,
    { readonly mtime: number; readonly record: SessionRecord }
  >;
  readonly diffs: Map<string, LabDiff>;
  readonly brings: Map<string, BringList>;
}

/** Keep a cache to its newest 20 entries. */
function keep<T>(cache: Map<string, T>, key: string, value: T): T {
  cache.delete(key);
  cache.set(key, value);
  for (const old of [...cache.keys()].slice(0, -20)) cache.delete(old);
  return value;
}

/**
 * What a direction changed, or the diff that a post cites, for the diff
 * panel. Null when Verifold cannot read it. It reads Git again only when
 * the direction's newest commit moved.
 */
async function labDiff(
  lab: Lab,
  view: LabView,
  direction: string,
  proof: string | undefined,
  reads: LabReads,
): Promise<LabDiff | null> {
  const head =
    view.state.directions.find((entry) => entry.id === direction)?.head ?? '';
  const key = `${direction}|${proof ?? ''}|${head}`;
  const known = reads.diffs.get(key);
  if (known !== undefined) return known;
  const shown = await lab
    .directionDiff(direction, undefined, proof)
    .catch(() => null);
  // A read that failed tries again at the next poll.
  if (!shown) return null;
  return keep(reads.diffs, key, {
    direction,
    proof: proof ?? null,
    from: shown.from,
    to: shown.to,
    files: shown.files,
  });
}

/**
 * The files that a direction can bring in, at the commit that the person
 * looks at, for the bring-in panel, or why Verifold cannot read them. A
 * list is read again only when its commit or the lab's bring-ins change.
 * Null before Verifold took the commit.
 */
async function labBring(
  lab: Lab,
  view: LabView,
  direction: string,
  reads: LabReads,
): Promise<BringList | string | null> {
  const commit = lab.bringCommit(direction);
  if (!commit) return null;
  // The list changes with the bring-ins and with the direction's newest commit, for its newer work.
  const head =
    view.state.directions.find((entry) => entry.id === direction)?.head ?? '';
  const last = view.state.brought.at(-1);
  const key = `${direction}|${commit}|${head}|${view.state.brought.length}|${last?.path ?? ''}|${last?.at ?? ''}`;
  const known = reads.brings.get(key);
  if (known) return known;
  try {
    const list = await lab.bringFiles(direction, commit);
    return list ? keep(reads.brings, key, list) : null;
  } catch (error) {
    return error instanceof Error ? error.message : 'unknown error';
  }
}

/**
 * The session of a lab agent or checker for the agent panel: its slot's
 * view, or its saved record when no slot holds it now. The record is read
 * again only when its file changed. Null before it starts.
 */
async function labSession(
  root: string,
  sessions: SessionPool | undefined,
  view: LabView,
  agent: string | undefined,
  reads: LabReads,
): Promise<SessionView | null> {
  const id =
    view.directions.find((entry) => entry.agent.id === agent)?.agent.session ??
    view.checks.find((check) => check.agent === agent)?.session ??
    null;
  if (!id) return null;
  const known = sessions?.view(id);
  if (known) return known;
  const file = await stat(
    join(root, '.verifold', 'sessions', `${id}.json`),
  ).catch(() => null);
  if (!file) return null;
  const cached = reads.records.get(id);
  const record =
    cached?.mtime === file.mtimeMs ? cached.record : await readRecord(root, id);
  if (!record) return null;
  keep(reads.records, id, { mtime: file.mtimeMs, record });
  return { record, live: false, saveFailed: false };
}

/**
 * One lab request. A request whose key came within the last minute gets the
 * same answer and runs nothing. A slow action that has not ended after
 * `labWaitMs` answers 202 and goes on in the background. A start or an open
 * waits for the one that runs. A pause or a resume never waits: a resume
 * ends the parks of a pause.
 */
async function labRequest(
  desk: LabDesk,
  body: Record<string, unknown>,
  root: string,
): Promise<number> {
  const lab = desk.lab ?? fail('This desk runs no lab.');
  if (!lab.runs)
    fail(
      'This desk runs one session, so the lab only shows here. Run verifold in the project folder to work in the lab.',
    );
  if (body.action === 'lab-dismiss') {
    desk.works = desk.works.filter((work) => work.error === null);
    return 200;
  }
  if (body.action === 'lab-away-dismiss') {
    const view = lab.view();
    if (view) {
      const look = await lookOf(root, desk, view.state.startedAt);
      look.away = null;
      saveLook(root, desk, look);
    }
    return 200;
  }
  const key =
    typeof body.key === 'string' && /^[a-f0-9]{32}$/.test(body.key)
      ? body.key
      : null;
  const now = Date.now();
  for (const [old, entry] of desk.requests)
    if (entry.at < now - labAnswerMs) desk.requests.delete(old);
  const known = key ? desk.requests.get(key) : undefined;
  if (known) return known.status;
  const slow =
    typeof body.action === 'string' ? slowLabActions[body.action] : undefined;
  let status: Promise<number>;
  if (slow) {
    const action = String(body.action);
    const opening = desk.works.find(
      (work) => work.error === null && openingLabActions.has(work.action),
    );
    if (opening && openingLabActions.has(action))
      fail(`${opening.label} still runs. Wait for it to end.`);
    const work: LabWork = {
      action,
      label:
        action === 'lab-direction-add' &&
        typeof body.title === 'string' &&
        body.title.trim()
          ? `Opening ${JSON.stringify(body.title.trim().slice(0, 120))}`
          : slow,
      at: new Date(now).toISOString(),
      error: null,
    };
    // A new try of an action replaces its earlier failure.
    desk.works = [
      ...desk.works.filter(
        (entry) => entry.action !== action || entry.error === null,
      ),
      work,
    ];
    let answered = false;
    const done = labAction(root, lab, body).then(
      (code) => {
        desk.works = desk.works.filter((entry) => entry !== work);
        return code;
      },
      (error: unknown) => {
        // A failure after the 202 shows in the lab. One before it is the answer.
        desk.works = desk.works.flatMap((entry) =>
          entry !== work
            ? [entry]
            : answered
              ? [
                  {
                    ...work,
                    error:
                      error instanceof Error ? error.message : 'Unknown error.',
                  },
                ]
              : [],
        );
        throw error;
      },
    );
    status = Promise.race([
      done,
      new Promise<number>((resolve) =>
        setTimeout(() => resolve(202), labWaitMs).unref(),
      ),
    ]).finally(() => {
      answered = true;
    });
    done.catch(() => {});
  } else status = labAction(root, lab, body);
  if (key) {
    desk.requests.set(key, { status, at: now });
    // A refused request keeps no answer: the same request again tries again.
    status.catch(() => desk.requests.delete(key));
  }
  return status;
}

/** Run one desk action on the project owner. Returns 200, or 400 for an unknown action. */
async function act(
  sessions: SessionPool | undefined,
  research: ResearchRunner | undefined,
  setup: SetupBridge | undefined,
  tasks: TaskManager | undefined,
  coordinator: Coordinator | undefined,
  compute: Compute | undefined,
  root: string,
  body: Record<string, unknown>,
  memory: ProjectMemory | undefined,
  labDesk: LabDesk,
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
      body.action === 'select' ||
      body.action === 'redraft' ||
      body.action === 'change-direction')
  ) {
    if (body.action === 'cancel-research') research.cancel();
    else if (body.action === 'select') await research.select(body.idea);
    else if (body.action === 'redraft' || body.action === 'change-direction')
      await redraft(
        root,
        research,
        coordinator,
        tasks,
        body.idea,
        body.action === 'change-direction',
      );
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
  if (body.action === 'start-over' || body.action === 'restore') {
    if (!tasks) return 400;
    // A save of the last look ends before the lab moves, so no look lands in the next run.
    await labDesk.saving;
    await changeRun(
      root,
      sessions,
      research,
      tasks,
      coordinator,
      memory,
      labDesk.lab,
      body.action === 'restore' ? body.archive : undefined,
    );
    // The lab actions of the earlier run, and their answers, do not belong to this one.
    labDesk.works = [];
    labDesk.requests.clear();
    labDesk.look = undefined;
    return 200;
  }
  if (typeof body.action === 'string' && body.action.startsWith('lab-'))
    return labRequest(labDesk, body, root);
  // The message box: to research, the coordinator, a task agent, or a session that the person started.
  // The words can also start a new coordinator or a new agent.
  if (body.action === 'message') {
    if (body.to === 'new-agent')
      await sessions.start({
        host: body.host,
        mode: body.mode,
        prompt: body.text,
      });
    else if (typeof body.to === 'string' && body.to.startsWith('session:')) {
      const id = body.to.slice('session:'.length);
      if (sessions.view(id)?.record.task)
        throw new SessionActionError('Write to a task agent by its task.');
      if (sessions.view(id)?.record.agent)
        throw new SessionActionError('Write to a lab agent on the board.');
      const text = typeof body.text === 'string' ? body.text : '';
      // A running turn takes the message. A waiting session, or a turn that ended first, gets it as its next turn.
      if (
        !sessions.steer(id, text, (taken) => {
          try {
            if (!taken && sessions.idle(id)) sessions.send(id, text);
          } catch {
            /* The session ended. Its record shows the message that it did not take. */
          }
        })
      )
        sessions.send(id, text);
    } else if (body.to === 'new-coordinator') {
      if (!coordinator)
        throw new SessionActionError('This desk runs no coordinator.');
      await startCoordinator(root, coordinator, body.text);
    } else if (body.to === 'research') {
      if (!research)
        throw new SessionActionError('Research takes no messages here.');
      await research.message(body.text);
    } else if (tasks) await tasks.post(body.to, body.text);
    else return 400;
    return 200;
  }
  if (
    tasks &&
    typeof body.action === 'string' &&
    body.action.startsWith('task-')
  ) {
    await taskAction(tasks, body, coordinator);
    return 200;
  }
  if (body.action === 'compute-agents') {
    const agents = body.agents;
    if (!validAgents(agents))
      throw new SessionActionError(
        'Choose a whole number of agents from 1 to 8.',
      );
    await changeWorkspace(root, (current) => {
      if (!current) throw new SessionActionError('The project has no record.');
      return { ...current, agents };
    });
    // A lower limit stops no agent. New starts wait until fewer run.
    sessions.limit = agents;
    return 200;
  }
  if (
    compute &&
    typeof body.action === 'string' &&
    body.action.startsWith('compute-')
  )
    return computeAction(compute, body);
  if (
    coordinator &&
    tasks &&
    typeof body.action === 'string' &&
    body.action.startsWith('coordinator-')
  ) {
    switch (body.action) {
      case 'coordinator-start':
        await startCoordinator(
          root,
          coordinator,
          body.objective,
          body.host,
          body.model,
        );
        return 200;
      case 'coordinator-approve':
        await coordinator.approvePlan(
          Array.isArray(body.extras) ? body.extras : [],
        );
        return 200;
      case 'coordinator-stop':
        await coordinator.stop();
        return 200;
      case 'coordinator-resume':
        await coordinator.resume();
        return 200;
      case 'coordinator-rule':
        await coordinator.ruleCheck(body.check, body.result, body.reason);
        return 200;
      case 'coordinator-answer':
        await coordinator.decideAnswer(body.decision, body.note);
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
 * `stop` stops Verifold from the desk. `reuse` keeps the port and access token
 * of a desk that another process closed, so its open tab keeps working.
 */
export async function startDesk(
  root: string | null,
  signal: AbortSignal,
  assetsRoot: URL = new URL('../desk/', import.meta.url),
  sessions?: SessionPool,
  research?: ResearchRunner,
  setup?: SetupBridge,
  tasks?: TaskManager,
  coordinator?: Coordinator,
  compute?: Compute,
  memory?: ProjectMemory,
  options: {
    readonly stop?: () => void;
    /** The lab of the project owner. */
    readonly lab?: Lab;
    readonly reuse?:
      | {
          readonly port: number;
          readonly token: string;
          /** The page server's port, which the open tab's CSP allows. */
          readonly pages?: number | undefined;
        }
      | undefined;
    /** How often the API's stream builds the snapshot, and sends a heartbeat. Tests set them short. */
    readonly api?: { readonly pollMs?: number; readonly heartbeatMs?: number };
    /** The new app's build: index.html and assets/. Without one, /app/ is not served. */
    readonly appRoot?: URL;
  } = {},
): Promise<DeskServer> {
  signal.throwIfAborted();
  // In setup mode the project does not exist yet. attach() sets it.
  let project: string | null = root === null ? null : await realpath(root);
  const labDesk: LabDesk = {
    lab: options.lab,
    requests: new Map(),
    works: [],
    saving: Promise.resolve(),
  };
  const labReads: LabReads = {
    records: new Map(),
    diffs: new Map(),
    brings: new Map(),
  };
  // The API reads the desk's current project, so a setup desk serves the project once attach() sets it.
  const apiReader = new ApiReader(() => ({
    root: project,
    lab: labDesk.lab,
    compute,
    session: (id) => sessions?.view(id) ?? null,
    works: labDesk.works,
    away: async () => {
      const view = labDesk.lab?.view();
      return project && view
        ? (await lookOf(project, labDesk, view.state.startedAt)).away
        : null;
    },
  }));
  const apiFeed = new ApiFeed(apiReader, options.api);
  if (project) await readDeskSnapshot(project);
  const token = options.reuse?.token ?? randomBytes(32).toString('hex');
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
    ['/desk-map.js', 'desk-map.js', 'text/javascript; charset=utf-8'],
    ['/desk-motion.js', 'desk-motion.js', 'text/javascript; charset=utf-8'],
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
    [
      '/vendor/idiomorph.js',
      'vendor/idiomorph.js',
      'text/javascript; charset=utf-8',
    ],
  ] as const) {
    assets.set(path, { type, body: await readFile(new URL(file, assetsRoot)) });
  }
  const app = await readAppBuild(
    options.appRoot ?? new URL('../app/', import.meta.url),
  );
  for (const [path, asset] of app) assets.set(path, asset);
  let origin = '';
  // Agents' pages run on their own origin. The desk may frame only that one.
  let pages: PageServer | undefined;
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
    // blob: images: the page draws its tab icon. Only a script of the page can make a blob URL.
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; frame-src 'self'${pages ? ` ${pages.origin}` : ''}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
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
    if (url.pathname.startsWith('/api/v1/')) {
      await answerApi(
        request,
        response,
        url,
        authorized,
        apiFeed,
        apiReader,
        (body) =>
          act(
            sessions,
            research,
            setup,
            tasks,
            coordinator,
            compute,
            project ?? '',
            body,
            memory,
            labDesk,
          ),
      );
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
      // Stop answers first, because the desk closes with Verifold.
      if (record(body) && body.action === 'stop' && options.stop) {
        response
          .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ ok: true }), options.stop);
        return;
      }
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
            compute,
            project ?? '',
            body,
            memory,
            labDesk,
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
          JSON.stringify(
            status === 200
              ? { ok: true }
              : // A slow lab action goes on in the background, and the lab view shows how it ends.
                status === 202
                ? { ok: true, pending: true }
                : { error: message },
          ),
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
    if (url.pathname === '/api/page') {
      if (!authorized) {
        response.writeHead(401).end();
        return;
      }
      const id = url.searchParams.get('task');
      const number = Number(url.searchParams.get('version'));
      const file = url.searchParams.get('file') ?? '';
      if (
        !pages ||
        !tasks ||
        !validTaskId(id) ||
        !Number.isSafeInteger(number) ||
        number < 1 ||
        !/\.html?$/i.test(file) ||
        file.length > 300 ||
        [...url.searchParams.keys()].some(
          (key) => !['task', 'version', 'file'].includes(key),
        )
      ) {
        response.writeHead(400).end();
        return;
      }
      response
        .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ url: pages.grant(id, number, file) }));
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
    if (url.pathname === '/api/run-log') {
      if (!authorized) {
        response.writeHead(401).end();
        return;
      }
      const run = url.searchParams.get('run') ?? '';
      if (
        !runId.test(run) ||
        [...url.searchParams.keys()].some((key) => key !== 'run')
      ) {
        response.writeHead(400).end();
        return;
      }
      const log = await labDesk.lab?.runLog(run);
      if (!log) {
        response.writeHead(404).end();
        return;
      }
      response
        .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify(log));
      return;
    }
    if (url.pathname === '/api/lab-diff') {
      if (!authorized) {
        response.writeHead(401).end();
        return;
      }
      const direction = url.searchParams.get('direction') ?? '';
      const file = url.searchParams.get('file') ?? '';
      const proof = url.searchParams.get('proof');
      // The commit of a bring-in that the person looks at.
      const bring = url.searchParams.get('bring');
      const keys = ['direction', 'file', 'proof', 'bring'];
      if (
        !directionId.test(direction) ||
        !file ||
        file.length > 300 ||
        (proof !== null && !proofRef(proof)) ||
        (bring !== null && (!commitId.test(bring) || proof !== null)) ||
        [...url.searchParams.keys()].some((key) => !keys.includes(key)) ||
        keys.some((key) => url.searchParams.getAll(key).length > 1)
      ) {
        response.writeHead(400).end();
        return;
      }
      try {
        const shown = await labDesk.lab?.directionDiff(
          direction,
          file,
          proof ?? undefined,
          bring ?? undefined,
        );
        if (!shown?.diff) {
          response.writeHead(404).end();
          return;
        }
        response
          .writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
          })
          .end(JSON.stringify({ ...shown.diff, to: shown.to }));
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
    const frame = parseFrame(
      url.searchParams.get('view'),
      url.searchParams.get('panel'),
      url.searchParams.get('since'),
      url.searchParams.get('direction'),
      url.searchParams.get('finished'),
      url.searchParams.get('run'),
      url.searchParams.get('agent'),
      url.searchParams.get('proof'),
      url.searchParams.get('q'),
    );
    // The page sends look=1 while the person can see it.
    const look = url.searchParams.get('look');
    const keys = [
      'attempt',
      'task',
      'worker',
      'view',
      'panel',
      'since',
      'direction',
      'finished',
      'run',
      'agent',
      'proof',
      'q',
      'look',
    ];
    if (
      (selected !== undefined && !validAttemptId(selected)) ||
      (chosenTask !== undefined && !validTaskId(chosenTask)) ||
      (chosenWorker !== undefined && !validSessionId(chosenWorker)) ||
      !frame ||
      (look !== null && look !== '1') ||
      [...url.searchParams.keys()].some((key) => !keys.includes(key)) ||
      keys.some((key) => url.searchParams.getAll(key).length > 1)
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
      // Without a task ID the panel shows the newest task, so a task that the person just created opens.
      const task = chosenTask
        ? taskList.find((entry) => entry.id === chosenTask)
        : taskList.at(-1);
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
      // Lab agents belong to the lab view. The person reaches them on the board.
      const workers = (sessions?.views() ?? []).filter(
        (view) => !view.record.agent,
      );
      // A version in review whose agent paused when Verifold stopped can still get changes.
      const resumable: string[] = [];
      for (const entry of taskList) {
        const session = entry.attempts.at(-1)?.session;
        if (
          entry.state === 'review' &&
          session &&
          sessions &&
          !sessions.idle(session) &&
          (await sessions.canResume(session))
        )
          resumable.push(session);
      }
      // A worker that left its slot falls back to the newest live one, then to the first.
      // So a session that the person just started or resumed opens.
      const worker =
        workers.find((view) => view.record.id === chosenWorker) ??
        workers
          .filter((view) => view.live)
          .sort((a, b) => b.record.startedAt.localeCompare(a.record.startedAt))
          .at(0) ??
        workers[0] ??
        null;
      const labView = labDesk.lab?.view() ?? null;
      // The lab's owner keeps the person's last look. A desk of one session only shows the lab.
      const gpu =
        labView && compute
          ? labGpu(compute.view(), labView.state.startedAt).spent
          : 0;
      const labAway =
        labView && labDesk.lab?.runs
          ? look === '1'
            ? await noteLook(root, labDesk, labView, gpu)
            : (await lookOf(root, labDesk, labView.state.startedAt)).away
          : null;
      const live: Parameters<typeof renderDesk>[3] = {
        workers,
        session: worker,
        // The lab's depth reads only for the panel that is open.
        ...(labView && frame.panel === 'agent'
          ? {
              labAgent: await labSession(
                root,
                sessions,
                labView,
                frame.agent,
                labReads,
              ),
            }
          : {}),
        ...(labDesk.lab && labView && frame.panel === 'diff' && frame.direction
          ? {
              labDiff: await labDiff(
                labDesk.lab,
                labView,
                frame.direction,
                frame.proof,
                labReads,
              ),
            }
          : {}),
        ...(labDesk.lab && labView && frame.panel === 'bring' && frame.direction
          ? {
              labBring: await labBring(
                labDesk.lab,
                labView,
                frame.direction,
                labReads,
              ),
            }
          : {}),
        // A lab agent that had its turn gives its slot to the person's session, so the pool is not full for them.
        full: (sessions?.full ?? false) && !(labDesk.lab?.canYield() ?? false),
        ...(sessions ? { agents: sessions.limit } : {}),
        terminals: await terminalSupport(),
        controllable: sessions !== undefined,
        paused: sessions?.paused() ?? [],
        ...(research ? { research: research.view() } : {}),
        ...(coordinator ? { coordinator: coordinator.view() } : {}),
        ...(compute ? { compute: compute.view() } : {}),
        ...(labDesk.lab
          ? {
              lab: labView,
              labAway,
              labWorks: labDesk.works,
              // The offer shows when the run's guard would let a lab start here: the same records, read once for this view.
              labCanStart:
                labDesk.lab.runs &&
                !labDesk.lab.exists &&
                !coordinator?.view()?.state &&
                !taskList.length &&
                !(research?.busy ?? false),
            }
          : {}),
        ...(tasks ? { archives: await listArchives(root) } : {}),
        ...(tasks
          ? {
              tasks: {
                list: taskList,
                selected: task ?? null,
                idle: workers
                  .filter((view) => sessions?.idle(view.record.id))
                  .map((view) => view.record.id),
                resumable,
                messages: (await tasks.messageList()).slice(-300),
              },
            }
          : {}),
      };
      const render = (shown: NonNullable<typeof frame>): string =>
        JSON.stringify(renderDesk(snapshot, selected, report, live, shown));
      let body = render(frame);
      // A panel that would make the view too big closes, so the view still loads.
      if (Buffer.byteLength(body) > 2_000_000 && frame.panel)
        body = render({ ...frame, panel: null });
      if (Buffer.byteLength(body) > 2_000_000)
        throw new Error('Desk view exceeds its output limit.');
      response
        .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(body);
    } finally {
      pending--;
    }
  }

  const listen = async (port: number): Promise<void> => {
    const listening = once(server, 'listening');
    server.listen(port, '127.0.0.1');
    await listening;
  };
  // Another program can take the port of a closed desk first. Then the desk gets a new port.
  await listen(options.reuse?.port ?? 0).catch(() => listen(0));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not start the local desk.');
  }
  origin = `http://127.0.0.1:${address.port}`;
  try {
    pages = await startPageServer(
      origin,
      (task, version, path) =>
        tasks?.readPageFile(task, version, path) ?? Promise.resolve(null),
      signal,
      options.reuse?.pages,
    );
  } catch (error) {
    server.close();
    throw error;
  }
  const stop = (): void => {
    apiFeed.close();
    server.closeAllConnections();
    server.close();
  };
  // The desk closes after the last save of the person's look.
  const closed = once(server, 'close').then(async () => {
    signal.removeEventListener('abort', stop);
    await labDesk.saving;
  });
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  return {
    url: `${origin}/#${token}`,
    appUrl: app.size ? `${origin}/app/#${token}` : null,
    launchUrl: (path = '/') => {
      for (const [code, expires] of launchCodes)
        if (expires <= Date.now()) launchCodes.delete(code);
      const code = randomBytes(24).toString('hex');
      launchCodes.set(code, Date.now() + 120_000);
      return `${origin}${path === '/app/' && app.size ? path : '/'}#launch-${code}`;
    },
    attach: async (
      next,
      owner,
      runner,
      taskManager,
      lead,
      pods,
      notes,
      labOwner,
    ) => {
      const resolved = await realpath(next);
      await readDeskSnapshot(resolved);
      sessions = owner;
      research = runner;
      tasks = taskManager;
      coordinator = lead;
      compute = pods;
      memory = notes;
      labDesk.lab = labOwner;
      project = resolved;
    },
    pages: pages.origin,
    closed,
  };
}

const appTypes: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/**
 * The new app's files, by URL path: its page at /app and /app/, and the
 * hashed files that the build wrote to assets/. An empty map when the app
 * was not built, as in tests that pass their own desk assets.
 */
async function readAppBuild(
  root: URL,
): Promise<Map<string, { type: string; body: Buffer }>> {
  const files = new Map<string, { type: string; body: Buffer }>();
  let page: Buffer;
  let names: string[];
  try {
    page = await readFile(new URL('index.html', root));
    names = await readdir(new URL('assets/', root));
  } catch {
    return files;
  }
  for (const path of ['/app', '/app/'])
    files.set(path, { type: 'text/html; charset=utf-8', body: page });
  for (const name of names) {
    const type = appTypes[extname(name)];
    if (type && /^[\w.-]+$/.test(name))
      files.set(`/app/assets/${name}`, {
        type,
        body: await readFile(new URL(`assets/${name}`, root)),
      });
  }
  return files;
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
