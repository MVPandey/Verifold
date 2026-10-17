import { loadPrompt } from './prompts.ts';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { resolve, join } from 'node:path';
import {
  appendFile,
  writeFile,
  rename,
  rm,
  lstat,
  stat,
} from 'node:fs/promises';
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
import {
  reconcileAttempts,
  runResearch,
  selectIdea,
  type ResearchOptions,
} from './research.ts';
import { ResearchRunner } from './research-runner.ts';
import { ProjectMemory } from './memory.ts';
import { object, text } from './research-contracts.ts';
import type { Choice } from './choices.ts';
import { installedHarnesses, runHarness } from './harness.ts';
import { nextResearchAction } from './desk-view.ts';
import { startDesk, openDeskBrowser, type DeskServer } from './desk.ts';
import { SetupBridge } from './setup-bridge.ts';
import { TaskManager, type TaskPlace } from './tasks.ts';
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
import { claimOwner, liveOwner, OwnerConflict } from './owner.ts';
import {
  connectControl,
  newControl,
  parseControl,
  readControl,
  removeSocket,
  saveControl,
  serveControl,
  type Control,
  type ControlClient,
} from './control.ts';
import { Compute } from './compute.ts';
import { KeepAwake } from './awake.ts';
import { KeyStore, type KeyStoreOptions } from './credentials.ts';
import { spent, type Lease } from './leases.ts';
/** How a view can show a question. The terminal shows only the question text. */
export type AskHint =
  | { readonly kind: 'confirm'; readonly yes: string; readonly no: string }
  | {
      readonly kind: 'text';
      /** The question for a view with buttons, without terminal keys and commands. */
      readonly label?: string;
      readonly multiline?: boolean;
      readonly placeholder?: string;
      /** One short line under the field, for example the current settings. */
      readonly note?: string;
      /** Likely answers. Each one answers the question with its own text. */
      readonly suggestions?: readonly string[];
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
export type SetupStep = 'Question' | 'Quick questions' | 'Brief';

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
  /** Read a secret without echo, or from piped input. */
  readonly readSecret?: (prompt: string) => Promise<string>;
  /** Tests point the RunPod client at a fake server and the key store at fake programs. */
  readonly compute?: {
    readonly url?: string;
    readonly store?: KeyStoreOptions;
    readonly programs?: {
      readonly ssh?: string;
      readonly keyscan?: string;
      readonly keygen?: string;
    };
  };
  /** Read terminal lines until the signal aborts. Only an interactive terminal provides it. */
  readonly listen?: (
    onLine: (line: string) => void,
    signal: AbortSignal,
  ) => void;
  /** Background owners. Only the executable provides it. Without it, the desk runs in this process. */
  readonly background?: Background;
}

