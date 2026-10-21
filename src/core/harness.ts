import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  claudeUpdates,
  codexExecUpdates,
  requestUpdate,
  type TranscriptUpdate,
} from './transcript.ts';

export type HarnessName = 'claude' | 'codex';

/**
 * The harness commands that the PATH holds. This does not check the sign-in:
 * a harness that is not signed in fails at its first run, with that reason.
 */
export async function installedHarnesses(
  path = process.env.PATH ?? '',
): Promise<HarnessName[]> {
  const folders = path.split(delimiter).filter(Boolean);
  const found: HarnessName[] = [];
  for (const name of ['claude', 'codex'] as const)
    for (const folder of folders)
      try {
        await access(join(folder, name), constants.X_OK);
        found.push(name);
        break;
      } catch {
        // Not in this folder.
      }
  return found;
}

export interface HarnessRequest {
  readonly host: HarnessName;
  readonly cwd: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
  /** The longest that the call can run, in milliseconds. The default is four hours. */
  readonly timeoutMs?: number;
  /** How long the harness can send nothing before Verifold stops it, in milliseconds. The default is 15 minutes. */
  readonly idleMs?: number;
  readonly sessionId?: string;
  /** Host model identifier or alias. Omit to use the host's default. */
  readonly model?: string;
  /**
   * Observed host activity only. Excludes prompts, tool inputs, and tool results.
   * A `notice` needs the person, for example a denied permission. Other events
   * belong in the desk, not in the terminal.
   */
  readonly onActivity?: (message: string, kind: 'event' | 'notice') => void;
  /** The harness process started. It leads its own process group on POSIX. */
  readonly onSpawn?: (pid: number) => void;
  /**
   * The full transcript: the prompt, messages, thinking, tool inputs, and tool
   * results, with subagent work under its tool call. It is private session data.
   */
  readonly onTranscript?: (update: TranscriptUpdate) => void;
}

/** A harness call ran into a time limit: it sent nothing for too long, or it ran for too long. */
export class HarnessTimeoutError extends Error {}

/** A time limit in words, for example "15 minutes" or "4 hours". */
function duration(ms: number): string {
  const [size, unit] =
    ms % 3_600_000 === 0
      ? [ms / 3_600_000, 'hour']
      : ms >= 60_000
        ? [Math.round(ms / 60_000), 'minute']
        : [Math.ceil(ms / 1000), 'second'];
  return `${size} ${unit}${size === 1 ? '' : 's'}`;
}

export interface HarnessResult {
  readonly text: string;
  readonly sessionId?: string;
}

export interface HarnessOptions {
  /** Override the executable for an isolated host installation or a test fixture. */
  readonly executable?: string;
}

const maxBytes = 2 * 1024 * 1024;
/** One protocol line, for example one tool result, can be large. The whole stream has no size limit. */
const maxLine = 8 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sessionId(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)
    ? value
    : undefined;
}

/**
 * Reads one host stream line by line. It keeps only what the final result
 * needs, so a long run does not fill memory.
 */
function reader(host: HarnessName): {
  line(event: unknown): void;
  result(): HarnessResult;
} {
  let last: Record<string, unknown> | undefined;
  let text: string | undefined;
  let id: string | undefined;
  let failed = false;
  return {
    line(event) {
      if (host === 'claude') {
        if (record(event) && (event.type === 'result' || 'result' in event))
          last = event;
        return;
      }
      if (!record(event)) throw new Error('Codex returned an invalid event.');
      if (event.type === 'thread.started') id = sessionId(event.thread_id);
      if (event.type === 'turn.failed' || event.type === 'error') failed = true;
      if (
        event.type === 'item.completed' &&
        record(event.item) &&
        event.item.type === 'agent_message' &&
        typeof event.item.text === 'string'
      )
        text = event.item.text;
    },
    result() {
      if (host === 'claude') {
        if (!last || last.is_error === true)
          throw new Error(
            'Claude reported a failed request. Check the host session.',
          );
        if (typeof last.result !== 'string' || !last.result.trim())
          throw new Error('Claude returned no result text.');
        const claude = sessionId(last.session_id);
        return { text: last.result, ...(claude ? { sessionId: claude } : {}) };
      }
      if (failed)
        throw new Error(
          'Codex reported a failed request. Check the host session.',
        );
      if (!text?.trim()) throw new Error('Codex returned no result text.');
      return { text, ...(id ? { sessionId: id } : {}) };
    },
  };
}

/** Send harness activity to a progress line. Events become `tool` lines, which only the desk shows. */
export function activityProgress(
  progress: ((value: string, source?: 'tool') => void) | undefined,
): (message: string, kind: 'event' | 'notice') => void {
  return (message, kind) =>
    progress?.(message, kind === 'notice' ? undefined : 'tool');
}

interface Activity {
  readonly text: string;
  /** Permission denials need the person. Other activity is an observed event. */
  readonly kind: 'event' | 'notice';
}

const observed = (text: string): Activity => ({ text, kind: 'event' });

