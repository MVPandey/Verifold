import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { connectWhenListening, type UnixWebSocket } from './unix-websocket.ts';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import {
  childEnvironment,
  codexOffOptions,
  type HarnessName,
} from './harness.ts';
import { codexEffort, listCodexModels, pickCodexModel } from './models.ts';
import {
  claudeUpdates,
  codexAppUpdates,
  codexCommand,
  type TranscriptUpdate,
} from './transcript.ts';
import type { LimitSignal } from './quota.ts';

/**
 * `strict`: a task session. The harness itself limits writes to the task folder and asks nothing.
 * `coordinator`: the coordinator. Claude Code gets no built-in tools; Codex gets a read-only sandbox.
 * Its actions go only through Verifold's tools.
 */
export type SessionMode = 'ask' | 'auto' | 'strict' | 'coordinator';

/** A domain that a task's shell commands may reach: a host name, or `*.` and a domain. */
export function validDomain(value: string): boolean {
  return /^(\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
    value,
  );
}

/**
 * Credential files and folders that a strict worker cannot read: SSH keys,
 * Verifold's credentials, the RunPod, GitHub, and AWS logins, Git and netrc
 * passwords, the logins of both harnesses, and the macOS login keychain. A
 * sandboxed command with network access can otherwise read keychain items
 * through the `security` tool. Probed on Codex 0.160.0. The person's Verifold
 * profile is closed too: agents get what they need of it in their prompts.
 */
export const credentialPaths = [
  '~/.ssh',
  '~/.verifold/credentials',
  '~/.verifold/agency',
  '~/.runpod',
  '~/.aws/credentials',
  '~/.config/gh',
  '~/.git-credentials',
  '~/.netrc',
  '~/.claude/.credentials.json',
  '~/.codex/auth.json',
  '~/Library/Keychains',
] as const;

/**
 * Claude Code settings for a strict task session: shell commands run in the
 * sandbox, file tools may edit only the working folder, and dontAsk mode
 * denies the rest. The sandbox blocks the network for shell commands, except
 * the task's domains. Neither shell commands nor file tools can read the
 * credential paths. When the sandbox cannot start, Claude Code stops instead
 * of running commands without it. Probed on Claude Code 2.1.288 and 2.1.289.
 * `denyRead` closes more paths the same way; absolute paths were probed on
 * Claude Code 2.1.304.
 */
export function strictClaudeSettings(
  domains: readonly string[] = [],
  denyRead: readonly string[] = [],
): string {
  return JSON.stringify(strictRules(domains, denyRead));
}

function strictRules(domains: readonly string[], denyRead: readonly string[]) {
  const denied = [...credentialPaths, ...denyRead];
  return {
    // Edit(./**) and Write(./**) resolve against Claude Code's current folder. See strictClaudeEnvironment.
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: denied },
      ...(domains.length ? { network: { allowedDomains: domains } } : {}),
    },
    permissions: {
      allow: ['Edit(./**)', 'Write(./**)', 'WebSearch', 'WebFetch'],
      // The sandbox limits shell commands only. These rules limit the Read
      // tool. A rule path that starts with `//` is absolute.
      deny: denied.flatMap((path) => {
        const rule = path.startsWith('/') ? `/${path}` : path;
        return [`Read(${rule})`, `Read(${rule}/**)`];
      }),
    },
  };
}

/**
 * The `--settings` of a session: the strict rules in strict mode, and the
 * person's own skills in `skillsOff` turned off. `skillsOff` holds the names
 * that invoke each one. Each name gets a deny rule, so the skill cannot run.
 * A name without `:`, of the person's skill folder, also gets
 * `skillOverrides`, so the skill leaves the list. `skillOverrides` does not
 * reach plugin and claude.ai skills, so they stay listed. Null: the session
 * needs none. Probed on Claude Code 2.1.310.
 */
export function claudeSessionSettings(options: {
  readonly mode?: HostOptions['mode'];
  readonly network?: readonly string[] | undefined;
  readonly denyRead?: readonly string[] | undefined;
  readonly skillsOff?: readonly string[] | undefined;
}): string | null {
  const off = options.skillsOff ?? [];
  const strict =
    options.mode === 'strict'
      ? strictRules(options.network ?? [], options.denyRead ?? [])
      : null;
  if (!strict && !off.length) return null;
  const personal = off.filter((name) => !name.includes(':'));
  return JSON.stringify({
    ...strict,
    permissions: {
      ...strict?.permissions,
      deny: [
        ...(strict?.permissions.deny ?? []),
        ...off.flatMap((name) => [`Skill(${name})`, `Skill(${name} *)`]),
      ],
    },
    ...(personal.length
      ? {
          skillOverrides: Object.fromEntries(
            personal.map((name) => [name, 'off']),
          ),
        }
      : {}),
  });
}

/**
 * The `-c` option that turns off the person's own skills for a Codex
 * app-server, by their SKILL.md paths in `off`, so a bundled or project skill
 * with the same name stays on. Codex adds these rules to the person's own,
 * so a skill that they turned off stays off. Probed on Codex 0.160.0.
 */
export function codexSkillsOff(off: readonly string[]): string[] {
  // JSON's string form is also TOML's: the paths hold no control characters.
  return off.length
    ? [
        '-c',
        `skills.config=[${off.map((path) => `{path=${JSON.stringify(path)},enabled=false}`).join(',')}]`,
      ]
    : [];
}

/**
 * The Codex permission profile of a session that nobody supervises. A strict
 * task session extends the built-in workspace profile (writes only in the
 * working folder and temporary folders), and the coordinator extends the
 * read-only profile. Neither can read the credential paths. A task with domains
 * gets the network, because Codex cannot limit it to domains. Probed on Codex
 * 0.160.0. `denyRead` closes more paths, absolute or under `~/`: both kinds
 * were probed with `codex sandbox` on Codex 0.160.0.
 */
function codexProfile(
  mode: 'strict' | 'coordinator',
  network: boolean,
  denyRead: readonly string[] = [],
): Record<string, unknown> {
  return {
    extends: mode === 'strict' ? ':workspace' : ':read-only',
    filesystem: Object.fromEntries(
      [...credentialPaths, ...denyRead].map((path) => [path, 'deny']),
    ),
    ...(network ? { network: { enabled: true } } : {}),
  };
}

/** The strict profile as `-c` options, for a Codex terminal on a strict task session. `denyRead` closes more paths, as for the session's thread. */
export function strictCodexOptions(
  network: boolean,
  denyRead: readonly string[] = [],
): string[] {
  const deny = [...credentialPaths, ...denyRead]
    .map((path) => `${JSON.stringify(path)}="deny"`)
    .join(',');
  return [
    '-c',
    'permissions.verifold-strict.extends=":workspace"',
    '-c',
    `permissions.verifold-strict.filesystem={${deny}}`,
    ...(network
      ? ['-c', 'permissions.verifold-strict.network.enabled=true']
      : []),
    '-c',
    'default_permissions="verifold-strict"',
  ];
}

/**
 * The environment of a strict Claude Code session. Claude Code keeps the
 * folder of a Bash `cd` for later tool calls, and the allow rules above then
 * resolve against it, so a worker that ran `cd sub` was denied every write
 * elsewhere in its task folder. This setting returns the shell to the task
 * folder after each command. Probed on Claude Code 2.1.288.
 */