export interface Background {
  /** `~/.verifold/credentials/owners`, where each background owner keeps its control. */
  readonly keys: string;
  /** Start `verifold owner` for a project in a detached process. `input` is its only input. */
  readonly start: (root: string, input: string) => Promise<void>;
  /** The input of this process when it is `verifold owner`. */
  readonly input: () => Promise<string>;
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
verifold stop                         Stop the team that works in the background, with its pods
verifold session --prompt text [--host claude|codex] [--mode ask|auto] [--model name] [--no-open]
                                      Run one harness session; answer its requests here or on the desk
verifold status                       Print workspace JSON
verifold profile [--setup]            Inspect or configure your global profile
verifold runpod key set [--file]      Store a RunPod API key from hidden input or stdin, after a check
verifold runpod key status|check|remove
                                      Show where the key is, check it with RunPod, or remove it
verifold runpod secret set NAME [--file]
                                      Store a secret for pods, such as HF_TOKEN, from hidden input or stdin
verifold runpod secret list|remove NAME
                                      List the secret names, or remove one
verifold pods [stop <lease|all>]      List the GPU pod leases, or stop pods when the desk does not run

Options: --workspace path (default: the current folder), --help, --version

Setup connects your harness, asks for a project folder and your question, and has
the harness draft a research brief for you to review. Then it creates literature/,
experiments/, results/, figures/, docs/, agents/, and .verifold.md. Use --model to
pick the harness model, and --agency-dir to keep your preferences and USER.md in
another folder (default: ~/.verifold/agency). --setup-only sets up without research
and offers a research memory that other projects can reuse. Without a terminal,
research needs --host, --topic, and --autonomy autonomous.

Research searches the web and proposes directions. It runs no experiments. Keeping
PDFs is optional and comes after you choose a direction. Verifold keeps its records
in .verifold/, and Claude Code or Codex keeps its own permissions and sessions.
With a terminal, the team works in a background process, so closing the terminal
or Ctrl+C does not stop it. Type /help in the terminal for its commands, and run
verifold stop to stop the team. Session records are in .verifold/sessions/.
`;

/** The commands of the terminal. A terminal on a background owner only detaches with Ctrl+C. */
const terminalHelp = (
  background: boolean,
): string => `Commands in this terminal:
- \`/open\`: open the desk in your browser.
- \`/start\` and a request: start a session with the project's harness in Ask me mode.
- \`/resume\`: resume the latest paused or interrupted session. Without a recorded conversation, its first request runs again.
- \`/research\`: continue research. In a project without research, add the question.
- \`/approve\`: approve the research plan.
- \`/feedback\` and your changes: revise the plan or the directions.
- \`/select\` and a direction ID: choose the direction when research did not draft a plan. The coordinator then drafts it.
- \`a\` or \`d\`: allow once or deny the open request. If several are open, add the ID, for example \`a R2\`.
- \`/cancel\`: stop the research step or the current turn. If both run, choose in the desk.
- \`/end\`: end the session.
- \`/help\`: show these commands.

When the agent waits for you, other text goes to it as a follow-up. ${background ? 'Ctrl+C leaves this terminal, and the team keeps working. To stop it, run verifold stop, or use Stop the team in Records.' : 'Ctrl+C pauses the session and stops Verifold.'}`;

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
  /** The terminal is attached to a background owner. */
  readonly background?: boolean;
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
    else if (value === '/help')
      io.progress?.(terminalHelp(controls.background === true));
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

/** The ports and access token of a desk, so a desk in another process can keep its open tab. */
interface DeskPlace {
  readonly port: number;
  readonly token: string;
  /** The page server's port. The open tab may frame only that one. */
  readonly pages?: number | undefined;
}

/** How serveDesk runs. */
interface DeskRun {
  readonly noOpen?: boolean;
  readonly research?: ResearchOptions | undefined;
  /** Start this session, and return when it ends. */
  readonly session?: Parameters<SessionPool['start']>[0];
  readonly harness?: typeof runHarness;
  /** Set up a new project in the desk first. */
  readonly setup?: {
    readonly cwd: string;
    readonly options: InitializationOptions;
  };
  /** After setup, close the desk and return the project, so a background owner takes over. */
  readonly handoff?: boolean;
  /** This process is the background owner. Its control is saved under its owner ID while it owns the project. */
  readonly owner?: {
    readonly control: Control;
    readonly keys: string;
    readonly desk?: DeskPlace | undefined;
  };
}

/** What setup leaves for the background owner. */
interface Handoff {
  readonly root: string;
  readonly research: ResearchOptions | undefined;
  readonly desk: DeskPlace;
}

/**
 * Serve the desk with a session owner. With `session`, start that session and
 * return when it ends. Otherwise serve until the CLI is cancelled, or until
 * the person stops Verifold in the desk.
 */
async function serveDesk(
  root: string,
  io: CliIO,
  signal: AbortSignal,
  run: DeskRun = {},
): Promise<Handoff | undefined> {
  const { session, setup } = run;
  const harness = run.harness ?? runHarness;
  let research = run.research;
  const version = await packageVersion();
  // Stop in the desk stops Verifold, as Ctrl+C does.
  const quit = new AbortController();
  const running = AbortSignal.any([signal, quit.signal]);
  const stop = new AbortController();
  const deskSignal = AbortSignal.any([running, stop.signal]);
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
    // The terminal that attaches to a background owner opens the desk.
    if (run.owner) return;
    if (run.noOpen)
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
      const bridge = new SetupBridge(io, running);
      desk = await startDesk(
        null,
        deskSignal,
        io.deskAssets,
        undefined,
        undefined,
        bridge,
        undefined,
        undefined,
        undefined,
        undefined,
        { stop: () => quit.abort() },
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
          running,
          withTranscript(harness, bridge.transcript),
        ),
      );
      root = initialized.root;
      research = initialized.research ?? undefined;
      io.progress?.(`Setup is complete. The project is in ${root}.`);
      if (run.handoff) {
        // The background owner opens the desk on the same port with the same token, so this tab keeps working.
        const place = new URL(desk.url);
        stop.abort();
        await desk.closed;
        return {
          root,
          research,
          desk: {
            port: Number(place.port),
            token: place.hash.slice(1),
            pages: Number(new URL(desk.pages).port),
          },
        };
      }
    }
    const host =
      (await loadWorkspace(root)).host === 'codex' ? 'codex' : 'claude';
    // Only one process owns the project. A second one stops here.
    const owner = await claimOwner(root, version);
    let forget: (() => Promise<void>) | undefined;
    try {
      // Terminals find the background owner by its ID.
      if (run.owner)
        forget = await saveControl(
          run.owner.keys,
          owner.ownerId,
          run.owner.control,
        );
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
          // A worker's text in the middle of a turn answers a message that it took into the turn.
          const task = view?.record.task;
          if (event.kind === 'agent' && task)
            owned.tasks?.answered(task.id, event.text, true).catch(() => {});
          // The events of task workers stay in the desk. A session that the person controls prints its events here.
          const line =
            io.interactive && !view?.record.task
              ? feedLine(event, view ? hostName(view.record.host) : undefined)
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
      // A lease change shows in the terminal and wakes the coordinator, unless the coordinator made it.
      // Before a pod stops, its tasks' results come back into their folders.
      const compute = computeFor(
        root,
        io,
        (lease, line) => {
          io.progress?.(`Pod ${line}`);
          if (lease.history.at(-1)?.by !== 'coordinator')
            owned.coordinator?.notify({ kind: 'pod', text: line });
        },
        (task) => owned.tasks?.folderOf(task) ?? Promise.resolve(null),
      );
      // The project memory follows every change of the records, and every agent reads its index.
      const memory = new ProjectMemory(
        root,
        () => owned.tasks?.list() ?? Promise.resolve([]),
      );
      const remember = (): void => memory.schedule();
      const tasks = new TaskManager(root, {
        ownerId: owner.ownerId,
        sessions,
        ...(io.progress ? { progress: io.progress } : {}),
        onEvent: (event) => owned.coordinator?.notify(event),
        pods: compute.podTools(),
        memory,
        onChange: remember,
      });
      owned.tasks = tasks;
      const runner = new ResearchRunner(root, {
        signal: running,
        io,
        harness,
        // A chosen direction starts the coordinator, which gets the messages that still wait for research.
        onSelect: async () => {
          // memory/direction.md exists before the coordinator gives it to a task.
          await memory.write().catch(() => {
            /* The coordinator still starts. A task input that is missing is refused with its name. */
          });
          await owned.coordinator?.startForDirection(await loadWorkspace(root));
          await tasks.passToCoordinator();
        },
        inbox: {
          post: (text) => tasks.post('research', text),
          take: () => tasks.takeResearch(),
        },
        onChange: remember,
      });
      // The coordinator has its own session, outside the worker slots.
      const coordinator = new Coordinator(root, {
        tasks,
        compute,
        memory,
        onChange: remember,
        ...(io.progress ? { progress: io.progress } : {}),
        sessions: new SessionManager(root, {
          clientVersion: version,
          ownerId: owner.ownerId,
          onTurnEnd: (record) => owned.coordinator?.turnEnded(record),
        }),
      });
      owned.coordinator = coordinator;
      // While an agent works or a pod runs, a Mac does not go to idle sleep. So the work and the idle stop of a pod go on.
      const awake = new KeepAwake();
      const working = setInterval(() => {
        awake.set(
          runner.running ||
            [...sessions.views(), coordinator.view()?.session].some(
              (view) => view?.record.status === 'running',
            ) ||
            compute
              .view()
              .leases.some(
                (lease) =>
                  lease.state === 'starting' || lease.state === 'ready',
              ),
        );
      }, 30_000);
      working.unref();
      try {
        await sessions.load();
        await coordinator.load();
        await compute.load();
        remember();
        // Only the owner of the project recovers leases: a pod that runs now outlived an earlier owner.
        await compute.leases.recover();
        compute.watch();
        const stopped = await tasks.settle();
        if (stopped)
          io.progress?.(
            `Verifold stopped earlier while ${stopped === 1 ? 'a task was' : `${stopped} tasks were`} running. Review the saved work in the desk.`,
          );
        // Start the session first, so invalid input fails before a desk opens.
        if (session) owned.session = await sessions.start(session);
        if (desk)
          await desk.attach(
            root,
            sessions,
            runner,
            tasks,
            coordinator,
            compute,
            memory,
          );
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
            compute,
            memory,
            { stop: () => quit.abort(), reuse: run.owner?.desk },
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
              background: run.owner !== undefined,
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
          if (io.interactive) io.progress?.(terminalHelp(false));
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
        // Pods stop when Verifold stops, so billing stops. Their results come back first.
        for (const line of await compute.close()) io.progress?.(line);
        // A task turn that Ctrl+C stopped becomes a version for review, with the results from its pod.
        await tasks.settle();
        await memory.write().catch(() => {
          /* The memory follows at the next start. */
        });
        clearInterval(working);
        awake.set(false);
      }
    } finally {
      await forget?.();
      await owner.release();
    }
  } finally {
    stop.abort();
    await desk?.closed;
  }
}
/** Status lines of the background owner in `.verifold/owner.log`, with the time. Over about 1 MB, the log moves to owner.log.1. */
function ownerLog(root: string): (line: string) => void {
  const path = join(root, '.verifold', 'owner.log');
  let queue = Promise.resolve();
  return (line) => {
    queue = queue
      .then(async () => {
        // ponytail: an error of the process after a move lands in owner.log.1, because its stderr keeps the old file.
        if (((await stat(path).catch(() => null))?.size ?? 0) > 1_000_000)
          await rename(path, `${path}.1`);
        await appendFile(
          path,
          `${new Date().toISOString()}  ${line.replace(/\n/g, '\n    ')}\n`,
          { mode: 0o600 },
        );
      })
      .catch(() => {
        /* The line still reaches the terminals. */
      });
  };
}

