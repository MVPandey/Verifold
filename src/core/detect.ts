import { execFile } from 'node:child_process';
import { childEnvironment, type HarnessName } from './harness.ts';
import {
  claudeOpus,
  listCodexModels,
  offered,
  pickCodexModel,
  slug,
  type CodexCall,
} from './models.ts';
import { codexInitialize, startCodexServer } from './session-hosts.ts';
import type { UnixWebSocket } from './unix-websocket.ts';

/** One model that the first run offers for a harness. */
export interface ModelChoice {
  readonly id: string;
  readonly label: string;
}

/**
 * What Verifold found out about a harness on this computer. It keeps no
 * account fields, such as the email or the organization.
 */
export interface HarnessStatus {
  readonly harness: HarnessName;
  readonly installed: boolean;
  readonly version: string | null;
  /** Null: Verifold could not tell. */
  readonly signedIn: boolean | null;
  /** Claude Code's plan, such as `max`. Null for Codex, or when unknown. */
  readonly plan: string | null;
  /** The models to offer, the one that Verifold picks first. Empty: only the harness's default. */
  readonly models: readonly ModelChoice[];
}

/** The longest that one detection command can run. */
const commandMs = 10_000;

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  /** Standard output and standard error together. */
  readonly output: string;
  readonly missing: boolean;
  /** The output was longer than `maxBuffer`, so the command stopped. */
  readonly overflow: boolean;
}

/**
 * Run a harness command with no shell and no RunPod variables, for at most
 * 10 seconds. `maxBuffer` bounds each output stream, 256 KB by default.
 * `signal` stops the command.
 */
export function runCommand(
  executable: string,
  args: readonly string[],
  options: { readonly maxBuffer?: number; readonly signal?: AbortSignal } = {},
): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        env: childEnvironment(),
        timeout: commandMs,
        maxBuffer: options.maxBuffer ?? 256 * 1024,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        const code =
          error === null
            ? 0
            : typeof error.code === 'number'
              ? error.code
              : null;
        resolve({
          code,
          stdout,
          output: `${stdout}\n${stderr}`,
          missing: error?.code === 'ENOENT',
          overflow: error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        });
      },
    );
  });
}