export const strictClaudeEnvironment = {
  CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
} as const;

/**
 * What the harness enforces in a strict session: a task's, or a lab agent's
 * in the `folder` of its direction. Only credential reads are limited.
 */
export function restrictions(
  host: HarnessName,
  net: { readonly domains: readonly string[] } | null | undefined,
  folder = 'task folder',
): string[] {
  const domains = net?.domains.join(', ');
  const credentials =
    "cannot read credential files: SSH keys, Verifold's credentials, the RunPod, GitHub, and AWS logins, Git and netrc passwords, the logins of both harnesses, and the macOS login keychain. Other reads are not limited.";
  return host === 'claude'
    ? [
        `Shell commands can write only in the ${folder} and in temporary folders (Claude Code sandbox).`,
        domains
          ? `Shell commands can reach only these domains: ${domains} (Claude Code sandbox).`
          : 'Shell commands cannot reach the network (Claude Code sandbox).',
        `File tools can edit only in the ${folder}. Claude Code denies other edits without a prompt (permission rules, dontAsk mode).`,
        'Other tools that need permission are denied, except web search and web fetch.',
        `Shell commands and file tools ${credentials}`,
      ]
    : [
        `Shell commands and file changes can write only in the ${folder} and in temporary folders (Codex permission profile).`,
        domains
          ? `Shell commands can reach the network. Codex cannot limit it to the task's domains (${domains}).`
          : 'Shell commands cannot reach the network (Codex permission profile).',
        'Codex asks for no approvals. An action outside the sandbox fails (approval policy never).',
        'Codex does not report a command that its sandbox blocks, so the transcript can miss a blocked attempt.',
        `Shell commands ${credentials}`,
      ];
}

/** Observed protocol events. Agent text is a model claim; the other events come from the protocol. */
export type HostEvent =
  | {
      readonly type: 'session';
      readonly id: string;
      readonly model?: string;
      /** Codex: the model that Verifold picked from the app-server's list for a session without a model. */
      readonly picked?: string;
      readonly mode?: string;
    }
  | { readonly type: 'mode'; readonly mode: string }
  | { readonly type: 'message'; readonly text: string }
  | {
      readonly type: 'tool';
      readonly id: string;
      readonly tool: string;
      readonly action: string;
    }
  | {
      readonly type: 'tool-end';
      readonly id: string;
      readonly outcome: 'ok' | 'failed' | 'declined';
      readonly exitCode?: number;
    }
  | {
      readonly type: 'request';
      readonly id: string;
      readonly toolId?: string;
      readonly tool: string;
      readonly action: string;
      /** The content that a write or edit would change. */
      readonly detail?: string;
      readonly reason?: string;
    }
  /** The harness withdrew an open request, for example when its turn stopped. */
  | { readonly type: 'request-end'; readonly id: string }
  | {
      readonly type: 'denied';
      readonly toolId: string;
      readonly reason: string;
    }
  | {
      readonly type: 'review';
      readonly toolId: string;
      readonly approved: boolean;
      readonly action?: string;
      readonly risk?: string;
      readonly rationale?: string;
    }
  /**
   * Codex started a turn, also one that a terminal on the same app-server
   * started. Codex named it, so a cancel can stop it.
   */
  | { readonly type: 'turn-start' }
  | {
      readonly type: 'turn-end';
      readonly status: 'completed' | 'interrupted' | 'failed';
      readonly costUsd?: number;
    }
  | { readonly type: 'notice'; readonly text: string }
  /** The harness could not load the added skills, and why. Later sessions of it go without them. */
  | { readonly type: 'skills'; readonly text: string }
  /** The session continues in a new process, such as a second run without the added skills. */
  | { readonly type: 'process'; readonly pid: number }
  /** The harness reported its plan's usage window: open, or used up until a reset. */
  | ({ readonly type: 'limit' } & LimitSignal)
  /** The harness took a message that `steer` added to the running turn, or refused it. */
  | { readonly type: 'steered'; readonly id: string; readonly taken: boolean }
  /** One transcript update: full messages, tool inputs, and tool results. Private session data. */
  | { readonly type: 'transcript'; readonly update: TranscriptUpdate }
  | { readonly type: 'exit'; readonly code: number | null };

/** One of Verifold's own tools for an agent. */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * Verifold's tools for one agent, over the pipe that Verifold owns: an SDK MCP
 * server for Claude Code, dynamic tools for Codex. The pipe identifies the
 * agent, so `call` never trusts a name in the input. `callId` is the harness's
 * ID of the call, so a repeated call can be recognized.
 */
export interface AgentTools {
  readonly specs: readonly AgentTool[];
  readonly call: (
    name: string,
    input: unknown,
    callId: string,
  ) => Promise<{ readonly ok: boolean; readonly text: string }>;
}

export interface HostOptions {
  readonly host: HarnessName;
  readonly cwd: string;
  readonly mode: SessionMode;
  readonly model?: string;
  /**
   * Codex only, without `model`: before the thread starts, Verifold picks the
   * first of its preferred models that the app-server's `model/list` offers,
   * else none, so the thread runs the person's own Codex model.
   */
  readonly bestModel?: boolean;
  /**
   * Codex only: the app-server searches the live web, not only the index that
   * OpenAI keeps. Lab agents and checkers get it, for current facts. Task
   * workers and the coordinator keep Codex's default.
   */
  readonly liveSearch?: boolean;
  /** The first request. A resumed session has none and waits for a follow-up. */
  readonly prompt?: string;
  /** Claude Code only: the session ID for a new conversation, chosen before launch. */
  readonly sessionId?: string;
  /** The native session or thread to continue in this new process. */
  readonly resume?: string;
  /** Override the executable for an isolated host installation or a test fixture. */
  readonly executable?: string;
  readonly clientVersion: string;
  readonly tools?: AgentTools;
  /** A strict task: the domains that its shell commands may reach. Codex cannot limit domains, so any domain opens its network. */
  readonly network?: readonly string[];
  /**
   * A strict session: more paths that it cannot read, absolute or under `~/`,
   * besides the credential paths. A lab's checker gets the lab's records.
   */
  readonly denyRead?: readonly string[];
  /**
   * Lab agents and checkers: the folder of Verifold's read-only plugin with
   * the skills that the person added. Claude Code loads it with
   * `--plugin-dir`, and Codex its `skills/` folder as an extra skill root.
   */
  readonly skills?: string;
  /** The person's own skills that this session does not load: names for Claude Code, SKILL.md paths for Codex. */
  readonly skillsOff?: readonly string[];
  readonly onEvent: (event: HostEvent) => void;
}

/** One live harness process. Every method is safe to call after the process exits. */
export interface HostSession {
  /** The harness process. It leads its own process group on POSIX. */
  readonly pid: number | undefined;
  /** Codex only: the app-server socket that a terminal can attach to. */
  readonly socket?: string;
  /**
   * Codex only: `-c` overrides that keep the user's MCP servers, plugins, and
   * apps off in a terminal. Null: a server name cannot be written as a `-c`
   * key, so no terminal can keep them off.
   */
  readonly overrides?: readonly string[] | null;
  /** Start a new turn. The caller sends a follow-up only after the previous turn ends. */
  send(text: string): void;
  /**
   * Add a message to the running turn. A `steered` event with this ID reports
   * the outcome. False when the harness cannot take a message now.
   */
  steer(text: string, id: string): boolean;
  /** Deny the listed open requests and stop the current turn. */
  interrupt(pending: readonly string[]): void;
  answer(id: string, allow: boolean): void;
  close(): void;
}

