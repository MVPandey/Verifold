import { loadPrompt } from './prompts.ts';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { isAbsolute, resolve, join } from 'node:path';
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
import { parseCandidates } from '../core/contracts.ts';
import type { Workspace } from '../core/contracts.ts';
import { changeWorkspace, loadWorkspace, readJson } from '../core/storage.ts';
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
} from '../legacy/research.ts';
import { ResearchRunner } from '../legacy/research-runner.ts';
import { clip } from '../core/board.ts';
import { researchRunOnDisk } from '../core/history.ts';
import { ProjectMemory } from '../core/memory.ts';
import { object, text } from '../core/research-contracts.ts';
import type { Choice } from './choices.ts';
import { installedHarnesses, runHarness } from '../core/harness.ts';
import { nextResearchAction } from '../desk/desk-view.ts';
import {
  hasAppBuild,
  startDesk,
  openDeskBrowser,
  type DeskServer,
} from '../server/desk.ts';
import { SetupBridge } from './setup-bridge.ts';
import { askStart, type Begun } from './ask-start.ts';
import { FirstRun } from '../server/setup.ts';
import { pluginsHome, skillLoader } from '../core/skills.ts';
import { TaskManager } from '../legacy/tasks.ts';
import { ResultsStore } from '../legacy/results.ts';
import { defaultAgents, SessionPool } from '../core/workers.ts';
import { Quota } from '../core/quota.ts';
import { Coordinator } from '../legacy/coordinator.ts';
import { Lab, labOnDisk, startLabOn } from '../core/lab.ts';
import type { LabScreen } from '../server/screen.ts';
import type { FollowScreens } from './terminal-view.ts';
import { labModel } from '../core/models.ts';
import { labWorks, RunTeam } from '../core/team.ts';
import { withTranscript } from '../core/transcript.ts';
import { ensureGlobalProfile, profileCommand } from './profile.ts';
import {
  agencyDirectory,
  loadSettings,
  profileReader,
} from '../core/agency.ts';
import {
  hostName,
  reconcileSessions,
  SessionActionError,
  SessionManager,
  type PendingRequest,
  type SessionEvent,
} from '../core/session.ts';
import { claimOwner, liveOwner, OwnerConflict } from '../core/owner.ts';
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
} from '../server/control.ts';
import { Compute, type TaskPlace } from '../core/compute.ts';
import { KeepAwake } from '../server/awake.ts';
import { KeyStore, type KeyStoreOptions } from '../core/credentials.ts';
import { spent, type Lease } from '../core/leases.ts';
import { GpuMonth } from '../core/gpu-month.ts';
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
  /**
   * A line of the person's own session, which a terminal keeps in its
   * scrollback. Without it, the line goes to `progress`. `logged`: the line
   * for a log, when it leaves out part of `line`, such as a request's change.
   */
  readonly feed?: (line: string, logged?: string) => void;
  /** Review a draft brief with direct editing. Only the desk provides it. */
  readonly review?: (brief: string, final: boolean) => Promise<BriefDecision>;
  /** Mark the current setup step for a view that shows it. */
  readonly step?: (name: SetupStep) => void;
  /** Open a desk URL in a browser. Tests replace it. The default is the system browser. */
  readonly browse?: (url: string, signal: AbortSignal) => Promise<boolean>;
  /** The folder of desk page files. Tests use fixtures. The default is the installed package. */
  readonly deskAssets?: URL;
  /** The folder of the app's build. Tests use fixtures. The default is the installed package. */
  readonly appAssets?: URL;
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
  /**
   * The lab for a terminal's live view. Only a terminal, or a background
   * owner for its terminals, provides it.
   */
  readonly screens?: {
    /**
     * A screen of the lab from a background owner, again after each change
     * of it: null when the project has no lab. `detaches`: Ctrl+C only
     * detaches this terminal, and the lab works on.
     */
    readonly show?: (screen: LabScreen | null, detaches: boolean) => void;
    /**
     * The desk of this process serves the project. `follow` starts a watch
     * of the lab's screens and returns its stop. The view owns the watch,
     * and stops it when it closes.
     */
    readonly serve?: (follow: FollowScreens) => void;
  };
}

export interface Background {
  /** `~/.verifold/credentials/owners`, where each background owner keeps its control. */
  readonly keys: string;
  /** Start `verifold owner` for a project in a detached process. `input` is its only input. */
  readonly start: (root: string, input: string) => Promise<void>;
  /** The input of this process when it is `verifold owner`. */
  readonly input: () => Promise<string>;
}
/** Help for one command, for `verifold <command> --help`. Other commands print the full help. */
const commandHelp: Record<string, string> = {
  stop: `verifold stop [--workspace path]

Stops the team that works in the background in this project. The agents pause.
A task turn that runs now stops, and its work waits for your review. Pods stop
after their results come back. Run verifold in the project to start the team
again.`,
};

