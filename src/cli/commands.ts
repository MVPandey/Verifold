import { loadPrompt } from './prompts.ts';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { resolve, join } from 'node:path';
import { writeFile, rename, rm, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { escapeHtml as e } from '../ui/dom.ts';
import { parseCandidates } from './contracts.ts';
import type { Workspace } from './contracts.ts';
import { changeWorkspace, loadWorkspace, readJson } from './storage.ts';
import {
  initializeProject,
  parseAutonomy,
  type InitializationOptions,
} from './initialization.ts';
import { choose } from './choices.ts';
import {
  reconcileAttempts,
  runResearch,
  selectIdea,
  type ResearchOptions,
} from './research.ts';
import { ResearchRunner } from './research-runner.ts';
import { object, text } from './research-contracts.ts';
import type { Choice } from './choices.ts';
import { runHarness } from './harness.ts';
import { nextResearchAction } from './desk-view.ts';
import { startDesk, openDeskBrowser, type DeskServer } from './desk.ts';
import { SetupBridge } from './setup-bridge.ts';
import { TaskManager } from './tasks.ts';
import { SessionPool } from './workers.ts';
import { Coordinator } from './coordinator.ts';
import { withTranscript } from './transcript.ts';
import { ensureGlobalProfile, profileCommand } from './profile.ts';
import { agencyDirectory } from './agency.ts';
import {
  hostName,
  reconcileSessions,
  SessionActionError,
  SessionManager,
  type SessionEvent,
} from './session.ts';
import { claimOwner } from './owner.ts';
/** How a view can show a question. The terminal shows only the question text. */
export type AskHint =
  | { readonly kind: 'confirm'; readonly yes: string; readonly no: string }
  | {
      readonly kind: 'text';
      /** The question for a view with buttons, without terminal keys and commands. */
      readonly label?: string;
      readonly multiline?: boolean;
      readonly placeholder?: string;
      /** Buttons that answer with a fixed value, for example an empty answer. */
      readonly actions?: readonly {
        readonly label: string;
        readonly value: string;
      }[];
    };

/** A decision about a draft brief. */
export type BriefDecision =
  | { readonly action: 'accept' }
  | { readonly action: 'feedback'; readonly text: string }
  | { readonly action: 'edit'; readonly brief: string }
  | { readonly action: 'cancel' };

/** The setup steps, in order. */
export type SetupStep =
  | 'Connect'
  | 'Profile'
  | 'Project'
  | 'Interview'
  | 'Research mode';

export interface CliIO {
  readonly interactive: boolean;
  readonly ask: (question: string, hint?: AskHint) => Promise<string>;
  readonly out: (value: string) => void;
  /** `agent`: text from the harness. `tool`: a harness event that Verifold observed. */
  readonly progress?: (value: string, source?: 'agent' | 'tool') => void;
  /** Review a draft brief with direct editing. Only the desk provides it. */
  readonly review?: (brief: string, final: boolean) => Promise<BriefDecision>;
  /** Mark the current setup step for a view that shows it. */
  readonly step?: (name: SetupStep) => void;
  /** Open a desk URL in a browser. Tests replace it. The default is the system browser. */
  readonly browse?: (url: string, signal: AbortSignal) => Promise<boolean>;
  /** The folder of desk page files. Tests use fixtures. The default is the installed package. */
  readonly deskAssets?: URL;
  readonly select?: (
    question: string,
    choices: readonly Choice[],
    initial: string,
  ) => Promise<string>;
  readonly busy?: <T>(label: string, work: () => Promise<T>) => Promise<T>;
  /** Read terminal lines until the signal aborts. Only an interactive terminal provides it. */
  readonly listen?: (
    onLine: (line: string) => void,
    signal: AbortSignal,
  ) => void;
}
const help = `Verifold - private research with your existing agent harness

verifold [--no-open]                  Set up a project or open its research desk
verifold init [--host claude|codex] [--topic field] [--autonomy guided|autonomous]
verifold init --setup-only [--profile profile.json] [--host name]
verifold research [--topic field] [--feedback text] [--approve] [--autonomy guided|autonomous]
verifold recommend                    Print a research request for your host
verifold ideas --from ideas.json       Import host recommendations
verifold select [--id idea-id]         Choose an idea explicitly
verifold literature [--memory]        Print an optional paper/context request
verifold handoff                      Print a planning request for your harness (older flow)
verifold view                         Generate a private local HTML workspace
verifold ui [--no-open]               Open the live research desk and control a harness session there
verifold session --prompt text [--host claude|codex] [--mode ask|auto] [--model name] [--no-open]
                                      Run one harness session; answer its requests here or on the desk
verifold status                       Print workspace JSON
verifold profile [--setup]            Inspect or configure your global profile

Options: --workspace path (default: current directory), --help, --version
Init connects your harness and profile, then asks for a project directory and context.
Your harness drafts a research brief for review before project creation.
Creates literature/, experiments/, results/, figures/, docs/, agents/, and .verifold.md.
Use --model for a host model; --setup-only offers optional reusable research memory.
Use --agency-dir path to isolate preferences and USER.md (default: ~/.verifold/agency).
No name or external profile links are required. Noninteractive research requires --host, --topic,
and --autonomy autonomous. Use --setup-only to initialize without research.
The harness searches web sources and proposes ideas. PDF retention is optional
and follows idea selection. No experiments run during initial research.
Research stays private in .verifold/. The host owns its permissions and sessions.
While the desk runs, type /help in its terminal for the commands there.
Ctrl+C pauses a running session. Session records are in .verifold/sessions/.
`;

const terminalHelp = `Commands in this terminal:
- \`/open\`: open the desk in your browser.
- \`/start\` and a request: start a session with the project's harness in Ask me mode.
- \`/resume\`: resume the latest paused or interrupted session. Without a recorded conversation, its first request runs again.
- \`/research\`: continue research. In a project without research, add the question.
- \`/approve\`: approve the research plan.
- \`/feedback\` and your changes: revise the plan or the directions.
- \`/select\` and a direction ID: choose a direction. This locks it.
- \`a\` or \`d\`: allow once or deny the open request. If several are open, add the ID, for example \`a R2\`.
- \`/cancel\`: stop the research step or the current turn. If both run, choose in the desk.
- \`/end\`: end the session.
- \`/help\`: show these commands.

When the agent waits for you, other text goes to it as a follow-up. Ctrl+C pauses the session and stops Verifold.`;

const requestHint =
  'Type a to allow once or d to deny. The desk shows the full request.';

const feedLabels: Record<SessionEvent['kind'], string> = {
  you: 'you',
  agent: 'agent says',
  tool: 'Verifold saw',
  request: 'needs you',
  decision: 'decision',
  status: 'status',
  notice: 'notice',
};

/**
 * One terminal line for a session event. Harness tool events stay in the desk,
 * so they have none. `worker` names the session when two can run.
 */
export function feedLine(event: SessionEvent, worker?: string): string | null {
  if (event.kind === 'tool') return null;
  const time = new Date(event.at).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  // One line for each event, so harness text cannot print a line that looks like a request.
  const line = event.text.replace(/\s*\n\s*/g, ' ⏎ ');
  const text =
    event.kind === 'agent' && line.length > 600
      ? `${line.slice(0, 600)}…`
      : line;
  return `${time}  ${worker ? `${worker} · ` : ''}${feedLabels[event.kind]}: ${text}${event.kind === 'request' ? `\n${requestHint}` : ''}`;
}

/** What the owner terminal can do besides session actions. */
export interface TerminalControls {
  /** Open the desk in a browser with a new one-time code. */
  readonly open: () => void;
  /** The harness for a session that the terminal starts. */
  readonly host: string;
  readonly research?: ResearchRunner;
}

/** Terminal controls call the same session operations as the desk. */
export function terminalInput(
  sessions: SessionPool,
  line: string,
  io: CliIO,
  controls: TerminalControls,
): void {
  const value = line.trim();
  if (!value) return;
  const live = sessions.views().filter((view) => view.live);
  const requests = live.flatMap((view) => view.record.requests);
  /** The one live session that fits, or a message that names where to act. */
  const only = (
    fits: (view: (typeof live)[number]) => boolean,
    none: string,
  ): string | null => {
    const found = live.filter(fits);
    if (found.length === 1) return found[0]?.record.id ?? null;
    io.progress?.(
      found.length
        ? `${found.length} sessions match. Use the desk to choose one.`
        : none,
    );
    return null;
  };
  const answer = /^([ad])(?:\s+(r\d+))?$/i.exec(value);
  const report = (error: unknown): void =>
    io.progress?.(
      error instanceof SessionActionError
        ? error.message
        : 'The terminal action failed. Use the desk to check the session.',
    );
  try {
    if (answer) {
      // Without an ID, answer only when one request is open, so the answer matches what the person read.
      const id = answer[2]?.toUpperCase();
      const request = id
        ? requests.find((entry) => entry.id === id)
        : requests.length === 1
          ? requests[0]
          : undefined;
      if (request)
        sessions.answer(request.id, answer[1]?.toLowerCase() === 'a');
      else
        io.progress?.(
          requests.length > 1
            ? `${requests.length} requests are open. Add the ID, for example ${answer[1] ?? 'a'} ${requests[0]?.id ?? 'R1'}.`
            : id
              ? `${id} is not open.`
              : 'No request is open. Type /help for the terminal commands.',
        );
    } else if (value === '/open') controls.open();
    else if (value === '/help') io.progress?.(terminalHelp);
    else if (value === '/cancel') {
      const turns = live.filter((view) => view.record.status !== 'idle');
      // Research and a turn can run together. Then the desk chooses which one stops.
      if (controls.research?.running && turns.length)
        io.progress?.(
          `Research and ${turns.length === 1 ? 'a session' : `${turns.length} sessions`} run. Use the desk to choose what to cancel.`,
        );
      else if (controls.research?.running) controls.research.cancel();
      else {
        const id = only(
          (view) => view.record.status !== 'idle',
          'Nothing is running.',
        );
        if (id) sessions.cancel(id);
      }
    } else if (
      controls.research &&
      /^\/(research|approve|feedback|select)(\s|$)/.test(value)
    ) {
      const [command = '', ...rest] = value.split(/\s+/);
      const text = rest.join(' ');
      const research = controls.research;
      (command === '/select'
        ? research.select(text)
        : research.start(
            command === '/approve'
              ? { approve: true }
              : command === '/feedback'
                ? { feedback: text }
                : text
                  ? { topic: text }
                  : {},
          )
      ).catch(report);
    } else if (value === '/end') {
      const id = only((view) => !view.record.task, 'No session is running.');
      if (id) sessions.end(id);
    } else if (value === '/resume') {
      const latest = sessions.paused()[0];
      if (latest)
        (latest.restart
          ? sessions.restart(latest.id)
          : sessions.resume(latest.id)
        ).catch(report);
      else io.progress?.('No session is paused. Type /start and a request.');
    } else if (value === '/start' || value.startsWith('/start '))
      sessions
        .start({ host: controls.host, mode: 'ask', prompt: value.slice(6) })
        .catch(report);
    else if (value.startsWith('/'))
      io.progress?.(`${value.split(/\s/)[0]} is not a command. Type /help.`);
    else if (live.some((view) => !view.record.task)) {
      const id = only(
        (view) => !view.record.task && view.record.status === 'idle',
        'The session is working. Wait for the turn to end, or type /cancel.',
      );
      if (id) sessions.send(id, value);
    } else
      io.progress?.(
        'No session is running, so this text went nowhere. Type /start and a request, or type /open and start a session in the desk.',
      );
  } catch (error) {
    report(error);
  }
}

async function packageVersion(): Promise<string> {
  const metadata = object(
    await readJson(
      fileURLToPath(new URL('../../package.json', import.meta.url)),
    ),
  );
  return text(metadata.version, 'package version', 100);
}

function showWorkspace(root: string, workspace: Workspace, io: CliIO): void {
  if (!io.interactive) {
    io.out(JSON.stringify(workspace));
    return;
  }
  const next = nextResearchAction(workspace).instruction;
  io.out(
    stripVTControlCharacters(
      `Private workspace: ${root}\nHarness: ${workspace.host} (${workspace.model ?? 'host default model'})\n${next}`,
    ),
  );
}

/**
 * Serve the desk with a session owner. With `session`, start that session and
 * return when it ends. Otherwise serve until the CLI is cancelled.
 */
async function serveDesk(
  root: string,
  noOpen: boolean,
  io: CliIO,
  signal: AbortSignal,
  research?: ResearchOptions,
  session?: Parameters<SessionPool['start']>[0],
  harness: typeof runHarness = runHarness,
  setup?: { readonly cwd: string; readonly options: InitializationOptions },
): Promise<void> {
  const version = await packageVersion();
  const stop = new AbortController();
  const deskSignal = AbortSignal.any([signal, stop.signal]);
  let desk: DeskServer | undefined;
  const open = async (): Promise<boolean> =>
    desk ? (io.browse ?? openDeskBrowser)(desk.launchUrl(), deskSignal) : false;
  const announce = async (server: DeskServer, ready: string): Promise<void> => {
    io.out(
      JSON.stringify({
        url: server.url,
        visibility: 'private',
        readOnly: false,
      }),
    );
    if (noOpen)
      io.progress?.(
        'Open the printed URL to use the desk. Keep this terminal open. Type /help for commands.',
      );
    else if (await open()) io.progress?.(ready);
    else
      io.progress?.(
        'The browser could not open. Open the printed URL, or type /open to try again.',
      );
  };
  try {
    if (setup) {
      // The same desk shows setup first, then the project that setup creates.
      const bridge = new SetupBridge(io, signal);
      desk = await startDesk(
        null,
        deskSignal,
        io.deskAssets,
        undefined,
        undefined,
        bridge,
      );
      await announce(
        desk,
        'Set up your project in the desk. This terminal shows each step. Ctrl+C cancels setup.',
      );
      const initialized = await bridge.run((setupIo) =>
        initializeProject(
          root,
          setup.cwd,
          setup.options,
          setupIo,
          signal,
          withTranscript(harness, bridge.transcript),
        ),
      );
      root = initialized.root;
      research = initialized.research ?? undefined;
      io.progress?.(`Setup is complete. The project is in ${root}.`);
    }
    const host =
      (await loadWorkspace(root)).host === 'codex' ? 'codex' : 'claude';
    // Only one process owns the project. A second one stops here.
    const owner = await claimOwner(root, version);
    try {
      await recover(root, owner.ownerId, io);
      let finished = (): void => {};
      const done = new Promise<void>((resolve) => {
        finished = resolve;
      });
      // The workers report task turns to the tasks, which use the workers.
      // Task events wake the coordinator, which uses the tasks.
      const owned: {
        tasks?: TaskManager;
        coordinator?: Coordinator;
        session?: string;
      } = {};
      const sessions: SessionPool = new SessionPool(root, {
        clientVersion: version,
        ownerId: owner.ownerId,
        onTaskTurn: (task, turn, detail, reply) =>
          void owned.tasks
            ?.turnEnded(task, turn, detail, reply)
            .catch(() =>
              io.progress?.(
                `Verifold could not save the version of ${task.id}. Check .verifold/tasks/.`,
              ),
            ),
        onEvent: (event, view) => {
          const line = io.interactive
            ? feedLine(
                event,
                view
                  ? `${hostName(view.record.host)}${view.record.task ? ` ${view.record.task.id}` : ''}`
                  : undefined,
              )
            : null;
          if (line) io.progress?.(line);
          // The session that `verifold session` started decides when this command ends.
          if (!owned.session || view?.record.id !== owned.session) return;
          const { status } = view.record;
          if (status === 'ended' || status === 'failed' || status === 'paused')
            finished();
          // Without a terminal, requests wait for the desk and the session ends after one turn.
          else if (!io.interactive && status === 'idle')
            sessions.end(
              owned.session,
              'The turn ended, so the noninteractive session ended.',
            );
        },
      });
      const runner = new ResearchRunner(root, {
        signal,
        io,
        harness,
        // A chosen direction starts the coordinator.
        onSelect: async () =>
          owned.coordinator?.startForDirection(await loadWorkspace(root)),
      });
      const tasks = new TaskManager(root, {
        ownerId: owner.ownerId,
        sessions,
        ...(io.progress ? { progress: io.progress } : {}),
        onEvent: (event) => owned.coordinator?.notify(event),
      });
      owned.tasks = tasks;
      // The coordinator has its own session, outside the worker slots.
      const coordinator = new Coordinator(root, {
        tasks,
        sessions: new SessionManager(root, {
          clientVersion: version,
          ownerId: owner.ownerId,
          onTurnEnd: (record) => owned.coordinator?.turnEnded(record),
        }),
      });
      owned.coordinator = coordinator;
      try {
        await sessions.load();
        await coordinator.load();
        const stopped = await tasks.settle();
        if (stopped)
          io.progress?.(
            `Verifold stopped earlier while ${stopped === 1 ? 'a task was' : `${stopped} tasks were`} running. Review the saved work in the desk.`,
          );
        // Start the session first, so invalid input fails before a desk opens.
        if (session) owned.session = await sessions.start(session);
        if (desk) await desk.attach(root, sessions, runner, tasks, coordinator);
        else {
          desk = await startDesk(
            root,
            deskSignal,
            io.deskAssets,
            sessions,
            runner,
            undefined,
            tasks,
            coordinator,
          );
          await announce(
            desk,
            'The desk is open in your browser. Keep this terminal open. Type /help for commands.',
          );
        }
        const paused = sessions.paused().length;
        if (paused && !session)
          io.progress?.(
            `${paused === 1 ? '1 session is' : `${paused} sessions are`} paused. Type /resume or resume one in the desk.`,
          );
        const lead = coordinator.view();
        if (lead?.session && !lead.session.live && !lead.state.stoppedAt)
          io.progress?.(
            'The coordinator paused when Verifold stopped. Resume it under Coordinator in the desk.',
          );
        if (research) await runner.start(research);
        io.listen?.(
          (line) =>
            terminalInput(sessions, line, io, {
              host,
              research: runner,
              open: () => {
                void open().then((opened) =>
                  io.progress?.(
                    opened
                      ? 'The desk opened in your browser.'
                      : 'The browser could not open. Open the printed URL.',
                  ),
                );
              },
            }),
          deskSignal,
        );
        if (session) {
          if (io.interactive) io.progress?.(terminalHelp);
          await Promise.race([done, desk.closed]);
          const record = owned.session
            ? sessions.view(owned.session)?.record
            : undefined;
          if (record && !io.interactive)
            io.out(
              JSON.stringify({
                session: record.id,
                status: record.status,
                commands: record.commands.length,
                record: join(
                  root,
                  '.verifold',
                  'sessions',
                  `${record.id}.json`,
                ),
              }),
            );
        } else await desk.closed;
      } finally {
        stop.abort();
        await desk?.closed;
        // Ctrl+C cancels research too. Its attempt record must be final before the owner leaves.
        await runner.settled();
        // The coordinator pauses first, so no wakeup starts a task while the workers stop.
        const coordinatorSaved = await coordinator.close();
        if (!(await sessions.close()) || !coordinatorSaved)
          io.progress?.(
            'Verifold could not save the last change to the session record in .verifold/sessions/.',
          );
        // A task turn that Ctrl+C stopped becomes a version for review.
        await tasks.settle();
      }
    } finally {
      await owner.release();
    }
  } finally {
    stop.abort();
    await desk?.closed;
  }
}
/**
 * Settle the work of an owner that stopped without a final record, before this
 * owner starts anything. The terminal names what was interrupted.
 */
async function recover(
  root: string,
  ownerId: string,
  io: CliIO,
): Promise<void> {
  const sessions = await reconcileSessions(root, ownerId);
  const attempts = await reconcileAttempts(root);
  const parts = [
    sessions.interrupted &&
      `${sessions.interrupted} ${sessions.interrupted === 1 ? 'session' : 'sessions'}`,
    attempts.interrupted &&
      `${attempts.interrupted} research ${attempts.interrupted === 1 ? 'attempt' : 'attempts'}`,
  ].filter(Boolean);
  const stopped = sessions.stopped + attempts.stopped;
  if (parts.length)
    io.progress?.(
      `Verifold stopped earlier without saving the end of its work. ${parts.join(' and ')} stopped with an unknown outcome.${stopped ? ` Verifold stopped ${stopped} harness ${stopped === 1 ? 'process' : 'processes'} that kept running.` : ''} Resume a session in the desk or with /resume. Continue research to run the step again.`,
    );
}

/** Run foreground work as the project owner, so no desk owner runs at the same time. */
async function owned<T>(
  root: string,
  io: CliIO,
  work: () => Promise<T>,
): Promise<T> {
  const owner = await claimOwner(root, await packageVersion());
  try {
    await recover(root, owner.ownerId, io);
    return await work();
  } finally {
    await owner.release();
  }
}

/** Subprocess CLI contract: machine commands return JSON; prompts are delegated to stderr I/O. */
export async function runCli(
  argv: readonly string[],
  cwd: string,
  io: CliIO,
  signal: AbortSignal = new AbortController().signal,
  harness: typeof runHarness = runHarness,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      version: { type: 'boolean' },
      workspace: { type: 'string' },
      profile: { type: 'string' },
      host: { type: 'string' },
      model: { type: 'string' },
      'agency-dir': { type: 'string' },
      topic: { type: 'string' },
      feedback: { type: 'string' },
      approve: { type: 'boolean' },
      memory: { type: 'boolean' },
      autonomy: { type: 'string' },
      'setup-only': { type: 'boolean' },
      setup: { type: 'boolean' },
      from: { type: 'string' },
      id: { type: 'string' },
      'no-open': { type: 'boolean' },
      mode: { type: 'string' },
      prompt: { type: 'string' },
    },
  });
  if (values.help) {
    io.out(help);
    return;
  }
  if (values.version) {
    io.out(await packageVersion());
    return;
  }
  const launch = positionals.length === 0;
  if (launch && !io.interactive)
    throw new Error(
      'Interactive launch requires a terminal. Use an explicit command or --help.',
    );
  let command = positionals[0];
  const root = resolve(cwd, values.workspace ?? '.');
  if (launch) {
    command = 'init';
    try {
      await lstat(join(root, '.verifold', 'workspace.json'));
      command = 'ui';
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
  }
  if (!command || positionals.length > 1)
    throw new Error('Provide one command. Use --help.');
  const allowed: Record<string, readonly string[]> = {
    init: [
      'profile',
      'host',
      'model',
      'agency-dir',
      'topic',
      'autonomy',
      'setup-only',
    ],
    research: ['topic', 'feedback', 'autonomy', 'approve'],
    literature: ['memory'],
    recommend: [],
    ideas: ['from'],
    select: ['id'],
    handoff: [],
    view: [],
    status: [],
    ui: ['no-open'],
    session: ['host', 'mode', 'model', 'prompt', 'no-open'],
    profile: ['setup', 'agency-dir', 'host', 'model'],
  };
  if (!Object.hasOwn(allowed, command))
    throw new Error(`Unknown command: ${command}. Use --help.`);
  for (const key of Object.keys(values))
    if (
      key !== 'workspace' &&
      !(launch && (key === 'no-open' || key === 'agency-dir')) &&
      !allowed[command]?.includes(key)
    )
      throw new Error(`--${key} is not valid for ${command}.`);
  signal.throwIfAborted();
  if (command === 'profile') {
    if (values.workspace !== undefined)
      throw new Error(
        'Profile is global. Use --agency-dir instead of --workspace.',
      );
    await profileCommand(
      {
        ...(values['agency-dir'] !== undefined
          ? { agencyDir: values['agency-dir'] }
          : {}),
        ...(values.host !== undefined ? { host: values.host } : {}),
        ...(values.model !== undefined ? { model: values.model } : {}),
        setup: values.setup ?? false,
      },
      cwd,
      io,
      signal,
      harness,
    );
    return;
  }
  if (command === 'ui') {
    if (launch) {
      const workspace = await loadWorkspace(root);
      await ensureGlobalProfile(
        agencyDirectory(cwd, values['agency-dir']),
        cwd,
        workspace.host === 'claude' || workspace.host === 'codex'
          ? {
              host: workspace.host,
              ...(workspace.model ? { model: workspace.model } : {}),
            }
          : undefined,
        io,
        signal,
        harness,
      );
    }
    await serveDesk(root, values['no-open'] ?? false, io, signal);
    return;
  }
  if (command === 'session') {
    if (values.prompt === undefined)
      throw new Error(
        'session requires --prompt with a request for the harness.',
      );
    const workspace = await loadWorkspace(root);
    await serveDesk(root, values['no-open'] ?? false, io, signal, undefined, {
      host: values.host ?? workspace.host,
      mode: values.mode ?? 'ask',
      model: values.model,
      prompt: values.prompt,
    });
    return;
  }
  if (command === 'init') {
    const options: InitializationOptions = {
      ...(values.profile !== undefined ? { profile: values.profile } : {}),
      ...(values.host !== undefined ? { host: values.host } : {}),
      ...(values.model !== undefined ? { model: values.model } : {}),
      ...(values['agency-dir'] !== undefined
        ? { agencyDir: values['agency-dir'] }
        : {}),
      ...(values.topic !== undefined ? { topic: values.topic } : {}),
      ...(values.autonomy !== undefined ? { autonomy: values.autonomy } : {}),
      setupOnly: values['setup-only'] ?? false,
      workspaceSpecified: values.workspace !== undefined,
    };
    // Bare verifold in a new folder offers setup in the desk. init stays the terminal path.
    if (
      launch &&
      !values['no-open'] &&
      (await choose(
        io,
        'Where do you want to set up this project?',
        [
          {
            value: 'browser',
            label: 'Continue in the browser',
            description:
              'Set up the project in the desk. This terminal stays open and shows each step.',
          },
          {
            value: 'terminal',
            label: 'Continue here',
            description: 'Answer each setup question in this terminal.',
          },
        ],
        'browser',
      )) === 'browser'
    ) {
      await serveDesk(root, false, io, signal, undefined, undefined, harness, {
        cwd,
        options,
      });
      return;
    }
    const initialized = await initializeProject(
      root,
      cwd,
      options,
      io,
      signal,
      harness,
    );
    if (launch) {
      await serveDesk(
        initialized.root,
        values['no-open'] ?? false,
        io,
        signal,
        initialized.research ?? undefined,
        undefined,
        harness,
      );
      return;
    }
    const result = initialized.research
      ? await owned(initialized.root, io, () =>
          runResearch(
            initialized.root,
            initialized.research ?? {},
            io,
            signal,
            harness,
          ),
        )
      : initialized.workspace;
    showWorkspace(initialized.root, result, io);
    return;
  }
  if (command === 'research') {
    const result = await owned(root, io, () =>
      runResearch(
        root,
        {
          ...(values.topic !== undefined ? { topic: values.topic } : {}),
          ...(values.approve !== undefined ? { approve: values.approve } : {}),
          ...(values.feedback !== undefined
            ? { feedback: values.feedback }
            : {}),
          ...(values.autonomy !== undefined
            ? { autonomy: parseAutonomy(values.autonomy) }
            : {}),
        },
        io,
        signal,
        harness,
      ),
    );
    showWorkspace(root, result, io);
    return;
  }
  if (command === 'ideas') {
    if (!values.from)
      throw new Error(
        'ideas requires --from with host-generated recommendations. Run recommend first.',
      );
    const candidates = parseCandidates(
      await readJson(resolve(cwd, values.from)),
    );
    const result = await changeWorkspace(root, (current) => {
      if (!current) throw new Error('Run init first.');
      if (current.selectedId)
        throw new Error(
          'A selected idea already exists; refusing to replace its evidence.',
        );
      return { ...current, candidates };
    });
    io.out(JSON.stringify(result.candidates));
    return;
  }
  const workspace = await loadWorkspace(root);
  if (command === 'status') {
    io.out(JSON.stringify(workspace));
    return;
  }
  if (command === 'recommend') {
    io.out(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'recommendation-request',
        profile: workspace.profile,
        ...(workspace.context ? { context: workspace.context } : {}),
        ...(workspace.model ? { model: workspace.model } : {}),
        host: workspace.host,
        scope: 'Any research whose end-to-end experimentation is computational',
        instructions: await loadPrompt('recommendation-request'),
      }),
    );
    return;
  }
  if (command === 'select') {
    if (!workspace.candidates.length)
      throw new Error('Import host recommendations with ideas --from first.');
    let id = values.id;
    if (!id) {
      if (!io.interactive)
        throw new Error(
          'Noninteractive selection requires --id. No idea was selected.',
        );
      const choices = workspace.candidates
        .map(
          (idea) =>
            `${idea.id}: ${idea.title}\n  Agent recommendation: ${idea.recommendation}\n  Proposed gates: ${idea.gates.join('; ')}`,
        )
        .join('\n\n');
      id = (
        await io.ask(
          `${choices}\n\nChoose an idea ID (no execution is authorized): `,
        )
      ).trim();
    }
    const result = await owned(root, io, () =>
      selectIdea(root, id, workspace.candidates),
    );
    io.out(
      JSON.stringify({
        selectedId: result.selectedId,
        status: 'direction-selected',
        next: 'Run verifold in this project directory. The coordinator plans the tasks for this direction and waits for your approval.',
        visibility: 'private',
      }),
    );
    return;
  }
  if (command === 'literature') {
    const idea = workspace.candidates.find(
      (candidate) => candidate.id === workspace.selectedId,
    );
    if (!idea)
      throw new Error(
        'Select an idea before requesting optional literature retention.',
      );
    io.out(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'literature-retention-request',
        host: workspace.host,
        idea,
        optional: true,
        mode: values.memory ? 'pdfs-and-markdown-context' : 'pdfs',
        executionStarted: false,
        outputDirectory: 'literature/',
        instructions: await loadPrompt('literature-request'),
        ...(values.memory
          ? {
              memoryInstructions: await loadPrompt('literature-memory'),
            }
          : {}),
      }),
    );
    return;
  }
  if (command === 'handoff') {
    const idea = workspace.candidates.find(
      (candidate) => candidate.id === workspace.selectedId,
    );
    if (!idea) throw new Error('Select an idea before requesting a handoff.');
    io.out(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'pilot-planning-request',
        host: workspace.host,
        executionAdapter: 'automative',
        visibility: 'private',
        idea,
        executionAuthorized: false,
        instructions: await loadPrompt('pilot-request'),
        nextSteps: [
          'Review AUTOMATIVE.md with the user',
          'automative doctor',
          'automative run start',
        ],
      }),
    );
    return;
  }
  const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verifold — private workspace</title><style>body{font:16px system-ui;background:#f8f7fa;color:#101014;max-width:900px;margin:50px auto;padding:24px}h1{color:#4c1d95}article{padding:20px 0;border-top:1px solid #ddd}p{line-height:1.7}</style><h1>Verifold</h1><p>Private workspace · managed by the CLI · ${e(workspace.profile.name)}</p><p>${workspace.profile.interests.map(e).join(', ')}</p><p>Host: ${e(workspace.host)} · Selection: ${e(workspace.selectedId ?? 'Awaiting your choice')}</p>${workspace.candidates.map((idea) => `<article><h2>${e(idea.title)}</h2><p>${e(idea.recommendation)}</p><ul>${idea.gates.map((gate) => `<li>${e(gate)}</li>`).join('')}</ul></article>`).join('')}<p>Run <code>verifold</code> in this project directory to open the desk and choose a direction there. This view sends no data and starts no experiments.</p></html>`;
  const path = join(root, '.verifold', 'workspace.html');
  const temporary = join(root, '.verifold', `${randomUUID()}.html.tmp`);
  try {
    await writeFile(temporary, page, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  io.out(
    JSON.stringify({
      path,
      visibility: 'private',
      note: 'Local read-only snapshot. No remote account or cloud synchronization is configured.',
    }),
  );
}