const maxLine = 8 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** A time in epoch seconds, epoch milliseconds, or ISO text, as ISO text. */
function isoTime(value: unknown): string | null {
  const time =
    typeof value === 'number'
      ? value < 1e12
        ? value * 1000
        : value
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(time) && time > 0
    ? new Date(time).toISOString()
    : null;
}

/**
 * Claude Code's `rate_limit_info` from a `rate_limit_event`. `status` is
 * "allowed", "allowed_warning", or "rejected". `resetsAt` is in epoch
 * seconds, and `unifiedWindows` gives each window's `utilization` from 0 to 1.
 * Probed on Claude Code 2.1.303.
 */
export function claudeLimit(info: unknown): LimitSignal | null {
  if (!record(info)) return null;
  const status = str(info.status);
  if (!status) return null;
  const window = str(info.rateLimitType) ?? null;
  const windows = record(info.unifiedWindows) ? info.unifiedWindows : {};
  const current = window ? windows[window] : undefined;
  const utilization = record(current) ? current.utilization : undefined;
  return {
    exhausted: status === 'rejected',
    resetsAt: isoTime(info.resetsAt),
    usedPercent:
      typeof utilization === 'number' && Number.isFinite(utilization)
        ? Math.round(utilization * 100)
        : null,
    window,
  };
}

/**
 * A Claude Code result that failed on the usage limit. Its text can end with
 * the reset time as `|<epoch seconds>`.
 */
export function claudeLimitResult(
  event: Record<string, unknown>,
): LimitSignal | null {
  if (event.is_error !== true) return null;
  const text = str(event.result) ?? '';
  if (!/usage limit|limit reached|hit your limit/i.test(text)) return null;
  const stamp = /\|(\d{9,13})\b/.exec(text)?.[1];
  return {
    exhausted: true,
    resetsAt: stamp ? isoTime(Number(stamp)) : null,
    usedPercent: null,
    window: null,
  };
}

/**
 * Codex's `rateLimits` from `account/rateLimits/updated`: `primary` and
 * `secondary` windows with `usedPercent` and `resetsAt` (epoch seconds), and
 * `rateLimitReachedType` once a limit is hit. An account with credits keeps
 * working past a full window, so only a failed turn parks it. Probed on
 * Codex 0.160.0.
 */
export function codexLimit(value: unknown): LimitSignal | null {
  if (!record(value)) return null;
  const windows = [value.primary, value.secondary].filter(record);
  const used = (window: Record<string, unknown>): number =>
    typeof window.usedPercent === 'number' ? window.usedPercent : -1;
  const top = windows.reduce<Record<string, unknown> | undefined>(
    (best, window) => (!best || used(window) > used(best) ? window : best),
    undefined,
  );
  if (!top) return null;
  const credits =
    record(value.credits) &&
    (value.credits.hasCredits === true || value.credits.unlimited === true);
  const percent = used(top) >= 0 ? used(top) : null;
  return {
    exhausted:
      !credits &&
      (Boolean(str(value.rateLimitReachedType)) ||
        (percent !== null && percent >= 100)),
    resetsAt: isoTime(top.resetsAt),
    usedPercent: percent,
    window:
      typeof top.windowDurationMins === 'number'
        ? `${top.windowDurationMins} min`
        : null,
  };
}

/** A Codex error that ends work until the usage window resets. A retried error does not count. */
function codexUsageError(error: unknown, willRetry: unknown): boolean {
  return (
    willRetry !== true &&
    record(error) &&
    /usage.?limit|rate.?limit/i.test(
      `${JSON.stringify(error.codexErrorInfo ?? '')} ${str(error.message) ?? ''}`,
    )
  );
}

/** A used-up window whose reset time the harness did not give. */
const usedUp: LimitSignal = {
  exhausted: true,
  resetsAt: null,
  usedPercent: null,
  window: null,
};

/**
 * Codex thread settings that load none of the user's MCP servers, plugins, or
 * connected apps, from the `config/read` result. An empty `mcp_servers` table
 * does not replace the user's servers, so each one is turned off by name.
 * Probed on Codex 0.160.0. Without a readable configuration, undefined.
 */
function codexIsolation(result: unknown): Record<string, unknown> | undefined {
  if (!record(result) || !record(result.config)) return undefined;
  const servers = result.config.mcp_servers ?? {};
  if (!record(servers)) return undefined;
  return {
    features: { plugins: false, apps: false },
    mcp_servers: Object.fromEntries(
      Object.keys(servers).map((name) => [name, { enabled: false }]),
    ),
  };
}

/** Split newline-delimited output. A line above 8 MiB is dropped, not buffered. */
function readLines(
  stream: NodeJS.ReadableStream,
  onLine: (value: unknown) => void,
  onNotice: (text: string) => void,
): void {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let dropping = false;
  stream.on('data', (chunk: Buffer) => {
    const lines = (pending + decoder.write(chunk)).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (dropping) {
        dropping = false;
        continue;
      }
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        onNotice('Verifold could not read one line of harness output.');
        continue;
      }
      onLine(value);
    }
    if (pending.length > maxLine) {
      pending = '';
      dropping = true;
      onNotice('Verifold dropped one harness message above 8 MiB.');
    }
  });
}

/** A harness process. It leads its own process group on POSIX. */
function spawnHarness(
  command: string,
  args: readonly string[],
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  const child = spawn(command, args, {
    ...(cwd === undefined ? {} : { cwd }),
    env: { ...childEnvironment(), ...environment },
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Harness diagnostics can contain private session data, so they are not retained.
  child.stderr.resume();
  child.stdin.on('error', () => {
    /* The exit event reports a harness that closed its input. */
  });
  return child;
}

function launch(
  command: string,
  args: readonly string[],
  options: HostOptions,
  /**
   * Called with the exit code when all output is read, before the `exit`
   * event. True: the session goes on in another process, so no `exit` event.
   */
  closing?: (code: number | null) => boolean,
): ChildProcessWithoutNullStreams {
  return reportEnd(
    spawnHarness(
      command,
      args,
      options.cwd,
      options.host === 'claude' && options.mode === 'strict'
        ? strictClaudeEnvironment
        : {},
    ),
    options,
    closing,
  );
}

/** Tell the session when its harness cannot start, and when it ends. */
function reportEnd(
  child: ChildProcessWithoutNullStreams,
  options: HostOptions,
  closing?: (code: number | null) => boolean,
): ChildProcessWithoutNullStreams {
  child.on('error', () =>
    options.onEvent({
      type: 'notice',
      text: `Could not start ${options.host === 'claude' ? 'Claude Code' : 'Codex'}. Check that it is installed and signed in.`,
    }),
  );
  child.on('close', (code) => {
    if (closing?.(code)) return;
    options.onEvent({ type: 'exit', code });
  });
  return child;
}

/** Stop the whole process group, then force it after a grace period. */
function stop(child: ChildProcessWithoutNullStreams): void {
  // The group can outlive its leader, so the forced step does not check the leader's exit.
  const kill = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      /* The process group already exited. */
    }
  };
  kill('SIGTERM');
  setTimeout(() => kill('SIGKILL'), 2000).unref();
}