const help = `Verifold - private research with your existing agent harness

verifold [--no-open] [--desk]         Open Verifold in your browser: set up and ask a question, or open this project's lab
verifold stop                         Stop the team that works in the background, with its pods
verifold status                       Print workspace JSON
verifold profile [--setup]            Inspect or configure your global profile
verifold runpod key set [--file]      Store a RunPod API key from hidden input or stdin, after a check
verifold runpod key status|check|remove
                                      Show where the key is, check it with RunPod, or remove it
verifold runpod secret set NAME [--file]
                                      Store a secret for pods, such as HF_TOKEN, from hidden input or stdin
verifold runpod secret list|remove NAME
                                      List the secret names, or remove one
verifold pods [stop <lease|all>]      List the GPU pod leases, or stop pods when Verifold does not run

Older commands, for the old desk and the research flow:
verifold ui [--no-open] [--desk]      Open this project, as a bare verifold does
verifold init [--host claude|codex] [--topic field] [--autonomy guided|autonomous]
verifold init --setup-only [--profile profile.json] [--host name]
verifold research [--topic field] [--feedback text] [--approve] [--autonomy guided|autonomous]
verifold recommend                    Print a research request for your host
verifold ideas --from ideas.json       Import host recommendations
verifold select [--id idea-id]         Choose an idea explicitly
verifold literature [--memory]        Print an optional paper/context request
verifold handoff                      Print a planning request for your harness
verifold view                         Generate a private local HTML workspace
verifold session --prompt text [--host claude|codex] [--mode ask|auto] [--model name] [--no-open]
                                      Run one harness session; answer its requests here or in the old desk

Options: --workspace path (default: the current folder), --help, --version

In a folder without a project, verifold opens the first run in your browser:
your agents, a short profile, skills, and the GPU limits that new projects
start with. Then the Ask page takes your question, and a lab starts on it.
Several agents each own a direction and post what they find, with proof, on
one board. They check each other's claims, and they ask you only about money,
scope, access, or more time. Runs go on this computer, or on RunPod GPU pods
within the limits that you set. In a project, verifold opens its lab.

With a terminal, the team works in a background process, so closing the
terminal or Ctrl+C does not stop it. The terminal shows the lab in a few lines.
Type /help there for its commands, and run verifold stop to stop the team.
--no-open prints the URL instead of opening a browser. --agency-dir keeps your
profile in another folder (default: ~/.verifold/agency).

--desk opens the old desk instead, for this release. In a folder without a
project, it sets up the project in the old desk, or in the terminal with
--no-open. verifold init and verifold research run the older research flow:
research searches the web and proposes directions, and after you choose one,
the coordinator plans tasks, and task agents run the experiments. That flow
works in the old desk. Verifold keeps its records in .verifold/, and Claude
Code or Codex keeps its own permissions and sessions. Session records are in
.verifold/sessions/.
`;

/** The commands of the terminal. A terminal on a background owner only detaches with Ctrl+C. */
const terminalHelp = (
  background: boolean,
): string => `Commands in this terminal:
- \`/open\` or \`/app\`: open Verifold in your browser. Add the ID of a call, for example \`/app c-3\`, to open that call.
- Enter on an empty line, in a lab: open the call that waits for you, or else the lab.
- \`/desk\`: open the old desk in your browser, for this release. In a terminal that started with --desk, \`/open\` and Enter open it too.
- \`/start\` and a request: start a session with the project's harness in Ask me mode.
- \`/resume\`: resume the latest paused or interrupted session. Without a recorded conversation, its first request runs again.
- \`/research\`: continue research. In a project without research, add the question.
- \`/approve\`: approve the research plan.
- \`/feedback\` and your changes: revise the plan or the directions.
- \`/select\` and a direction ID: choose the direction when research did not draft a plan. The coordinator then drafts it.
- \`a\` or \`d\`: allow once or deny the open request. If several are open, add the ID, for example \`a R2\`.
- \`/cancel\`: stop the research step or the current turn. If both run, choose in the old desk.
- \`/end\`: end the session.
- \`/help\`: show these commands.

When the agent of your session waits for you, other text goes to it as a follow-up. Without a session, in a lab, other text goes to the board as your message. Write @claude-2 in it to write to that agent. ${background ? 'Ctrl+C leaves this terminal, and the team keeps working. To stop it, run verifold stop.' : 'Ctrl+C pauses the session and stops Verifold.'}`;

const requestHint = 'Type a to allow once or d to deny.';

/** The lines of a request's change that the terminal shows, at most. */
const requestLines = 40;

/** Why a request asks, on one line. */
function requestReason(request: Pick<PendingRequest, 'reason'>): string {
  return request.reason ? `Why: ${request.reason.replace(/\s+/g, ' ')}` : '';
}

/**
 * Why a request asks, and the change that it would make, under its line. The
 * harness wrote both, so each line has a margin that no Verifold line has.
 * The session removed their control characters when it recorded the request
 * (see clean() in core/session.ts).
 */
function requestText(
  request: Pick<PendingRequest, 'reason' | 'detail'>,
): string {
  const reason = request.reason ? [`  ${requestReason(request)}`] : [];
  const lines = request.detail ? request.detail.split('\n') : [];
  const change = lines.slice(0, requestLines).map((line) => `  │ ${line}`);
  if (lines.length > requestLines)
    change.push(`  │ … ${lines.length - requestLines} more lines`);
  return [...reason, ...change].map((line) => `\n${line}`).join('');
}

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
 * One terminal line for a session event, and its line for the owner's log.
 * Harness tool events stay in the desk, so they have none. `worker` names the
 * session when two can run. The terminal shows a request in full, with the
 * change that it would make, so that the person can answer it there. The
 * log gets only the request's ID and why it asks: the change and the tool's
 * input stay out of diagnostics.
 */
export function feedLine(
  event: SessionEvent,
  worker?: string,
  request?: Pick<PendingRequest, 'id' | 'reason' | 'detail'>,
): { readonly text: string; readonly log: string } | null {
  if (event.kind === 'tool') return null;
  const time = new Date(event.at).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const head = `${time}  ${worker ? `${worker} · ` : ''}${feedLabels[event.kind]}: `;
  if (event.kind === 'request') {
    const id = request?.id ?? /^R\d+(?=:)/.exec(event.text)?.[0] ?? 'a request';
    const reason = request ? requestReason(request) : '';
    return {
      // One line for the request, so harness text cannot print a line that looks like one.
      text: `${head}${event.text.replace(/\s*\n\s*/g, ' ⏎ ')}${request ? requestText(request) : ''}\n${requestHint}`,
      log: `${head}${id}.${reason ? ` ${reason}` : ''}`,
    };
  }
  // One line for each event, so harness text cannot print a line that looks like a request.
  const line = event.text.replace(/\s*\n\s*/g, ' ⏎ ');
  const text = event.kind === 'agent' ? clip(line, 600) : line;
  return { text: `${head}${text}`, log: `${head}${text}` };
}