/** The research and the setup desk that a background owner gets in its input. Anything else is left out. */
function ownerStart(value: unknown): {
  readonly research: ResearchOptions | undefined;
  readonly desk: DeskPlace | undefined;
} {
  const data = (value ?? {}) as Record<string, unknown>;
  const research = (data.research ?? null) as Record<string, unknown> | null;
  const desk = (data.desk ?? null) as Record<string, unknown> | null;
  return {
    research:
      research && typeof research === 'object'
        ? {
            ...(typeof research.topic === 'string'
              ? { topic: research.topic }
              : {}),
            ...(research.autonomy === 'guided' ||
            research.autonomy === 'autonomous'
              ? { autonomy: research.autonomy }
              : {}),
            ...(typeof research.feedback === 'string'
              ? { feedback: research.feedback }
              : {}),
            ...(research.approve === true ? { approve: true } : {}),
          }
        : undefined,
    desk:
      desk &&
      typeof desk === 'object' &&
      Number.isInteger(desk.port) &&
      (desk.port as number) > 0 &&
      (desk.port as number) < 65_536 &&
      typeof desk.token === 'string' &&
      /^[0-9a-f]{64}$/.test(desk.token)
        ? {
            port: desk.port as number,
            token: desk.token,
            ...(Number.isInteger(desk.pages) &&
            (desk.pages as number) > 0 &&
            (desk.pages as number) < 65_536
              ? { pages: desk.pages as number }
              : {}),
          }
        : undefined,
  };
}