function write(child: ChildProcessWithoutNullStreams, value: unknown): void {
  if (child.stdin.writable) child.stdin.write(`${JSON.stringify(value)}\n`);
}

const claudeFields: Record<string, string> = {
  Bash: 'command',
  WebFetch: 'url',
  WebSearch: 'query',
  Read: 'file_path',
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
  Glob: 'pattern',
  Grep: 'pattern',
};

/**
 * The input field that tells a person what a Claude Code tool call acts on.
 * A description written by the model is never used, because it can differ from the input.
 */
function claudeAction(tool: string, input: unknown): string {
  if (!record(input)) return '';
  const field = Object.hasOwn(claudeFields, tool)
    ? claudeFields[tool]
    : undefined;
  const value = field ? input[field] : undefined;
  return typeof value === 'string' ? value : JSON.stringify(input);
}

/** The content that a Claude Code write or edit would change. */
function claudeDetail(tool: string, input: unknown): string | undefined {
  if (!record(input)) return undefined;
  if (tool === 'Write') return str(input.content);
  if (tool === 'Edit')
    return `- ${str(input.old_string) ?? ''}\n+ ${str(input.new_string) ?? ''}`;
  if (tool === 'MultiEdit' || tool === 'NotebookEdit')
    return JSON.stringify(input, null, 2);
  return undefined;
}

/** Claude Code's start event lists the plugins that it loaded and the ones that failed. */
function pluginProblem(
  event: Record<string, unknown>,
  folder: string,
): string | null {
  const ours = (entry: unknown): boolean => {
    const text = String(JSON.stringify(entry));
    return text.includes('verifold-skills') || text.includes(folder);
  };
  const failed = Array.isArray(event.plugin_errors) ? event.plugin_errors : [];
  // A start event without a plugin list says nothing either way.
  if (
    failed.some(ours) ||
    (Array.isArray(event.plugins) && !event.plugins.some(ours))
  )
    return 'Claude Code could not load the added skills, so its agents run without them.';
  return null;
}

/**
 * Claude Code through its stream-json control protocol. The CLI sends each
 * permission prompt to this process as a `can_use_tool` request.
 */