function version(output: string): string | null {
  return /\b(\d{1,4}\.\d{1,4}\.\d{1,6})\b/.exec(output)?.[1] ?? null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Claude Code's models, the one for lab agents first: the person's own Opus
 * model as written, else `opus`. Fable is offered only on a plan that
 * includes it, because a Fable request on another plan bills usage credits
 * without asking. The labels name no version: the aliases move.
 */
export function claudeChoices(
  own: string | null,
  plan: string | null,
): ModelChoice[] {
  return [
    {
      id: own ?? 'opus',
      label: own
        ? `Opus${/\[1m\]$/.test(own) ? ', 1M context' : ''} (your Claude Code default)`
        : 'Opus',
    },
    ...(plan === 'max'
      ? [{ id: 'fable', label: 'Fable, the most capable' }]
      : []),
    { id: 'sonnet', label: 'Sonnet' },
  ];
}

/**
 * Codex's models from `model/list`, Verifold's pick first: the first of
 * Verifold's list that Codex offers. When Codex offers none of them, the
 * first choice is the person's own Codex model. It has no ID, because a lab
 * agent then sends Codex no model.
 */
export function codexChoices(entries: readonly unknown[]): ModelChoice[] {
  const pick = pickCodexModel(entries);
  const choices: ModelChoice[] = pick
    ? []
    : [{ id: '', label: 'Your Codex default' }];
  for (const entry of offered(entries)) {
    const id = slug(entry);
    if (!id || choices.some((choice) => choice.id === id)) continue;
    const name =
      typeof entry.displayName === 'string' && entry.displayName.trim()
        ? entry.displayName.trim().slice(0, 60)
        : id;
    const notes = [
      id === pick ? 'the most capable' : '',
      entry.isDefault === true ? 'the Codex default' : '',
    ].filter(Boolean);
    choices.push({
      id,
      label: notes.length ? `${name}, ${notes.join(' and ')}` : name,
    });
    if (choices.length >= 20) break;
  }
  return choices.sort((a, b) => Number(b.id === pick) - Number(a.id === pick));
}

/**
 * One question to a short-lived Codex app-server, started with the `-c`
 * options in `config`. After `initialize`, `ask` sends its requests with
 * `call` and gives the answer to `finish`. Null when the server does not
 * answer in 10 seconds, refuses a request that has no `onError`, or
 * `signal` stops the question.
 */
export async function askCodexServer<T>(
  executable: string,
  config: readonly string[],
  ask: (call: CodexCall, finish: (value: T | null) => void) => void,
  signal?: AbortSignal,
): Promise<T | null> {
  if (signal?.aborted) return null;
  const server = startCodexServer({ executable, config });
  let finish: (value: T | null) => void = () => {};
  const answer = new Promise<T | null>((resolve) => {
    finish = resolve;
  });
  const deadline = Date.now() + commandMs;
  const timer = setTimeout(() => finish(null), commandMs);
  // A stop ends the wait, and the `finally` below stops the server.
  const stop = (): void => finish(null);
  signal?.addEventListener('abort', stop, { once: true });
  let connection: UnixWebSocket | null = null;
  try {
    const answers = new Map<
      number,
      {
        readonly onResult: (result: Record<string, unknown>) => void;
        readonly onError: (() => void) | undefined;
      }
    >();
    let nextId = 1;
    const opened = await Promise.race([
      server.connect(
        deadline,
        (text) => {
          let message: unknown;
          try {
            message = JSON.parse(text);
          } catch {
            return;
          }
          if (!record(message) || typeof message.id !== 'number') return;
          const answered = answers.get(message.id);
          answers.delete(message.id);
          if (message.error !== undefined)
            (answered?.onError ?? (() => finish(null)))();
          else answered?.onResult(record(message.result) ? message.result : {});
        },
        () => finish(null),
      ),
      answer.then(() => null),
    ]).catch(() => null);
    if (!opened) return null;
    connection = opened;
    const call: CodexCall = (method, params, onResult, onError) => {
      const id = nextId++;
      answers.set(id, { onResult, onError });
      opened.send(JSON.stringify({ method, id, params }));
    };
    call('initialize', codexInitialize('1'), () => {
      opened.send(JSON.stringify({ method: 'initialized', params: {} }));
      ask(call, finish);
    });
    return await answer;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    connection?.close();
    server.stop();
  }
}

/** Codex's `model/list`, read with the session's own paging. */
function codexModelList(executable: string): Promise<unknown[] | null> {
  return askCodexServer<unknown[]>(executable, [], (call, finish) =>
    listCodexModels(call, finish),
  );
}

/** The executables that detection runs. Tests use fakes. */
export interface DetectOptions {
  readonly claude?: string;
  readonly codex?: string;
  /** Claude Code's settings folder, for the person's own model. */
  readonly claudeConfig?: string;
}

async function detectClaude(options: DetectOptions): Promise<HarnessStatus> {
  const executable = options.claude ?? 'claude';
  const shown = await runCommand(executable, ['--version']);
  if (shown.missing)
    return {
      harness: 'claude',
      installed: false,
      version: null,
      signedIn: null,
      plan: null,
      models: [],
    };
  const auth = await runCommand(executable, ['auth', 'status']);
  let signedIn: boolean | null = null;
  let plan: string | null = null;
  try {
    // Claude Code prints the status as JSON over several lines.
    const status: unknown = JSON.parse(auth.stdout);
    if (record(status)) {
      if (typeof status.loggedIn === 'boolean') signedIn = status.loggedIn;
      if (
        typeof status.subscriptionType === 'string' &&
        /^[a-z_]{1,20}$/.test(status.subscriptionType)
      )
        plan = status.subscriptionType;
    }
  } catch {
    // Older versions print text. A failed check leaves the state unknown.
    if (auth.code !== 0 && /not logged in|log in/i.test(auth.output))
      signedIn = false;
  }
  return {
    harness: 'claude',
    installed: true,
    version: version(shown.output),
    signedIn,
    plan,
    models: claudeChoices(await claudeOpus(options.claudeConfig), plan),
  };
}

async function detectCodex(options: DetectOptions): Promise<HarnessStatus> {
  const executable = options.codex ?? 'codex';
  const shown = await runCommand(executable, ['--version']);
  if (shown.missing)
    return {
      harness: 'codex',
      installed: false,
      version: null,
      signedIn: null,
      plan: null,
      models: [],
    };
  const login = await runCommand(executable, ['login', 'status']);
  const signedIn = /\bnot logged in\b/i.test(login.output)
    ? false
    : /\blogged in\b/i.test(login.output)
      ? true
      : null;
  const list = signedIn === false ? null : await codexModelList(executable);
  return {
    harness: 'codex',
    installed: true,
    version: version(shown.output),
    signedIn,
    plan: null,
    models: list ? codexChoices(list) : [],
  };
}

/** Find Claude Code and Codex, each with its version, sign-in, and models. */
export async function detectHarnesses(
  options: DetectOptions = {},
): Promise<readonly HarnessStatus[]> {
  return Promise.all([detectClaude(options), detectCodex(options)]);
}