/**
 * `verifold owner`: the background owner of a project. Its only input is one
 * JSON line with the control, and the research and setup desk to continue.
 * Terminals attach over the control socket. Stop from a terminal or the desk,
 * SIGINT, and SIGTERM stop it as Ctrl+C stops a desk in the foreground.
 */
async function runOwner(
  root: string,
  io: CliIO,
  signal: AbortSignal,
  harness: typeof runHarness,
): Promise<void> {
  let input: unknown = null;
  try {
    input = JSON.parse((await io.background?.input()) ?? '');
  } catch {
    /* Refused below. */
  }
  const control = parseControl(input);
  if (!control || !io.background)
    throw new Error(
      'verifold owner runs only when Verifold starts it. Run verifold in the project folder.',
    );
  const { research, desk } = ownerStart(input);
  const quit = new AbortController();
  // Lines from before the first terminal attached wait for it.
  let early: string[] | null = [];
  let url: string | undefined;
  let onLine: ((line: string) => void) | undefined;
  const waiting: string[] = [];
  const server = await serveControl(control, {
    attached: (send) => {
      for (const line of early ?? []) send({ progress: line });
      early = null;
      if (url) send({ url });
    },
    message: (message) => {
      if ('stop' in message) quit.abort();
      else if (onLine) onLine(message.line);
      else if (waiting.length < 20) waiting.push(message.line);
    },
  });
  const log = ownerLog(root);
  const progress = (value: string): void => {
    log(value);
    if (early && early.length < 50) early.push(value);
    server.send({ progress: value });
  };
  try {
    await serveDesk(
      root,
      {
        ...io,
        interactive: true,
        ask: () => Promise.reject(new Error('Interactive terminal required.')),
        // The URL holds the access token. It goes to terminals only, never to the log.
        out: (value) => {
          try {
            const shown: unknown = JSON.parse(value);
            if (
              shown &&
              typeof shown === 'object' &&
              'url' in shown &&
              typeof shown.url === 'string'
            ) {
              url = shown.url;
              server.send({ url });
            }
          } catch {
            /* Only the desk URL is output. */
          }
        },
        // Harness tool events belong in the desk, as in a terminal.
        progress: (value, source) => {
          if (source !== 'tool') progress(value);
        },
        listen: (handler, until) => {
          onLine = handler;
          for (const line of waiting.splice(0)) handler(line);
          until.addEventListener(
            'abort',
            () => {
              onLine = undefined;
            },
            { once: true },
          );
        },
      },
      AbortSignal.any([signal, quit.signal]),
      {
        noOpen: true,
        research,
        harness,
        owner: { control, keys: io.background.keys, desk },
      },
    );
  } catch (error) {
    // The terminal that waits for the desk shows why Verifold stopped.
    progress(
      error instanceof Error
        ? stripVTControlCharacters(error.message)
        : 'Verifold stopped because of an error.',
    );
    throw error;
  } finally {
    server.send({ stopped: true });
    await server.close();
    await removeSocket(control);
  }
}