function claude(options: HostOptions): HostSession {
  const emit = options.onEvent;
  /** Claude Code reported its start. */
  let started = false;
  /** Verifold stops the process, so its exit says nothing about the added skills. */
  let closing = false;
  /** The plugin of the added skills for this run. A second run goes without it. */
  let plugin = options.skills;
  /** The run with the plugin failed before its start, and this run goes without it. */
  let probing = false;
  /** The start of the error output of a run with the plugin, kept in memory only, to tell a refusal by policy. */
  let errors = '';
  /** What Verifold wrote before Claude Code started, for a second run. */
  const early: unknown[] = [];
  const settings = claudeSessionSettings(options);
  const args = (): string[] => [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    // Claude Code echoes each message when it takes it in, so Verifold knows when a steered message arrived.
    '--replay-user-messages',
    '--permission-prompt-tool',
    'stdio',
    // Workers load no MCP server from the user's configuration, plugins, or claude.ai connectors.
    '--strict-mcp-config',
    '--permission-mode',
    options.mode === 'auto'
      ? 'auto'
      : options.mode === 'strict'
        ? 'dontAsk'
        : 'default',
    ...(settings ? ['--settings', settings] : []),
    ...(options.mode === 'coordinator' ? ['--tools', ''] : []),
    ...(options.model ? ['--model', options.model] : []),
    ...(plugin ? ['--plugin-dir', plugin] : []),
    ...(options.tools
      ? [
          '--mcp-config',
          JSON.stringify({
            mcpServers: { verifold: { type: 'sdk', name: 'verifold' } },
          }),
          // Verifold's own tools need no permission request.
          '--allowedTools',
          options.tools.specs
            .map((tool) => `mcp__verifold__${tool.name}`)
            .join(','),
        ]
      : []),
    ...(options.resume
      ? ['--resume', options.resume]
      : options.sessionId
        ? ['--session-id', options.sessionId]
        : []),
  ];
  const begin = (): ChildProcessWithoutNullStreams => {
    errors = '';
    const next = launch(options.executable ?? 'claude', args(), options, again);
    if (plugin)
      next.stderr.on('data', (chunk: Buffer) => {
        if (errors.length < 8192)
          errors += chunk.toString('utf8').slice(0, 8192 - errors.length);
      });
    readLines(next.stdout, onLine, (text) => emit({ type: 'notice', text }));
    return next;
  };
  /**
   * A run with the plugin that fails before its start runs once more without
   * it, in the same session. A managed setting that refuses the plugin flag
   * blocks the added skills at once. Any other failure blocks them only when
   * the run without the plugin starts. Verifold's own stop is no failure.
   */
  function again(code: number | null): boolean {
    if (!plugin || started || closing || code === null || code === 0)
      return false;
    if (/\bdisableSideloadFlags\b/.test(errors))
      emit({
        type: 'skills',
        text: "Your organization's Claude Code settings block added skills, so agents run without them.",
      });
    else probing = true;
    plugin = undefined;
    child = begin();
    if (child.pid !== undefined) emit({ type: 'process', pid: child.pid });
    for (const value of early) write(child, value);
    return true;
  }
  /** Write to Claude Code. What comes before its start is kept for a second run. */
  const send = (value: unknown): void => {
    if (!started) early.push(value);
    write(child, value);
  };
  const tools = options.tools;
  const inputs = new Map<string, unknown>();
  let interrupting = false;
  /** Messages that `steer` wrote and Claude Code has not echoed yet. */
  const steers = new Set<string>();
  const user = (text: string, uuid?: string): void =>
    send({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
      ...(uuid ? { uuid } : {}),
    });
  const stopTurn = (): void =>
    send({
      type: 'control_request',
      request_id: `verifold-${randomUUID()}`,
      request: { subtype: 'interrupt' },
    });
  const answer = (id: string, allow: boolean, interrupt = false): void => {
    if (!inputs.has(id)) return;
    const input = inputs.get(id);
    inputs.delete(id);
    send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: id,
        response: allow
          ? { behavior: 'allow', updatedInput: input }
          : {
              behavior: 'deny',
              message: 'The person denied this request in Verifold.',
              ...(interrupt ? { interrupt: true } : {}),
            },
      },
    });
  };

  function onLine(event: unknown): void {
    if (!record(event)) return;
    // An echo repeats a message that Verifold sent. It marks the moment Claude Code took it in.
    if (event.isReplay === true) {
      const id = str(event.uuid);
      if (!id || !steers.delete(id)) return;
      emit({ type: 'steered', id, taken: true });
      // A stop that came before this message also stops the turn that the message started.
      if (interrupting) stopTurn();
      return;
    }
    for (const update of claudeUpdates(event))
      emit({ type: 'transcript', update });
    if (event.type === 'rate_limit_event') {
      const signal = claudeLimit(event.rate_limit_info);
      if (signal) emit({ type: 'limit', ...signal });
    } else if (event.type === 'system') {
      if (event.subtype === 'init') {
        started = true;
        // The run without the plugin started, so the plugin stopped the first run.
        const problem = probing
          ? 'Claude Code did not start with the added skills, so its agents run without them.'
          : plugin
            ? pluginProblem(event, plugin)
            : null;
        if (problem) emit({ type: 'skills', text: problem });
        const id = str(event.session_id);
        const model = str(event.model);
        const mode = str(event.permissionMode);
        if (id)
          emit({
            type: 'session',
            id,
            ...(model ? { model } : {}),
            ...(mode ? { mode } : {}),
          });
      } else if (event.subtype === 'status' && str(event.permissionMode))
        emit({ type: 'mode', mode: String(event.permissionMode) });
      else if (event.subtype === 'permission_denied') {
        const toolId = str(event.tool_use_id);
        if (toolId)
          emit({
            type: 'denied',
            toolId,
            reason: str(event.decision_reason_type) ?? 'unknown',
          });
      }
    } else if (
      (event.type === 'assistant' || event.type === 'user') &&
      record(event.message) &&
      Array.isArray(event.message.content)
    ) {
      for (const block of event.message.content as unknown[]) {
        if (!record(block)) continue;
        if (event.type === 'assistant' && block.type === 'text') {
          const text = str(block.text);
          if (text) emit({ type: 'message', text });
        } else if (event.type === 'assistant' && block.type === 'tool_use') {
          const id = str(block.id);
          const tool = str(block.name) ?? 'Tool';
          if (id)
            emit({
              type: 'tool',
              id,
              tool,
              action: claudeAction(tool, block.input),
            });
        } else if (event.type === 'user' && block.type === 'tool_result') {
          const id = str(block.tool_use_id);
          if (id)
            emit({
              type: 'tool-end',
              id,
              outcome: block.is_error === true ? 'failed' : 'ok',
            });
        }
      }
    } else if (event.type === 'control_request' && record(event.request)) {
      const id = str(event.request_id);
      if (!id) return;
      if (event.request.subtype === 'can_use_tool') {
        const tool = str(event.request.tool_name) ?? 'Tool';
        const toolId = str(event.request.tool_use_id);
        const reason = str(event.request.description);
        const detail = claudeDetail(tool, event.request.input);
        inputs.set(id, event.request.input);
        emit({
          type: 'request',
          id,
          tool,
          action: claudeAction(tool, event.request.input),
          ...(toolId ? { toolId } : {}),
          ...(detail ? { detail } : {}),
          ...(reason ? { reason } : {}),
        });
      } else if (
        event.request.subtype === 'mcp_message' &&
        event.request.server_name === 'verifold' &&
        tools
      )
        mcp(id, event.request.message);
      else
        send({
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: id,
            error: 'Verifold does not support this request.',
          },
        });
    } else if (event.type === 'control_cancel_request') {
      const id = str(event.request_id);
      if (id && inputs.delete(id)) emit({ type: 'request-end', id });
    } else if (event.type === 'result') {
      // A steered message that came after the last tool call starts one more turn by itself. Probed on Claude Code 2.1.296.
      if (steers.size) return;
      const limit = claudeLimitResult(event);
      if (limit) emit({ type: 'limit', ...limit });
      const cost = event.total_cost_usd;
      emit({
        type: 'turn-end',
        status: interrupting
          ? 'interrupted'
          : event.is_error === true || event.subtype !== 'success'
            ? 'failed'
            : 'completed',
        ...(typeof cost === 'number' && Number.isFinite(cost)
          ? { costUsd: cost }
          : {}),
      });
      interrupting = false;
    }
  }
  let child = begin();
  /** Answer one message to Verifold's SDK MCP server. */
  const mcp = (id: string, message: unknown): void => {
    const reply = (response: Record<string, unknown>): void =>
      send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: id,
          response: { mcp_response: { jsonrpc: '2.0', ...response } },
        },
      });
    if (!record(message) || !tools) return;
    const rpc = message.id;
    const params = record(message.params) ? message.params : {};
    if (typeof rpc !== 'number' && typeof rpc !== 'string')
      reply({ id: 0, result: {} });
    else if (message.method === 'initialize')
      reply({
        id: rpc,
        result: {
          protocolVersion: str(params.protocolVersion) ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'verifold', version: options.clientVersion },
        },
      });
    else if (message.method === 'tools/list')
      reply({ id: rpc, result: { tools: tools.specs } });
    else if (message.method === 'tools/call') {
      const meta = record(params._meta) ? params._meta : {};
      void tools
        .call(
          str(params.name) ?? '',
          params.arguments,
          str(meta['claudecode/toolUseId']) ?? `mcp-${rpc}`,
        )
        .catch(() => ({ ok: false, text: 'Verifold could not run this tool.' }))
        .then((result) =>
          reply({
            id: rpc,
            result: {
              content: [{ type: 'text', text: result.text }],
              isError: !result.ok,
            },
          }),
        );
    } else
      reply({
        id: rpc,
        error: { code: -32601, message: 'Verifold does not support this.' },
      });
  };

  send({
    type: 'control_request',
    request_id: `verifold-${randomUUID()}`,
    request: {
      subtype: 'initialize',
      ...(tools ? { sdkMcpServers: ['verifold'] } : {}),
    },
  });
  if (options.prompt) user(options.prompt);
  else if (options.resume) {
    const id = options.resume;
    // Claude Code reports its session only after the next message, so the resumed ID is the one Verifold asked for.
    // The event waits until the caller holds this session.
    queueMicrotask(() => emit({ type: 'session', id }));
  }
  return {
    get pid() {
      return child.pid;
    },
    send: user,
    steer(text, id) {
      steers.add(id);
      user(text, id);
      return true;
    },
    interrupt(pending) {
      interrupting = true;
      if (pending.length) for (const id of pending) answer(id, false, true);
      else stopTurn();
    },
    answer: (id, allow) => answer(id, allow),
    close() {
      closing = true;
      child.stdin.end();
      stop(child);
    },
  };
}

/**
 * Runs the Codex app-server and stops it when its stdin closes. With a socket,
 * the app-server itself ignores stdin, so it would outlive a Verifold that
 * crashed. The watchdog and Codex share one process group, so a later owner
 * can stop both. A missing Codex exits with code 127. When the watchdog
 * exits, it removes the socket's folder, its first argument, so the folder
 * goes even when Verifold was killed first.
 */
const watchdog = `const { spawn } = require('node:child_process');
const [folder, command, ...args] = process.argv.slice(1);
process.on('exit', () => { try { require('node:fs').rmSync(folder, { recursive: true, force: true }); } catch {} });
const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] });
const stop = () => { try { child.kill('SIGTERM'); } catch {} setTimeout(() => process.exit(0), 2000).unref(); };
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
process.on('SIGTERM', stop);
child.on('error', () => process.exit(127));
child.on('exit', (code) => process.exit(code ?? 1));`;