/** Only protocol identifiers can appear in activity messages, never private payloads. */
function activity(host: HarnessName, event: unknown): Activity[] {
  if (!record(event)) return [];
  const label = (value: unknown): string | undefined =>
    typeof value === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/.test(value)
      ? value
      : undefined;
  if (host === 'claude') {
    if (event.type === 'system' && event.subtype === 'init') {
      const model = label(event.model);
      const id = sessionId(event.session_id);
      return [
        observed(
          `Claude Code session connected.${model ? ` Model: ${model}.` : ''}${id ? ` Session: ${id}.` : ''}`,
        ),
      ];
    }
    if (event.type === 'system' && event.subtype === 'permission_denied')
      return [
        {
          text: 'Claude Code denied a tool request. Review permissions in Claude Code; Verifold cannot answer native approval prompts.',
          kind: 'notice',
        },
      ];
    if (
      Array.isArray(event.permission_denials) &&
      event.permission_denials.length
    ) {
      const id = sessionId(event.session_id);
      return [
        {
          text: `Claude Code denied ${event.permission_denials.length} tool request(s). ${id ? `Open claude --resume ${id} to review permissions.` : 'Review permissions in Claude Code.'} Verifold cannot answer native approval prompts.`,
          kind: 'notice',
        },
      ];
    }
    if (
      (event.type === 'assistant' || event.type === 'user') &&
      record(event.message) &&
      Array.isArray(event.message.content)
    )
      return event.message.content.flatMap((block: unknown) =>
        record(block) && event.type === 'assistant' && block.type === 'tool_use'
          ? [
              observed(
                `Claude Code requested ${label(block.name) ?? 'tool'}${event.parent_tool_use_id ? ' in a native subagent' : ''}.`,
              ),
            ]
          : record(block) &&
              event.type === 'user' &&
              block.type === 'tool_result'
            ? [
                observed(
                  `Claude Code tool returned${block.is_error === true ? ' an error' : ' a result'}${event.parent_tool_use_id ? ' in a native subagent' : ''}.`,
                ),
              ]
            : [],
      );
  } else {
    if (event.type === 'thread.started')
      return [observed('Codex session connected.')];
    if (
      (event.type === 'item.started' || event.type === 'item.completed') &&
      record(event.item)
    ) {
      const labels: Record<string, string> = {
        command_execution: 'a command',
        web_search: 'web search',
        mcp_tool_call: 'an MCP tool',
        collab_tool_call: 'native agent coordination',
        file_change: 'a file change',
      };
      const tool =
        typeof event.item.type === 'string' &&
        Object.hasOwn(labels, event.item.type)
          ? labels[event.item.type]
          : undefined;
      if (tool)
        return [
          observed(
            `Codex ${event.type === 'item.started' ? 'started' : 'finished'} ${tool}.`,
          ),
        ];
    }
  }
  return [];
}

/**
 * Variables that a running Claude Code session gives its child processes. When
 * Verifold runs inside such a session, they would tie a harness to that session:
 * for example, Claude Code turns transcript saving off for a child session.
 */
const parentSessionVariables = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
];

/** The file of a pod secret in `~/.verifold/credentials`. Its record adds `.json`. */
export function secretFile(name: string): string {
  return `secret-${name}`;
}

/** The names of the pod secrets that the person stored on this computer. */
export function storedSecretNames(home = homedir()): string[] {
  try {
    return readdirSync(join(home, '.verifold', 'credentials')).flatMap(
      (entry) => /^secret-([A-Z][A-Z0-9_]{0,63})\.json$/.exec(entry)?.[1] ?? [],
    );
  } catch {
    return [];
  }
}

/**
 * The environment for a child process (a harness, a terminal, or Git): the
 * person's environment without the variables of a parent harness session,
 * without RunPod variables, and without variables named like a stored pod
 * secret. A RunPod key that the person exported for runpodctl, or an HF_TOKEN
 * that the person also stored for pods, would otherwise reach the shell of
 * each worker, and a worker that runs `env` would put it in its transcript.
 * Harnesses keep their own keys, such as ANTHROPIC_API_KEY, because they need them.
 */
export function childEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of parentSessionVariables) delete environment[name];
  for (const name of Object.keys(environment))
    if (name.startsWith('RUNPOD_')) delete environment[name];
  for (const name of storedSecretNames()) delete environment[name];
  return environment;
}

/**
 * Validate a host identifier without selecting or resolving a model for the
 * user. A short suffix in brackets, such as Claude Code's `opus[1m]` for a
 * 1M context, is part of the identifier.
 */
export function validateModel(
  model: unknown,
): asserts model is string | undefined {
  if (
    model !== undefined &&
    (typeof model !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,189}(?:\[[a-z0-9]{1,8}\])?$/.test(
        model,
      ))
  )
    throw new Error(
      'Harness model must be a valid identifier of at most 200 characters.',
    );
}

/**
 * Run one host request with the user's host configuration and permissions.
 * Prompts use stdin and are limited to 2 MiB. Output is read line by line, and
 * one line is limited to 8 MiB. Error output is limited to 2 MiB. A call stops
 * when the host sends nothing for 15 minutes, or after four hours in all.
 * Cancellation stops the process group on POSIX.
 * Errors exclude raw host output, which can contain private session data.
 */