/** Connect to an owner that may still be starting, for up to 15 seconds. */
async function reach(
  control: Control,
  onMessage: Parameters<typeof connectControl>[1],
  signal: AbortSignal,
): Promise<ControlClient | null> {
  for (let tries = 0; tries < 150 && !signal.aborted; tries++) {
    try {
      return await connectControl(control, onMessage);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return null;
}

/**
 * With a terminal, the team of a project works in a background owner. Attach
 * this terminal to the owner, and start one first when none runs. Ctrl+C or a
 * closed terminal only detaches.
 */
async function attachTeam(
  root: string,
  io: CliIO,
  signal: AbortSignal,
  background: Background,
  start: {
    readonly noOpen: boolean;
    readonly research?: ResearchOptions | undefined;
    readonly desk?: DeskPlace;
  },
): Promise<void> {
  const running = await liveOwner(root);
  let control: Control;
  if (running) {
    const saved = await readControl(background.keys, running.ownerId);
    if (!saved)
      throw new OwnerConflict(
        `Verifold already runs in this project in another terminal (process ${running.pid}). Use that terminal, or press Ctrl+C there and run verifold again.`,
      );
    control = saved;
  } else {
    control = await newControl();
    try {
      await background.start(
        root,
        JSON.stringify({
          ...control,
          ...(start.research ? { research: start.research } : {}),
          ...(start.desk ? { desk: start.desk } : {}),
        }),
      );
    } catch (error) {
      await removeSocket(control);
      throw error;
    }
  }
  let client: ControlClient | null = null;
  let shown = false;
  client = await reach(
    control,
    (message) => {
      if ('progress' in message) io.progress?.(message.progress);
      else if ('url' in message && !shown) {
        shown = true;
        io.out(
          JSON.stringify({
            url: message.url,
            visibility: 'private',
            readOnly: false,
          }),
        );
        // After setup, the open tab moves to the background owner when it got the same port.
        if (start.desk && new URL(message.url).port === String(start.desk.port))
          io.progress?.('The desk in your browser now shows the project.');
        else if (start.noOpen)
          io.progress?.('Open the printed URL to use the desk.');
        else client?.send({ line: '/open' });
      }
    },
    signal,
  );
  if (!client) {
    // After Ctrl+C the owner may still start, and a later verifold attaches to it.
    if (signal.aborted) return;
    if (!running) await removeSocket(control);
    throw new Error(
      'Verifold could not start in the background. Check .verifold/owner.log in the project, then run verifold again.',
    );
  }
  io.progress?.(
    running
      ? 'Verifold already works in the background. This terminal shows what it does. Type /help for commands.'
      : 'Verifold now works in the background, so closing this terminal does not stop it. Type /help for commands.',
  );
  const attached = new AbortController();
  const until = AbortSignal.any([signal, attached.signal]);
  const connection = client;
  io.listen?.((line) => connection.send({ line }), until);
  await Promise.race([
    connection.closed,
    new Promise((resolve) =>
      until.addEventListener('abort', resolve, { once: true }),
    ),
  ]);
  attached.abort();
  if (signal.aborted) {
    connection.close();
    io.progress?.(
      'Detached. The team keeps working. Run verifold to come back, or verifold stop to stop it.',
    );
    return;
  }
  // The owner stopped: from the desk, from verifold stop, or after an error.
  if (!shown)
    throw new Error(
      'Verifold stopped before the desk opened. Check .verifold/owner.log in the project.',
    );
  io.progress?.('Verifold stopped.');
}

/** `verifold stop`: stop the background owner of the project, and wait until its agents and pods stopped. */
async function stopTeam(root: string, io: CliIO): Promise<void> {
  const running = await liveOwner(root);
  if (!running) {
    io.out('Verifold does not run in this project.');
    return;
  }
  const control = io.background
    ? await readControl(io.background.keys, running.ownerId)
    : null;
  if (!control)
    throw new Error(
      `Verifold runs in this project in a terminal (process ${running.pid}). Press Ctrl+C in that terminal to stop it.`,
    );
  let stopped = false;
  const client = await connectControl(control, (message) => {
    if ('stopped' in message) stopped = true;
    // Lines from the stop, such as a pod that stopped. The desk URL stays out.
    else if ('progress' in message) io.progress?.(message.progress);
  });
  io.progress?.(
    'Stopping Verifold. The agents pause. A task turn that runs now stops, and its work waits for your review. Pods stop after their results come back.',
  );
  client.send({ stop: true });
  await client.closed;
  if (!stopped)
    throw new Error(
      'Verifold closed the connection before it stopped. Check .verifold/owner.log in the project.',
    );
  io.out('Verifold stopped.');
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

/** The compute settings, RunPod key, and pod leases of a project, with the test hooks of the I/O. */
function computeFor(
  root: string,
  io: CliIO,
  onChange?: (lease: Lease, line: string) => void,
  taskFolder?: (task: string) => Promise<TaskPlace | null>,
): Compute {
  return new Compute(root, {
    store: new KeyStore(io.compute?.store),
    ...(io.compute?.url ? { url: io.compute.url } : {}),
    ...(io.compute?.programs ? { programs: io.compute.programs } : {}),
    ...(onChange ? { onChange } : {}),
    ...(taskFolder ? { taskFolder } : {}),
  });
}

/** `verifold runpod secret set NAME|list|remove NAME`. Secrets belong to this computer, and no output holds a value. */
async function secretCommand(
  verb: string | undefined,
  name: string | undefined,
  file: boolean | undefined,
  root: string,
  io: CliIO,
): Promise<void> {
  if (
    !(
      ((verb === 'set' || verb === 'remove') && name) ||
      (verb === 'list' && !name)
    )
  )
    throw new Error(
      'Use verifold runpod secret set NAME, list, or remove NAME.',
    );
  if (file !== undefined && verb !== 'set')
    throw new Error('--file is valid only for verifold runpod secret set.');
  const compute = computeFor(root, io);
  await compute.load();
  if (verb === 'set') {
    if (!io.readSecret)
      throw new Error(
        'Pipe the value into this command, or run it in a terminal.',
      );
    const value = (await io.readSecret(`${name} (input hidden): `)).trim();
    await compute.setSecret(name, value, file === true);
  } else if (verb === 'remove') await compute.removeSecret(name);
  io.out(
    JSON.stringify(
      compute
        .view()
        .secrets.map((secret) => ({ name: secret.name, place: secret.place })),
    ),
  );
}

/** `verifold runpod key set|status|check|remove`. The key belongs to this computer, and no output holds it. */
async function runpodCommand(
  noun: string | undefined,
  verb: string | undefined,
  file: boolean | undefined,
  root: string,
  io: CliIO,
): Promise<void> {
  if (
    noun !== 'key' ||
    (verb !== 'set' &&
      verb !== 'status' &&
      verb !== 'check' &&
      verb !== 'remove')
  )
    throw new Error('Use verifold runpod key set, status, check, or remove.');
  if (file !== undefined && verb !== 'set')
    throw new Error('--file is valid only for verifold runpod key set.');
  const compute = computeFor(root, io);
  await compute.load();
  if (verb === 'set') {
    if (!io.readSecret)
      throw new Error(
        'Pipe the key into this command, or run it in a terminal.',
      );
    const key = (await io.readSecret('RunPod API key (input hidden): ')).trim();
    await compute.setKey(key, file === true);
  } else if (verb === 'check') await compute.checkKey();
  else if (verb === 'remove') await compute.removeKey();
  const key = compute.view().key;
  io.out(
    JSON.stringify(
      key
        ? {
            key: 'stored',
            place: key.place,
            last4: key.last4,
            ...(key.checkedAt ? { checkedAt: key.checkedAt } : {}),
            ...(key.problem ? { problem: key.problem } : {}),
          }
        : { key: 'none' },
    ),
  );
  if (verb === 'remove')
    io.progress?.(
      'RunPod keeps the key valid until you revoke it in the RunPod console.',
    );
}

/**
 * `verifold pods` lists the leases. `verifold pods stop <lease|all>` stops pods
 * without the desk, as the project owner, so it refuses while Verifold runs.
 */
async function podsCommand(
  verb: string | undefined,
  target: string | undefined,
  root: string,
  io: CliIO,
): Promise<void> {
  if (verb !== undefined && verb !== 'stop')
    throw new Error('Use verifold pods, or verifold pods stop <lease or all>.');
  const compute = computeFor(root, io);
  if (verb === 'stop')
    await owned(root, io, async () => {
      await compute.load();
      // Pods that run now outlived their owner, so recovery stops them first.
      await compute.leases.recover();
      if (target === 'all') await compute.close();
      else {
        const lease = compute.leases.get(target);
        if (lease.state === 'ready' || lease.state === 'starting')
          await compute.leases.stop(
            lease.id,
            'person',
            'you stopped it in the terminal.',
          );
      }
    });
  else await compute.load();
  const now = Date.now();
  io.out(
    JSON.stringify(
      compute.view().leases.map((lease) => ({
        lease: lease.id,
        state: lease.state,
        gpu: lease.gpu,
        pod: lease.podId,
        tasks: lease.tasks,
        costUsd: Number(spent(lease, now).toFixed(2)),
        endsAt: lease.deadline,
      })),
    ),
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
      file: { type: 'boolean' },
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
  // `runpod key <action>`, `runpod secret <action> [name]`, and `pods stop <lease>` are the only commands with more words.
  if (
    !command ||
    (command === 'runpod'
      ? positionals.length !== 3 &&
        !(positionals[1] === 'secret' && positionals.length === 4)
      : command === 'pods'
        ? positionals.length !== 1 && positionals.length !== 3
        : positionals.length > 1)
  )
    throw new Error(
      command === 'runpod'
        ? 'Use verifold runpod key set, status, check, or remove, or verifold runpod secret set NAME, list, or remove NAME.'
        : command === 'pods'
          ? 'Use verifold pods, or verifold pods stop <lease or all>.'
          : 'Provide one command. Use --help.',
    );
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
    owner: [],
    stop: [],
    session: ['host', 'mode', 'model', 'prompt', 'no-open'],
    profile: ['setup', 'agency-dir', 'host', 'model'],
    runpod: ['file'],
    pods: [],
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
  if (command === 'runpod') {
    if (positionals[1] === 'secret')
      await secretCommand(
        positionals[2],
        positionals[3],
        values.file,
        root,
        io,
      );
    else
      await runpodCommand(
        positionals[1],
        positionals[2],
        values.file,
        root,
        io,
      );
    return;
  }
  if (command === 'pods') {
    await podsCommand(positionals[1], positionals[2], root, io);
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
    const noOpen = values['no-open'] ?? false;
    if (io.interactive && io.background)
      await attachTeam(root, io, signal, io.background, { noOpen });
    else await serveDesk(root, io, signal, { noOpen });
    return;
  }
  if (command === 'owner') {
    await runOwner(root, io, signal, harness);
    return;
  }
  if (command === 'stop') {
    await stopTeam(root, io);
    return;
  }
  if (command === 'session') {
    if (values.prompt === undefined)
      throw new Error(
        'session requires --prompt with a request for the harness.',
      );
    const workspace = await loadWorkspace(root);
    await serveDesk(root, io, signal, {
      noOpen: values['no-open'] ?? false,
      session: {
        host: values.host ?? workspace.host,
        mode: values.mode ?? 'ask',
        model: values.model,
        prompt: values.prompt,
      },
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
      harnesses: await installedHarnesses(),
    };
    // Bare verifold in a new folder sets up in the desk. init and --no-open stay the terminal path.
    // With a terminal, setup hands the project to a background owner.
    const background = io.interactive ? io.background : undefined;
    if (launch && !values['no-open']) {
      const handoff = await serveDesk(root, io, signal, {
        harness,
        setup: { cwd, options },
        handoff: background !== undefined,
      });
      if (handoff && background)
        await attachTeam(handoff.root, io, signal, background, {
          noOpen: false,
          research: handoff.research,
          desk: handoff.desk,
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
      const run = {
        noOpen: values['no-open'] ?? false,
        research: initialized.research ?? undefined,
      };
      if (background)
        await attachTeam(initialized.root, io, signal, background, run);
      else await serveDesk(initialized.root, io, signal, { ...run, harness });
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
          'An idea is already selected. Verifold keeps its evidence and selects nothing new.',
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
            `${idea.id}: ${idea.title}\n  Agent recommendation: ${idea.recommendation}\n  Proposed checks: ${idea.gates.join('; ')}`,
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
        next: 'Run verifold in this project folder. The coordinator then plans the tasks for this direction.',
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