/** Codex's app-server under the watchdog, on a socket in a private folder. */
interface CodexServer {
  /** The watchdog. It leads one process group with Codex on POSIX. */
  readonly child: ChildProcessWithoutNullStreams;
  /** The app-server socket, which a terminal can also attach to. */
  readonly socket: string;
  readonly exited: () => boolean;
  /** Connect once the server listens. It fails at `deadline` (a `Date.now()` time), or when the server exits first. */
  connect(
    deadline: number,
    onMessage: (text: string) => void,
    onClose: () => void,
  ): Promise<UnixWebSocket>;
  /** Stop the server's process group, as a session stops it. The folder goes when the server closes. */
  stop(): void;
}

/**
 * Start Codex's app-server under the watchdog, for a session or for
 * detection. It listens on a socket in a new private folder. The watchdog
 * removes the folder when it exits, and Verifold removes it when the server
 * closes, for a watchdog that was killed. `config` holds top-level `-c`
 * options, which reach the app-server.
 */
export function startCodexServer(options: {
  readonly executable: string;
  readonly config: readonly string[];
  /**
   * A session: the server runs in its folder, and the session hears when the
   * server cannot start and when it ends, before the folder is removed.
   * Without one, the server runs in Verifold's own folder.
   */
  readonly session?: HostOptions;
}): CodexServer {
  // Unix socket paths are short (about 104 bytes on macOS), so the folder is under the temporary folder.
  const folder = mkdtempSync(join(tmpdir(), 'vf-'));
  const socket = join(folder, 'codex.sock');
  const child = spawnHarness(
    process.execPath,
    [
      '-e',
      watchdog,
      folder,
      options.executable,
      ...options.config,
      'app-server',
      '--listen',
      `unix://${socket}`,
    ],
    options.session?.cwd,
  );
  child.on('error', () => {
    /* The exit, the close and the connection report the outcome. */
  });
  if (options.session) reportEnd(child, options.session);
  child.stdout.resume();
  child.on('close', () => {
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch {
      /* A folder that cannot be removed stays in the temporary folder. */
    }
  });
  const exited = (): boolean =>
    child.exitCode !== null || child.signalCode !== null;
  return {
    child,
    socket,
    exited,
    connect: (deadline, onMessage, onClose) =>
      connectWhenListening(
        socket,
        { alive: () => !exited(), deadline },
        onMessage,
        onClose,
      ),
    stop: () => stop(child),
  };
}

/** The parameters of Codex's `initialize` request. */
export function codexInitialize(version: string): Record<string, unknown> {
  return {
    clientInfo: { name: 'verifold', title: 'Verifold', version },
    capabilities: { experimentalApi: true },
  };
}

/**
 * Codex through `codex app-server` (JSON-RPC over stdio). Ask me routes
 * approvals to this client. Auto routes them to the Codex reviewer agent.
 */