export async function runHarness(
  request: HarnessRequest,
  options: HarnessOptions = {},
): Promise<HarnessResult> {
  request.signal.throwIfAborted();
  if (request.sessionId !== undefined && !sessionId(request.sessionId)) {
    throw new Error('Harness session ID has an invalid format.');
  }
  validateModel(request.model);
  const timeoutMs = request.timeoutMs ?? 4 * 3_600_000;
  const idleMs = request.idleMs ?? 15 * 60_000;
  for (const limit of [timeoutMs, idleMs])
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_147_483_647)
      throw new Error(
        'Harness timeout must be a positive integer in milliseconds.',
      );
  if (Buffer.byteLength(request.prompt) > maxBytes) {
    throw new Error('Harness prompt exceeds the 2 MiB limit.');
  }
  const args =
    request.host === 'claude'
      ? [
          '-p',
          '--output-format',
          'stream-json',
          '--verbose',
          ...(request.model ? ['--model', request.model] : []),
          ...(request.sessionId ? ['--resume', request.sessionId] : []),
        ]
      : [
          '--search',
          'exec',
          '--skip-git-repo-check',
          '--color',
          'never',
          '--json',
          ...(request.sessionId ? ['resume'] : []),
          ...(request.model ? ['--model', request.model] : []),
          ...(request.sessionId ? [request.sessionId, '-'] : ['-']),
        ];
  const stream = reader(request.host);
  return new Promise<HarnessResult>((resolve, reject) => {
    const child = spawn(options.executable ?? request.host, args, {
      cwd: request.cwd,
      env: childEnvironment(),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (child.pid !== undefined) request.onSpawn?.(child.pid);
    let errorBytes = 0;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const decoder = new StringDecoder('utf8');
    let pending = '';

    function kill(signal: NodeJS.Signals): void {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (!record(error) || error.code !== 'ESRCH') {
          failure ??= new Error('Could not stop the harness process.', {
            cause: error,
          });
        }
      }
    }

    function stop(error: Error): void {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1_000);
    }

    function abort(): void {
      stop(
        new Error('Harness request was cancelled.', {
          cause: request.signal.reason,
        }),
      );
    }

    /** Read one line. Invalid output stops the host, because its result cannot be trusted. */
    function line(text: string): void {
      if (failure || !text.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(text);
        stream.line(event);
      } catch (error) {
        stop(
          error instanceof SyntaxError
            ? new Error(`${request.host} returned invalid JSON.`, {
                cause: error,
              })
            : error instanceof Error
              ? error
              : new Error(`${request.host} returned an invalid event.`),
        );
        return;
      }
      try {
        if (request.onActivity)
          for (const { text, kind } of activity(request.host, event))
            request.onActivity(text, kind);
        if (request.onTranscript)
          for (const update of request.host === 'claude'
            ? claudeUpdates(event)
            : codexExecUpdates(event))
            request.onTranscript(update);
      } catch {
        stop(new Error('Could not report harness activity.'));
      }
    }

    const deadline = setTimeout(
      () =>
        stop(
          new HarnessTimeoutError(
            `The agent ran for ${duration(timeoutMs)}, the longest that one call can run, so Verifold stopped it.`,
          ),
        ),
      timeoutMs,
    );
    // Each line of output starts the quiet period again.
    const quiet = setTimeout(
      () =>
        stop(
          new HarnessTimeoutError(
            `The agent sent nothing for ${duration(idleMs)}, so Verifold stopped it.`,
          ),
        ),
      idleMs,
    );
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    try {
      request.onTranscript?.(requestUpdate(request.prompt));
    } catch {
      stop(new Error('Could not report harness activity.'));
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      quiet.refresh();
      pending += decoder.write(chunk);
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const text of lines) line(text);
      if (pending.length > maxLine)
        stop(new Error('Harness output exceeds the 8 MiB line limit.'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > maxBytes)
        stop(new Error('Harness error output exceeds the 2 MiB limit.'));
    });
    child.stdin.on('error', (error: Error) =>
      stop(new Error('Could not send the harness prompt.', { cause: error })),
    );
    child.on('error', (error) => {
      failure ??= new Error(
        `Could not start ${request.host}. Check that it is installed and available.`,
        { cause: error },
      );
    });
    child.on('close', (code) => {
      line(pending + decoder.end());
      clearTimeout(deadline);
      clearTimeout(quiet);
      clearTimeout(killTimer);
      request.signal.removeEventListener('abort', abort);
      if (failure) {
        kill('SIGKILL');
        reject(failure);
      } else if (code !== 0) {
        reject(
          new Error(
            `${request.host} exited with status ${String(code)}. Check host authentication and permissions.`,
          ),
        );
      } else {
        try {
          resolve(stream.result());
        } catch (error) {
          reject(error instanceof Error ? error : new Error('Invalid result.'));
        }
      }
    });
    child.stdin.end(request.prompt);
  });
}