/** What the owner terminal can do besides session actions. */
export interface TerminalControls {
  /**
   * Open Verifold in a browser with a new one-time code: the app, or the old
   * desk when the package has no app build. `call`: the ID of a call to open
   * there, such as c-3.
   */
  readonly openApp: (call?: string) => void;
  /** Open the old desk in a browser with a new one-time code. */
  readonly openDesk: () => void;
  /** The harness for a session that the terminal starts. */
  readonly host: string;
  /** The terminal is attached to a background owner. */
  readonly background?: boolean;
  readonly research?: ResearchRunner;
  /** The project's lab. Text that is not a command goes to its board. */
  readonly lab?: Pick<Lab, 'exists' | 'post'>;
}

/**
 * A line of a terminal that started with --desk: there, /open, alone or with
 * the ID of a call as Enter on an empty line sends it, opens the old desk.
 * /app still opens the app.
 */
export function deskTerminalLine(line: string): string {
  return /^\/open(?: c-[1-9][0-9]{0,5})?$/.test(line.trim()) ? '/desk' : line;
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
  // Lab agents take posts on the board, not terminal input.
  const live = sessions
    .views()
    .filter((view) => view.live && !view.record.agent);
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
        ? `${found.length} sessions match. Choose one in the old desk: type /desk.`
        : none,
    );
    return null;
  };
  const answer = /^([ad])(?:\s+(r\d+))?$/i.exec(value);
  const report = (error: unknown): void =>
    io.progress?.(
      error instanceof SessionActionError
        ? error.message
        : 'The terminal action failed. Check the session in the old desk: type /desk.',
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
    } else if (value === '/app' || value === '/open') controls.openApp();
    else if (/^\/(?:app|open) c-[1-9][0-9]{0,5}$/.test(value))
      controls.openApp(value.slice(value.indexOf(' ') + 1));
    else if (value.startsWith('/app ') || value.startsWith('/open '))
      io.progress?.(
        'Write /app and the ID of a call, for example /app c-3, or /app alone.',
      );
    else if (value === '/desk') controls.openDesk();
    else if (value.startsWith('/desk '))
      io.progress?.('Write /desk alone to open the old desk.');
    else if (value === '/help')
      io.progress?.(terminalHelp(controls.background === true));
    else if (value === '/cancel') {
      const turns = live.filter((view) => view.record.status !== 'idle');
      // Research and a turn can run together. Then the old desk chooses which one stops.
      if (controls.research?.running && turns.length)
        io.progress?.(
          `Research and ${turns.length === 1 ? 'a session' : `${turns.length} sessions`} run. Choose what to cancel in the old desk: type /desk.`,
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
    } else if (controls.lab?.exists)
      // The same post as the app's box. A mention such as @claude-2 wakes that agent.
      controls.lab
        .post({ text: value })
        .then(() => io.progress?.('Your message is on the board.'), report);
    else
      io.progress?.(
        'No session is running, so this text went nowhere. Type /start and a request.',
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
  /** `--lab` in a project that exists: start a lab on its saved question, unless it has one. */
  readonly lab?: boolean;
  /** `--desk`: open the old desk instead of the app. */
  readonly useDesk?: boolean;
  /** The folder of the person's profile. Default: `~/.verifold/agency`. */
  readonly agency?: string;
  /** The time budget, in hours, of a lab that starts on `research`. */
  readonly hours?: number | undefined;
  /** Open the desk on this port, with this token, so the tab of a closed desk keeps working. */
  readonly reuse?: DeskPlace | undefined;
  /** This process is the background owner. Its control is saved under its owner ID while it owns the project. */
  readonly owner?: {
    readonly control: Control;
    readonly keys: string;
    readonly desk?: DeskPlace | undefined;
  };
}

/** Where a desk serves, so a background owner opens its own desk there and the open tab keeps working. */
function placeOf(desk: DeskServer): DeskPlace {
  const place = new URL(desk.url);
  return {
    port: Number(place.port),
    token: place.hash.slice(1),
    pages: Number(new URL(desk.pages).port),
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
  const open = async (
    where: '/app/' | '/desk' = run.useDesk ? '/desk' : '/app/',
    call?: string,
  ): Promise<boolean> =>
    desk
      ? (io.browse ?? openDeskBrowser)(
          desk.launchUrl(where, call && `/call/${call}`),
          deskSignal,
        )
      : false;
  const announce = async (server: DeskServer, ready: string): Promise<void> => {
    io.out(
      JSON.stringify({
        url: run.useDesk ? server.deskUrl : server.url,
        // A background owner passes the app's URL on too. A terminal that attached with --desk leaves it out.
        ...(server.appUrl && !run.useDesk ? { app: server.appUrl } : {}),
        // A terminal that attaches with --desk prints the old desk's URL, from here.
        ...(run.owner ? { desk: server.deskUrl } : {}),
        visibility: 'private',
        readOnly: false,
      }),
    );
    // The terminal that attaches to a background owner opens the page.
    if (run.owner) return;
    if (run.noOpen)
      io.progress?.(
        run.useDesk || !server.appUrl
          ? 'Open the printed URL to use the old desk. Keep this terminal open. Type /help for commands.'
          : 'Open the printed URL to use Verifold. Keep this terminal open. Type /help for commands.',
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
        {
          stop: () => quit.abort(),
          ...(io.appAssets ? { appRoot: io.appAssets } : {}),
        },
      );
      await announce(
        desk,
        'Set up your project in the old desk. This terminal shows each step. Ctrl+C cancels setup.',
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
        const place = placeOf(desk);
        stop.abort();
        await desk.closed;
        return { root, research, desk: place };
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
        lab?: Lab;
        runner?: ResearchRunner;
        session?: string;
      } = {};
      // One run has one team: the coordinator's team or a lab. Every start of either one asks this guard.
      const team = new RunTeam({
        lab: () => owned.lab?.exists ?? false,
        coordinator: async () =>
          Boolean(
            owned.coordinator?.view()?.state ||
              (await owned.tasks?.list())?.length,
          ),
        researchBusy: () => owned.runner?.busy ?? false,
        root,
      });
      // Usage windows belong to the harness accounts. Every session reports them here.
      const quota = new Quota(root);
      await quota.load();
      // The person's profile: the lab reads it for each prompt, its added skills load for each agent's session,
      // and pods read its monthly limit across projects at each check.
      const agency = run.agency ?? agencyDirectory(root);
      const sessions: SessionPool = new SessionPool(root, {
        clientVersion: version,
        ownerId: owner.ownerId,
        skills: skillLoader(
          agency,
          pluginsHome(),
          (text) => void owned.lab?.note(text),
        ),
        agents:
          (await loadWorkspace(root).catch(() => null))?.agents ??
          defaultAgents,
        onLimit: (host, signal) => {
          quota.record(host, signal);
          owned.lab?.limited(host, signal);
        },
        // Lab agents' turns go to the lab. Task turns come through onTaskTurn.
        onTurnEnd: (record, outcome) => owned.lab?.turnEnded(record, outcome),
        // The person's own session that finds every slot taken gets the slot of a lab agent that had its turn. Tasks never do: a lab run has no tasks.
        makeRoom: () => owned.lab?.yieldSlot() ?? Promise.resolve(false),
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
          // The events of task workers stay in the desk. A session that the person controls prints its events here, a request with its change.
          const line =
            io.interactive && !view?.record.task && !view?.record.agent
              ? feedLine(
                  event,
                  view ? hostName(view.record.host) : undefined,
                  event.kind === 'request'
                    ? view?.record.requests.find((request) =>
                        event.text.startsWith(`${request.id}:`),
                      )
                    : undefined,
                )
              : null;
          if (line && io.feed) io.feed(line.text, line.log);
          else if (line) io.progress?.(line.text);
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
      // A lease change shows in the terminal and wakes the coordinator, unless the coordinator made it or the change wakes no one.
      // A lease of lab directions wakes their agents instead.
      // Before a pod stops, its tasks' results and its lab runs' outputs come back.
      const compute = computeFor(
        root,
        io,
        (lease, line, wake) => {
          io.progress?.(`Pod ${line}`);
          if (!wake) return;
          if (lease.directions?.length) owned.lab?.leaseChanged(lease, line);
          else if (lease.history.at(-1)?.by !== 'coordinator')
            owned.coordinator?.notify({ kind: 'pod', text: line });
        },
        (task) => owned.tasks?.folderOf(task) ?? Promise.resolve(null),
        (lease) => owned.lab?.podStops(lease) ?? Promise.resolve(),
        agency,
      );
      // The project memory follows every change of the records, and every agent reads its index.
      const memory = new ProjectMemory(
        root,
        () => owned.tasks?.list() ?? Promise.resolve([]),
        () => owned.lab?.progress() ?? null,
        async () => {
          const store = new ResultsStore(root);
          await store.load();
          return store.current();
        },
      );
      const remember = (): void => memory.schedule();
      const tasks = new TaskManager(root, {
        ownerId: owner.ownerId,
        sessions,
        ...(io.progress ? { progress: io.progress } : {}),
        onEvent: (event) => owned.coordinator?.notify(event),
        pods: compute.podTools(),
        memory,
        team,
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
          // A start that the run's guard refuses throws its reason, which research shows, and the messages stay.
          await owned.coordinator?.startForDirection(await loadWorkspace(root));
          // The messages that waited for research wait for the coordinator now, also one that the person starts later.
          await tasks.passToCoordinator();
        },
        team,
        inbox: {
          post: (text) => tasks.post('research', text),
          take: () => tasks.takeResearch(),
        },
        onChange: remember,
      });
      owned.runner = runner;
      // The coordinator has its own session, outside the worker slots.
      const coordinator = new Coordinator(root, {
        tasks,
        compute,
        memory,
        quota,
        agents: () => sessions.limit,
        team,
        onChange: remember,
        ...(io.progress ? { progress: io.progress } : {}),
        sessions: new SessionManager(root, {
          clientVersion: version,
          ownerId: owner.ownerId,
          onTurnEnd: (record) => owned.coordinator?.turnEnded(record),
          onLimit: (host, signal) => {
            quota.record(host, signal);
            owned.coordinator?.limited(signal);
          },
        }),
      });
      owned.coordinator = coordinator;
      // The lab's agents share the worker slots with tasks and plain sessions.
      const lab = new Lab(root, {
        sessions,
        memory,
        quota,
        team,
        model: async (host) =>
          labModel(
            host,
            await loadWorkspace(root).catch(() => null),
            (await loadSettings(agency).catch(() => null))?.agency,
          ),
        person: profileReader(agency),
        // A profile folder outside the default one is closed to the lab's sessions and runs too.
        ...(agency === agencyDirectory(root) ? {} : { denyRead: [agency] }),
        // The project's team: its main harness plans the lab.
        harnesses: async () => {
          const workspace = await loadWorkspace(root);
          return [workspace.host, workspace.helper].filter(
            (host): host is 'claude' | 'codex' =>
              host === 'claude' || host === 'codex',
          );
        },
        // A process that runs one session of the person shows the lab. Its agents work only with the project's owner.
        runs: session === undefined,
        compute,
        onChange: remember,
        ...(io.progress ? { progress: io.progress } : {}),
      });
      owned.lab = lab;
      /** Why the lab's start failed, for the app. */
      let labProblem: string | null = null;
      // While an agent works, a lab run runs, or a pod runs, a Mac does not go to idle sleep. So the work and the idle stop of a pod go on.
      // Lease recovery that waits for the lab's pod runs. The owner's stop waits for it.
      let leasesRecovered: Promise<void> = Promise.resolve();
      const awake = new KeepAwake();
      const working = setInterval(() => {
        awake.set(
          runner.running ||
            lab.running ||
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
        // The leases come first: the lab's runs on pods recover through them, before lease recovery stops the pods.
        await compute.load();
        await lab.load();
        remember();
        // Only the owner of the project recovers leases: a pod that runs now outlived an earlier owner.
        // The lab's pod runs of an earlier owner read their jobs first, in the background, so the desk opens at once.
        const pending = lab.podRunsRecovering;
        if (pending)
          leasesRecovered = pending
            .then(() => compute.leases.recover())
            .catch(() => {
              /* recover() keeps its problem for the view. */
            })
            .then(() => compute.watch());
        else {
          await compute.leases.recover();
          compute.watch();
        }
        const stopped = await tasks.settle();
        // Agents whose direction is open resume one at a time, each with a digest.
        lab.resumeAll();
        if (stopped)
          io.progress?.(
            `Verifold stopped earlier while ${stopped === 1 ? 'a task was' : `${stopped} tasks were`} running. Review the saved work in the old desk: type /desk.`,
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
            lab,
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
            {
              stop: () => quit.abort(),
              reuse: run.owner?.desk ?? run.reuse,
              lab,
              // The app shows why the lab did not start, and offers to start it again.
              startProblem: () => labProblem,
              // The app opens the first run here too, to change the profile.
              firstRun: new FirstRun({
                directory: agency,
                compute,
                signal: deskSignal,
                harness,
              }),
              ...(io.appAssets ? { appRoot: io.appAssets } : {}),
            },
          );
          await announce(
            desk,
            run.useDesk || !desk.appUrl
              ? 'The old desk is open in your browser. Keep this terminal open. Type /help for commands.'
              : 'Verifold is open in your browser. Keep this terminal open. Type /help for commands.',
          );
        }
        // A view follows the lab. Without a lab, it builds nothing, after one last screen that says so.
        const server = desk;
        io.screens?.serve?.((show) => {
          let shown = false;
          return server.screens(
            (screen) => {
              shown = screen !== null;
              show(screen);
            },
            () => lab.exists || shown,
          );
        });
        const paused = sessions.paused().length;
        if (paused && !session)
          io.progress?.(
            `${paused === 1 ? '1 session is' : `${paused} sessions are`} paused. Type /resume, or resume one in the old desk: type /desk.`,
          );
        const lead = coordinator.view();
        if (lead?.session && !lead.session.live && !lead.state.stoppedAt)
          io.progress?.(
            'The coordinator paused when Verifold stopped. Resume it under Coordinator in the old desk: type /desk.',
          );
        // The question of setup starts a lab: the lab is the default. --lab still starts one in a project that exists.
        if (research || run.lab)
          labProblem = await startLab(root, lab, research ?? {}, io, run.hours);
        io.listen?.(
          (line) =>
            terminalInput(
              sessions,
              run.useDesk ? deskTerminalLine(line) : line,
              io,
              {
                host,
                background: run.owner !== undefined,
                research: runner,
                lab,
                openApp: (call) => {
                  // Without the app's build, the launch opens the old desk.
                  void open('/app/', call).then((opened) =>
                    io.progress?.(
                      !opened
                        ? 'The browser could not open. Open the printed URL.'
                        : !desk?.appUrl
                          ? 'This Verifold has no app build, so the old desk opened in your browser.'
                          : call
                            ? `Call ${call} opened in your browser.`
                            : 'Verifold opened in your browser.',
                    ),
                  );
                },
                openDesk: () => {
                  void open('/desk').then((opened) =>
                    io.progress?.(
                      opened
                        ? 'The old desk opened in your browser.'
                        : 'The browser could not open. Open the printed URL with /desk after its port number.',
                    ),
                  );
                },
              },
            ),
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
        await lab.close();
        // Lease recovery after the lab's pod runs ends before the pods stop.
        await leasesRecovered;
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
/**
 * `verifold` in a folder without a project: the app with no project, for
 * the first run and the Ask page. No owner starts until the person asks
 * a question. Then the desk closes, and the new project comes back with the
 * desk's port and token, so a background owner takes over and the open tab
 * keeps working. Ctrl+C stops it, and returns nothing.
 */
async function serveStart(
  root: string,
  io: CliIO,
  signal: AbortSignal,
  run: {
    readonly noOpen: boolean;
    /** The folder of the person's profile. */
    readonly agency: string;
    readonly harness: typeof runHarness;
  },
): Promise<(Begun & { readonly desk: DeskPlace }) | undefined> {
  // The RunPod key belongs to this computer, so the first run stores it without a project.
  const compute = computeFor(
    root,
    io,
    undefined,
    undefined,
    undefined,
    run.agency,
  );
  await compute.load();
  // The desk closes after the person starts a project.
  const handed = new AbortController();
  const deskSignal = AbortSignal.any([signal, handed.signal]);
  const ask = askStart({ root, agency: run.agency, signal: deskSignal });
  const desk = await startDesk(
    null,
    deskSignal,
    io.deskAssets,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      firstRun: new FirstRun({
        directory: run.agency,
        compute,
        signal: deskSignal,
        harness: run.harness,
      }),
      start: ask.start,
      ...(io.appAssets ? { appRoot: io.appAssets } : {}),
    },
  );
  const app = desk.appUrl;
  if (!app) {
    // The launch checked for the app's build first. When it went away since, nothing stays running.
    handed.abort();
    await desk.closed;
    throw new Error(
      'This Verifold package has no app build. Run verifold --desk to set up the project in the old desk.',
    );
  }
  io.out(
    JSON.stringify({
      url: desk.url,
      app,
      visibility: 'private',
      readOnly: false,
    }),
  );
  const open = (): Promise<boolean> =>
    (io.browse ?? openDeskBrowser)(desk.launchUrl('/app/'), signal);
  io.progress?.(
    run.noOpen
      ? 'Open the printed app URL to set up Verifold. Keep this terminal open. Ctrl+C stops it.'
      : (await open())
        ? 'Set up Verifold in your browser. Keep this terminal open. Ctrl+C stops it.'
        : 'The browser could not open. Open the printed app URL. Keep this terminal open.',
  );
  io.listen?.((line) => {
    const value = line.trim();
    if (value === '/app' || value === '/open')
      void open().then((opened) =>
        io.progress?.(
          opened
            ? 'The app opened in your browser.'
            : 'The browser could not open. Open the printed app URL.',
        ),
      );
    else if (value === '/desk' || value.startsWith('/desk '))
      io.progress?.(
        'The old desk opens only in a project. To set up this project there, press Ctrl+C and run verifold --desk.',
      );
    else if (value)
      io.progress?.(
        'Set up Verifold in the app. Type /app to open it again. Ctrl+C stops it.',
      );
  }, deskSignal);
  const begun = await Promise.race([
    ask.begun,
    desk.closed.then(() => undefined),
  ]);
  if (!begun) return undefined;
  // ponytail: a short wait lets the answer to the start reach the page before the desk drops its connections. The page checks for the new desk either way.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const place = placeOf(desk);
  handed.abort();
  await desk.closed;
  return { ...begun, desk: place };
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

/**
 * After setup, start a lab on its question, unless the project has one. The
 * lab says why it cannot start, for example when the coordinator's team works
 * on the run. A failure does not stop the owner.
 */
async function startLab(
  root: string,
  lab: Lab,
  research: ResearchOptions,
  io: CliIO,
  hours?: number,
): Promise<string | null> {
  if (lab.exists) {
    io.progress?.(
      'This project has a lab already, so Verifold started nothing new. Type /app to open it.',
    );
    return null;
  }
  try {
    const asked = research.topic ?? (await loadWorkspace(root)).research?.topic;
    if (!asked) {
      io.progress?.(
        'The project has no question yet, so Verifold started no lab. Type /app, then ask your question there.',
      );
      return null;
    }
    // The same start as the desk's: the setup question stays with the project.
    const planned = await startLabOn(
      root,
      lab,
      asked,
      research.autonomy,
      hours,
    );
    io.progress?.(
      planned
        ? 'The lab started. Its first agent reads the question and posts a plan on the board.'
        : 'The lab started without an agent that plans it. Type /app, then open a direction there: each one gets its own agent.',
    );
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    io.progress?.(`Verifold started no lab: ${reason}`);
    return reason;
  }
}

/** The question of setup and the setup desk that a background owner gets in its input. Anything else is left out. */
function ownerStart(value: unknown): {
  readonly research: ResearchOptions | undefined;
  readonly desk: DeskPlace | undefined;
  readonly lab: boolean;
  readonly agency: string | undefined;
  readonly hours: number | undefined;
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
    lab: data.lab === true,
    // The profile folder of `--agency-dir`, as an absolute path.
    agency:
      typeof data.agency === 'string' &&
      isAbsolute(data.agency) &&
      data.agency.length <= 4096
        ? data.agency
        : undefined,
    // The time budget from the Ask page. The lab checks it again.
    hours:
      Number.isSafeInteger(data.hours) && (data.hours as number) > 0
        ? (data.hours as number)
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
  const { research, desk, lab, agency, hours } = ownerStart(input);
  // The profile that the lab reads. A terminal that attaches with another one hears so.
  const profile = agency ?? agencyDirectory(root);
  const quit = new AbortController();
  // Lines from before the first terminal attached wait for it.
  let early: { readonly progress: string; readonly feed?: true }[] | null = [];
  /** The URLs with the desk's token: its own, the app's when the package has the app's build, and the old desk's. */
  let urls:
    | { readonly url: string; readonly app?: string; readonly desk?: string }
    | undefined;
  /**
   * The lab's screens, built only while a terminal is attached: the desk's
   * watch, its stop while it runs, and its newest screen.
   */
  let follow: FollowScreens | undefined;
  let unfollow: (() => void) | undefined;
  let screen: LabScreen | null | undefined;
  /** A new watch sends a fresh screen to every terminal at once. */
  const watch = (): void => {
    if (unfollow || !follow || !server.terminals()) return;
    unfollow = follow((next) => {
      screen = next;
      server.send({ screen: next });
    });
  };
  let onLine: ((line: string) => void) | undefined;
  const waiting: string[] = [];
  const server = await serveControl(control, {
    attached: (send) => {
      for (const message of early ?? []) send(message);
      early = null;
      if (urls) send({ ...urls, agency: profile });
      // A screen is fresh only while the watch runs for another terminal.
      if (unfollow && screen !== undefined) send({ screen });
      else watch();
    },
    detached: () => {
      if (server.terminals()) return;
      unfollow?.();
      unfollow = undefined;
      screen = undefined;
    },
    message: (message) => {
      if ('stop' in message) quit.abort();
      else if (onLine) onLine(message.line);
      else if (waiting.length < 20) waiting.push(message.line);
    },
  });
  const log = ownerLog(root);
  /** `logged`: the line for the log, when it leaves out part of `value`. */
  const progress = (value: string, feed = false, logged = value): void => {
    log(logged);
    const message = feed
      ? { progress: value, feed: true as const }
      : { progress: value };
    if (early && early.length < 50) early.push(message);
    server.send(message);
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
              urls = {
                url: shown.url,
                ...('app' in shown && typeof shown.app === 'string'
                  ? { app: shown.app }
                  : {}),
                ...('desk' in shown && typeof shown.desk === 'string'
                  ? { desk: shown.desk }
                  : {}),
              };
              server.send({ ...urls, agency: profile });
            }
          } catch {
            /* Only the desk URL is output. */
          }
        },
        // Harness tool events belong in the desk, as in a terminal.
        progress: (value, source) => {
          if (source !== 'tool') progress(value);
        },
        // A request's change goes to the terminals, never to the log.
        feed: (line, logged) => progress(line, true, logged),
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
        // The desk's watch of the lab runs only while a terminal is attached to show it.
        screens: {
          serve: (start) => {
            follow = start;
            watch();
          },
        },
      },
      AbortSignal.any([signal, quit.signal]),
      {
        noOpen: true,
        research,
        hours,
        harness,
        lab,
        agency: profile,
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
    readonly lab?: boolean;
    /** `--desk`: open the old desk instead of the app. */
    readonly useDesk?: boolean;
    /** The profile folder of `--agency-dir`. */
    readonly agency?: string | undefined;
    /** The time budget, in hours, of the lab that starts on `research`. */
    readonly hours?: number | undefined;
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
    if (start.lab)
      io.progress?.(
        'Verifold already works in the background, so --lab started nothing. Type /app, then start the lab there.',
      );
  } else {
    control = await newControl();
    try {
      await background.start(
        root,
        JSON.stringify({
          ...control,
          ...(start.research ? { research: start.research } : {}),
          ...(start.desk ? { desk: start.desk } : {}),
          ...(start.lab ? { lab: true } : {}),
          ...(start.agency ? { agency: start.agency } : {}),
          ...(start.hours ? { hours: start.hours } : {}),
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
      if ('progress' in message)
        (message.feed ? (io.feed ?? io.progress) : io.progress)?.(
          message.progress,
        );
      else if ('screen' in message) io.screens?.show?.(message.screen, true);
      else if ('url' in message && !shown) {
        shown = true;
        // An owner that ran already keeps the profile that it started with.
        const wanted = start.agency ?? agencyDirectory(root);
        if (message.agency && message.agency !== wanted)
          io.progress?.(
            `The running Verifold uses the profile in ${message.agency}, so stop it with verifold stop to use another.`,
          );
        const app = start.useDesk ? undefined : message.app;
        io.out(
          JSON.stringify({
            // An owner of an earlier version sends no desk URL. Its URL opens the old desk.
            url: start.useDesk ? (message.desk ?? message.url) : message.url,
            ...(app ? { app } : {}),
            visibility: 'private',
            readOnly: false,
          }),
        );
        // After setup, the open tab moves to the background owner when it got the same port.
        if (start.desk && new URL(message.url).port === String(start.desk.port))
          io.progress?.('The page in your browser now shows the project.');
        else if (start.noOpen)
          io.progress?.(
            start.useDesk
              ? 'Open the printed URL to use the old desk.'
              : 'Open the printed URL to use Verifold.',
          );
        else client?.send({ line: start.useDesk ? '/desk' : '/app' });
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
  // The owner serves every terminal, so this one turns /open into /desk itself.
  io.listen?.(
    (line) =>
      connection.send({
        line: start.useDesk ? deskTerminalLine(line) : line,
      }),
    until,
  );
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
      'Verifold stopped before its page opened. Check .verifold/owner.log in the project.',
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
      `Verifold stopped earlier without saving the end of its work. ${parts.join(' and ')} stopped with an unknown outcome.${stopped ? ` Verifold stopped ${stopped} harness ${stopped === 1 ? 'process' : 'processes'} that kept running.` : ''} Resume a session with /resume, or in the old desk: type /desk. Continue research to run the step again.`,
    );
}

/** The compute settings, RunPod key, and pod leases of a project, with the test hooks of the I/O. */
/**
 * The Compute of a project. Each one can change leases, so each one keeps
 * the project's record for the monthly limit across projects, in the profile
 * at `agency` (default: ~/.verifold/agency).
 */
function computeFor(
  root: string,
  io: CliIO,
  onChange?: (lease: Lease, line: string, wake: boolean) => void,
  taskFolder?: (task: string) => Promise<TaskPlace | null>,
  runsStop?: (lease: string) => Promise<void>,
  agency: string = agencyDirectory(root),
): Compute {
  return new Compute(root, {
    store: new KeyStore(io.compute?.store),
    ...(io.compute?.url ? { url: io.compute.url } : {}),
    ...(io.compute?.programs ? { programs: io.compute.programs } : {}),
    ...(onChange ? { onChange } : {}),
    ...(taskFolder ? { taskFolder } : {}),
    ...(runsStop ? { runsStop } : {}),
    month: new GpuMonth({ agency, root }),
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
        ...(lease.directions ? { directions: lease.directions } : {}),
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
      lab: { type: 'boolean' },
      app: { type: 'boolean' },
      desk: { type: 'boolean' },
      file: { type: 'boolean' },
      mode: { type: 'string' },
      prompt: { type: 'string' },
    },
  });
  if (values.help) {
    io.out(commandHelp[positionals[0] ?? ''] ?? help);
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
    ui: ['no-open', 'lab', 'app', 'desk'],
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
      !(
        launch &&
        (key === 'no-open' ||
          key === 'agency-dir' ||
          key === 'lab' ||
          key === 'app' ||
          key === 'desk')
      ) &&
      !allowed[command]?.includes(key)
    )
      throw new Error(`--${key} is not valid for ${command}.`);
  // --app is the default now. It still works, and changes nothing, for one release.
  if (values.app && values.desk)
    throw new Error('Choose --app or --desk, not both.');
  const useDesk = values.desk === true;
  // The lab is the default for a new project. In a project that exists, --lab still starts one on its question.
  if (values.lab)
    io.progress?.(
      command === 'init'
        ? '--lab is no longer needed: a new project starts a lab after setup.'
        : "--lab is no longer needed for a new project, which starts a lab after setup. Here it starts a lab on the project's question.",
    );
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
    // While the old desk exists, a project whose run is from the research
    // flow opens there by default: the app shows that run only in History.
    const researchFlow =
      !useDesk && !values.app && (await researchRunOnDisk(root));
    if (researchFlow)
      io.progress?.(
        "This project uses the earlier research flow, so it opens in the old desk. Its records also show read-only in the app's History.",
      );
    const desk = useDesk || researchFlow;
    // The app has its own first run. Only the old desk asks for the profile in the terminal.
    if (launch && desk) {
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
    const lab = values.lab ?? false;
    const agency =
      values['agency-dir'] === undefined
        ? undefined
        : agencyDirectory(cwd, values['agency-dir']);
    if (io.interactive && io.background)
      await attachTeam(root, io, signal, io.background, {
        noOpen,
        lab,
        useDesk: desk,
        agency,
      });
    else
      await serveDesk(root, io, signal, {
        noOpen,
        lab,
        useDesk: desk,
        ...(agency ? { agency } : {}),
      });
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
    // The app shows no plain sessions, so a session opens the old desk.
    await serveDesk(root, io, signal, {
      noOpen: values['no-open'] ?? false,
      useDesk: true,
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
    // A bare verifold in a new folder opens the app's first run and Ask page. --desk keeps the old setup.
    // Without the app's build, setup goes the way of --desk.
    const toApp = launch && !useDesk && (await hasAppBuild(io.appAssets));
    if (launch && !useDesk && !toApp)
      io.progress?.(
        values['no-open']
          ? 'This Verifold has no app build, so setup runs in this terminal.'
          : 'This Verifold has no app build, so setup opens in the old desk.',
      );
    if (toApp) {
      const extra = (
        ['profile', 'host', 'model', 'topic', 'autonomy', 'setup-only'] as const
      ).find((key) => values[key] !== undefined);
      if (extra)
        throw new Error(
          `verifold opens the first run in your browser, where you choose the rest. Run it without --${extra}, or run verifold init.`,
        );
      const agency = agencyDirectory(cwd, values['agency-dir']);
      const begun = await serveStart(root, io, signal, {
        noOpen: values['no-open'] ?? false,
        agency,
        harness,
      });
      if (!begun) return;
      io.progress?.(`The project is in ${begun.root}. Its lab starts now.`);
      const research = {
        topic: begun.question,
        autonomy: 'autonomous' as const,
      };
      // The new project goes to a background owner on the same port and token, so the tab keeps working.
      const background = io.interactive ? io.background : undefined;
      if (background)
        await attachTeam(begun.root, io, signal, background, {
          noOpen: values['no-open'] ?? false,
          research,
          desk: begun.desk,
          agency,
          hours: begun.hours,
        });
      else
        await serveDesk(begun.root, io, signal, {
          noOpen: true,
          research,
          hours: begun.hours,
          harness,
          agency,
          reuse: begun.desk,
        });
      return;
    }
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
      // A bare verifold starts a lab after setup, so setup offers no research stop.
      ...(launch ? { lab: true } : {}),
    };
    // verifold --desk in a new folder sets up in the old desk. init and --no-open stay the terminal path.
    // With a terminal, setup hands the project to a background owner.
    const background = io.interactive ? io.background : undefined;
    if (launch && !values['no-open']) {
      const handoff = await serveDesk(root, io, signal, {
        harness,
        setup: { cwd, options },
        handoff: background !== undefined,
        useDesk: true,
      });
      if (handoff && background)
        await attachTeam(handoff.root, io, signal, background, {
          noOpen: false,
          research: handoff.research,
          desk: handoff.desk,
          useDesk: true,
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
        useDesk: true,
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
    // One run has one team: research does not work on a lab's run.
    if (await labOnDisk(root)) throw new Error(labWorks);
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
    if (await labOnDisk(root)) throw new Error(labWorks);
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
  const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verifold — private workspace</title><style>body{font:16px system-ui;background:#f8f7fa;color:#101014;max-width:900px;margin:50px auto;padding:24px}h1{color:#4c1d95}article{padding:20px 0;border-top:1px solid #ddd}p{line-height:1.7}</style><h1>Verifold</h1><p>Private workspace · managed by the CLI · ${e(workspace.profile.name)}</p><p>${workspace.profile.interests.map(e).join(', ')}</p><p>Host: ${e(workspace.host)} · Selection: ${e(workspace.selectedId ?? 'Awaiting your choice')}</p>${workspace.candidates.map((idea) => `<article><h2>${e(idea.title)}</h2><p>${e(idea.recommendation)}</p><ul>${idea.gates.map((gate) => `<li>${e(gate)}</li>`).join('')}</ul></article>`).join('')}<p>Run <code>verifold --desk</code> in this project directory to open the old desk and choose a direction there. This view sends no data and starts no experiments.</p></html>`;
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