function codex(options: HostOptions): HostSession {
  // The app-server listens on a socket, so a terminal can attach later.
  const server = startCodexServer({
    executable: options.executable ?? 'codex',
    config: [
      // Search does not use the sandbox's network.
      ...(options.liveSearch ? ['-c', 'web_search="live"'] : []),
      // A skill's MCP dependencies would go into the person's own Codex settings.
      // The same as `--disable`, which an older app-server may refuse.
      ...(options.skills
        ? ['-c', 'features.skill_mcp_dependency_install=false']
        : []),
      ...codexSkillsOff(options.skillsOff ?? []),
    ],
    session: options,
  });
  const { child, socket, exited } = server;
  const emit = options.onEvent;
  // `exit` comes before `close`, which reports the end of the session, so the reason comes first.
  child.on('exit', () => {
    if (!connection && !unreachable)
      emit({
        type: 'notice',
        text: 'Could not start Codex. Check that it is installed and signed in.',
      });
  });
  /** Messages wait here until the socket connects. */
  let queue: string[] | null = [];
  let connection: UnixWebSocket | null = null;
  /** The person heard that Codex could not be reached, so the exit that follows adds no line. */
  let unreachable = false;
  const send = (value: unknown): void => {
    const text = JSON.stringify(value);
    if (connection) connection.send(text);
    else queue?.push(text);
  };
  const results = new Map<
    number,
    {
      readonly method: string;
      readonly onResult?: (result: Record<string, unknown>) => void;
      readonly onError?: (error: Record<string, unknown>) => void;
    }
  >();
  const requests = new Map<string, number | string>();
  const changes = new Map<string, { paths: string; diff: string }>();
  let nextId = 1;
  let overrides: string[] | null = [];
  let thread: string | undefined;
  let turn: string | undefined;
  let cancelled = false;
  const call = (
    method: string,
    params: Record<string, unknown>,
    onResult?: (result: Record<string, unknown>) => void,
    onError?: (error: Record<string, unknown>) => void,
  ): void => {
    const id = nextId++;
    results.set(id, {
      method,
      ...(onResult ? { onResult } : {}),
      ...(onError ? { onError } : {}),
    });
    send({ method, id, params });
  };
  const interruptTurn = (): void => {
    if (thread && turn)
      call('turn/interrupt', { threadId: thread, turnId: turn });
  };
  const startTurn = (text: string): void => {
    if (!thread) return;
    call(
      'turn/start',
      { threadId: thread, input: [{ type: 'text', text }] },
      (result) => {
        if (record(result.turn)) turn = str(result.turn.id);
        // A cancel can arrive before Codex reports the turn ID.
        if (cancelled) interruptTurn();
      },
    );
  };
  const answer = (id: string, allow: boolean): void => {
    const rpcId = requests.get(id);
    if (rpcId === undefined) return;
    requests.delete(id);
    send({
      id: rpcId,
      result: { decision: allow ? 'accept' : 'decline' },
    });
  };
  /** Subagent threads and the tool call that started each one. */
  const agents = new Map<string, string>();
  /** Item IDs of a subagent thread get its thread ID, so they cannot match IDs of the main thread. */
  const transcribe = (
    method: string,
    value: unknown,
    from: string | null,
  ): void => {
    const local = (id: string): string => (from ? `${from}/${id}` : id);
    if (
      record(value) &&
      value.type === 'collabAgentToolCall' &&
      typeof value.id === 'string' &&
      Array.isArray(value.receiverThreadIds)
    )
      for (const child of value.receiverThreadIds as unknown[])
        if (typeof child === 'string' && agents.size < 500)
          agents.set(child, local(value.id));
    const parent = from ? (agents.get(from) ?? null) : null;
    for (const update of codexAppUpdates(method, value, parent))
      emit({
        type: 'transcript',
        update:
          update.id === undefined
            ? update
            : { ...update, id: local(update.id) },
      });
  };
  const item = (method: string, value: unknown): void => {
    if (!record(value)) return;
    const id = str(value.id);
    if (!id) return;
    const started = method === 'item/started';
    const status = str(value.status);
    const end = (): void => {
      if (started) return;
      const exit = value.exitCode;
      emit({
        type: 'tool-end',
        id,
        outcome:
          status === 'declined'
            ? 'declined'
            : status === 'failed' ||
                (typeof exit === 'number' && exit !== 0) ||
                value.error ||
                value.success === false
              ? 'failed'
              : 'ok',
        ...(typeof exit === 'number' ? { exitCode: exit } : {}),
      });
    };
    if (value.type === 'commandExecution') {
      if (started)
        emit({
          type: 'tool',
          id,
          tool: 'Command',
          action: codexCommand(value),
        });
      end();
    } else if (value.type === 'fileChange') {
      const list = (
        Array.isArray(value.changes) ? (value.changes as unknown[]) : []
      ).filter(record);
      const paths = list
        .map((change) => str(change.path))
        .filter(Boolean)
        .join(', ');
      if (started) {
        changes.set(id, {
          paths,
          diff: list.map((change) => str(change.diff) ?? '').join('\n'),
        });
        emit({ type: 'tool', id, tool: 'File change', action: paths });
      } else changes.delete(id);
      end();
    } else if (value.type === 'mcpToolCall') {
      if (started)
        emit({
          type: 'tool',
          id,
          tool: 'MCP tool',
          action: `${str(value.server) ?? 'server'}.${str(value.tool) ?? 'tool'}`,
        });
      end();
    } else if (value.type === 'dynamicToolCall') {
      // One of Verifold's own tools.
      if (started)
        emit({
          type: 'tool',
          id,
          tool: str(value.tool) ?? 'Verifold tool',
          action: JSON.stringify(value.arguments ?? {}),
        });
      end();
    } else if (value.type === 'webSearch' && !started) {
      emit({
        type: 'tool',
        id,
        tool: 'Web search',
        action: str(value.query) ?? '',
      });
      emit({ type: 'tool-end', id, outcome: 'ok' });
    } else if (value.type === 'agentMessage' && !started) {
      const text = str(value.text);
      if (text) emit({ type: 'message', text });
    }
  };

  const handle = (message: unknown): void => {
    if (!record(message)) return;
    const method = str(message.method);
    const params = record(message.params) ? message.params : {};
    const rpcId =
      typeof message.id === 'number' || typeof message.id === 'string'
        ? message.id
        : undefined;
    if (method && rpcId !== undefined) {
      const key = `c${rpcId}`;
      if (
        method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval'
      ) {
        const toolId = str(params.itemId);
        const reason = str(params.reason);
        const change = toolId ? changes.get(toolId) : undefined;
        requests.set(key, rpcId);
        emit({
          type: 'request',
          id: key,
          tool: method.includes('command') ? 'Command' : 'File change',
          action: method.includes('command')
            ? codexCommand(params)
            : (change?.paths ?? str(params.grantRoot) ?? 'File changes'),
          ...(toolId ? { toolId } : {}),
          ...(change?.diff ? { detail: change.diff } : {}),
          ...(reason ? { reason } : {}),
        });
      } else if (method === 'item/tool/call' && options.tools)
        void options.tools
          .call(
            str(params.tool) ?? '',
            params.arguments,
            str(params.callId) ?? key,
          )
          .catch(() => ({
            ok: false,
            text: 'Verifold could not run this tool.',
          }))
          .then((result) =>
            send({
              id: rpcId,
              result: {
                contentItems: [{ type: 'inputText', text: result.text }],
                success: result.ok,
              },
            }),
          );
      else {
        send({
          id: rpcId,
          error: {
            code: -32601,
            message: 'Verifold does not support this request.',
          },
        });
        emit({
          type: 'notice',
          text: `Codex sent a request that Verifold does not support (${method}). Verifold declined it.`,
        });
      }
      return;
    }
    if (typeof message.id === 'number') {
      const pending = results.get(message.id);
      results.delete(message.id);
      if (record(message.error)) {
        // A steer that comes after the turn ended is refused. The caller sends it another way.
        if (pending?.onError) return pending.onError(message.error);
        emit({
          type: 'notice',
          text: `Codex rejected ${pending?.method ?? 'a request'}: ${str(message.error.message) ?? 'unknown error'}.`,
        });
        // Without a thread, the session cannot continue. A rejected turn ends that turn.
        if (
          pending?.method === 'initialize' ||
          pending?.method === 'config/read' ||
          pending?.method === 'thread/start' ||
          pending?.method === 'thread/resume'
        )
          stop(child);
        else if (pending?.method === 'turn/start')
          emit({ type: 'turn-end', status: 'failed' });
      } else if (record(message.result)) pending?.onResult?.(message.result);
      return;
    }
    // Codex can report other threads, such as a reviewer, on the same connection.
    const from = str(params.threadId);
    if (thread && from && from !== thread) {
      // Only the transcript shows subagent work. Requests and records stay with the main thread.
      if (method && agents.has(from)) transcribe(method, params.item, from);
      return;
    }
    if (method === 'serverRequest/resolved') {
      const resolved = params.requestId;
      const key =
        typeof resolved === 'number' || typeof resolved === 'string'
          ? `c${resolved}`
          : '';
      if (requests.delete(key)) emit({ type: 'request-end', id: key });
    } else if (method === 'item/started' || method === 'item/completed') {
      transcribe(method, params.item, null);
      item(method, params.item);
    } else if (method === 'account/rateLimits/updated') {
      const signal = codexLimit(params.rateLimits);
      if (signal) emit({ type: 'limit', ...signal });
    } else if (method === 'turn/started') {
      // A turn without its ID could not be cancelled, so it does not count as one.
      const id = record(params.turn) ? str(params.turn.id) : undefined;
      if (id) {
        turn = id;
        emit({ type: 'turn-start' });
      }
    } else if (method === 'turn/completed') {
      turn = undefined;
      const value = record(params.turn) ? str(params.turn.status) : undefined;
      if (
        value === 'failed' &&
        record(params.turn) &&
        codexUsageError(params.turn.error, false)
      )
        emit({ type: 'limit', ...usedUp });
      emit({
        type: 'turn-end',
        status:
          value === 'interrupted'
            ? 'interrupted'
            : value === 'failed'
              ? 'failed'
              : 'completed',
      });
    } else if (method === 'item/autoApprovalReview/completed') {
      const toolId = str(params.targetItemId);
      const review = record(params.review) ? params.review : {};
      const action = record(params.action)
        ? str(params.action.command)
        : undefined;
      const risk = str(review.riskLevel);
      const rationale = str(review.rationale);
      if (toolId)
        emit({
          type: 'review',
          toolId,
          approved: review.status === 'approved',
          ...(action ? { action } : {}),
          ...(risk ? { risk } : {}),
          ...(rationale ? { rationale } : {}),
        });
    } else if (method === 'error') {
      emit({
        type: 'notice',
        text: `Codex reported an error: ${record(params.error) ? (str(params.error.message) ?? 'unknown') : 'unknown'}.`,
      });
      if (codexUsageError(params.error, params.willRetry))
        emit({ type: 'limit', ...usedUp });
    }
  };
  // Connect when the server listens. A server that never listens in 15 seconds counts as a failed start.
  void (async () => {
    try {
      connection = await server.connect(
        Date.now() + 15_000,
        (text) => {
          let message: unknown;
          try {
            message = JSON.parse(text);
          } catch {
            emit({
              type: 'notice',
              text: 'Verifold could not read one message from Codex.',
            });
            return;
          }
          handle(message);
        },
        () => stop(child),
      );
      for (const text of queue ?? []) connection.send(text);
      queue = null;
    } catch {
      // A Codex that exited reports its exit itself. It can stop just before
      // the last try, with its exit not handled yet, so the line waits for
      // that briefly: the person gets one line for one failure.
      if (!exited())
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(grace);
            child.off('exit', done);
            resolve();
          };
          const grace = setTimeout(done, 200);
          child.once('exit', done);
        });
      if (exited()) return;
      unreachable = true;
      emit({
        type: 'notice',
        text: 'Could not connect to Codex. Check that it is installed and signed in.',
      });
      stop(child);
    }
  })();

  call('initialize', codexInitialize(options.clientVersion), () => {
    send({ method: 'initialized', params: {} });
    call('config/read', { cwd: options.cwd }, (result) => {
      const config = codexIsolation(result);
      // The thread's configuration turns off any server. A terminal's `-c` options can name only some.
      if (config)
        overrides = codexOffOptions(
          Object.keys(config.mcp_servers as Record<string, unknown>),
        );
      if (!config) {
        emit({
          type: 'notice',
          text: 'Codex did not report its configuration, so Verifold cannot turn off its MCP servers. The session stopped.',
        });
        stop(child);
        return;
      }
      const begin = (): void => {
        if (options.bestModel && !options.model)
          chooseModel(
            config,
            record(result) && record(result.config)
              ? result.config.model_reasoning_effort
              : undefined,
          );
        else startThread(config, options.model);
      };
      if (options.skills) addSkills(options.skills, begin);
      else begin();
    });
  });

  /**
   * Add the skills folder of Verifold's plugin as a skill root of this
   * app-server, which only this session uses, and check that Codex lists
   * the skills. A Codex without the method, or one that cannot load them,
   * starts the thread without them.
   */
  function addSkills(folder: string, then: () => void): void {
    const root = join(folder, 'skills');
    // Codex can report a path in its canonical form, so the plugin's own folder name identifies it.
    const marker = `${basename(folder)}/skills/`;
    const without = (text: string): void => {
      emit({ type: 'skills', text });
      then();
    };
    const failed =
      'Codex could not load the added skills, so Codex agents run without them.';
    // The root goes again, so the session runs without any of them, as the line says.
    const clear = (): void =>
      call(
        'skills/extraRoots/set',
        { extraRoots: [] },
        () => without(failed),
        () => without(failed),
      );
    call(
      'skills/extraRoots/set',
      { extraRoots: [root] },
      () =>
        call(
          'skills/list',
          { cwds: [options.cwd], forceReload: true },
          (result) => {
            const entries = Array.isArray(result.data)
              ? result.data.filter(record)
              : [];
            const ours = (value: unknown): boolean =>
              record(value) &&
              typeof value.path === 'string' &&
              value.path.includes(marker);
            const listed = entries.some(
              (entry) => Array.isArray(entry.skills) && entry.skills.some(ours),
            );
            const broken = entries.some(
              (entry) => Array.isArray(entry.errors) && entry.errors.some(ours),
            );
            if (listed && !broken) return then();
            clear();
          },
          clear,
        ),
      (error) =>
        without(
          error.code === -32601 ||
            /method not found|unknown variant|unknown method/i.test(
              str(error.message) ?? '',
            )
            ? 'This version of Codex cannot load added skills, so Codex agents run without them. Update Codex to use them.'
            : failed,
        ),
    );
  }

  /**
   * Read every page of `model/list`, then start the thread with the first of
   * Verifold's preferred models that it offers. A refused list, or one
   * without them, starts it with the person's own model. When the person's
   * reasoning effort, `effort`, is one that the model does not support, the
   * thread gets the model's default effort.
   */
  function chooseModel(config: Record<string, unknown>, effort: unknown): void {
    listCodexModels(call, (models) => {
      const model = models ? pickCodexModel(models) : undefined;
      const fitted =
        model && models ? codexEffort(models, model, effort) : undefined;
      startThread(
        fitted ? { ...config, model_reasoning_effort: fitted } : config,
        model,
        true,
      );
    });
  }

  /**
   * Start or resume the thread with the configuration that turns off the
   * user's MCP servers. `picked`: Verifold picked `model` from Codex's list.
   */
  function startThread(
    config: Record<string, unknown>,
    model: string | undefined,
    picked = false,
  ): void {
    const unsupervised =
      options.mode === 'strict' || options.mode === 'coordinator'
        ? options.mode
        : null;
    call(
      options.resume ? 'thread/resume' : 'thread/start',
      {
        ...(options.resume ? { threadId: options.resume } : {}),
        cwd: options.cwd,
        // A strict task session and the coordinator get no approvals: an action outside the sandbox fails.
        approvalPolicy: unsupervised ? 'never' : 'on-request',
        // A session that nobody supervises selects its permission profile in the configuration below instead.
        ...(unsupervised ? {} : { sandbox: 'workspace-write' }),
        // Without this, a user's global reviewer setting can answer requests meant for the person.
        approvalsReviewer: options.mode === 'auto' ? 'auto_review' : 'user',
        ...(model ? { model } : {}),
        // Dynamic tools stay with the thread, and `thread/resume` does not take them. Probed on Codex 0.160.0.
        ...(options.tools && !options.resume
          ? {
              dynamicTools: options.tools.specs.map((tool) => ({
                type: 'function',
                ...tool,
              })),
            }
          : {}),
        // The `permissions` parameter made Codex 0.160.0 fail with "failed to load workspace requirements"; `default_permissions` works.
        config: unsupervised
          ? {
              ...config,
              permissions: {
                [`verifold-${unsupervised}`]: codexProfile(
                  unsupervised,
                  Boolean(options.network?.length),
                  options.denyRead,
                ),
              },
              default_permissions: `verifold-${unsupervised}`,
            }
          : config,
      },
      (result) => {
        thread = record(result.thread) ? str(result.thread.id) : undefined;
        if (!thread) {
          emit({ type: 'notice', text: 'Codex did not start a thread.' });
          stop(child);
          return;
        }
        // A resume's answer can leave the model out. The thread then runs the model that Verifold sent.
        const reported = str(result.model) ?? model;
        const reviewer = str(result.approvalsReviewer);
        emit({
          type: 'session',
          id: thread,
          ...(reported ? { model: reported } : {}),
          ...(picked && model ? { picked: model } : {}),
          ...(reviewer ? { mode: reviewer } : {}),
        });
        // A cancel can arrive before the thread exists. Then the first turn never starts.
        if (cancelled) emit({ type: 'turn-end', status: 'interrupted' });
        else if (options.prompt) startTurn(options.prompt);
      },
    );
  }
  return {
    pid: child.pid,
    send(text) {
      cancelled = false;
      startTurn(text);
    },
    steer(text, id) {
      if (!thread || !turn) return false;
      call(
        'turn/steer',
        {
          threadId: thread,
          expectedTurnId: turn,
          input: [{ type: 'text', text }],
        },
        () => emit({ type: 'steered', id, taken: true }),
        () => emit({ type: 'steered', id, taken: false }),
      );
      return true;
    },
    interrupt(pending) {
      for (const id of pending) answer(id, false);
      cancelled = true;
      interruptTurn();
    },
    answer,
    close() {
      connection?.close();
      stop(child);
    },
    socket,
    get overrides() {
      return overrides;
    },
  };
}

export function startHostSession(options: HostOptions): HostSession {
  return options.host === 'claude' ? claude(options) : codex(options);
}
