import { execFile } from 'node:child_process';
import { childEnvironment, type HarnessName } from './harness.ts';
import {
  claudeOpus,
  codexDefault,
  codexModels,
  listCodexModels,
  pickCodexModel,
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
}

/** Run a harness command with no shell and no RunPod variables, for at most 10 seconds. */
function run(executable: string, args: readonly string[]): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      executable,
      args,
      {
        env: childEnvironment(),
        timeout: commandMs,
        maxBuffer: 256 * 1024,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
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
 * Verifold's list that Codex offers, else the model that Codex marks as its
 * default. When Codex offers none of Verifold's list, a lab agent without a
 * chosen model runs the person's own Codex model.
 */
export function codexChoices(entries: readonly unknown[]): ModelChoice[] {
  const pick = pickCodexModel(entries) ?? codexDefault(entries);
  const choices: ModelChoice[] = [];
  for (const entry of entries) {
    if (!record(entry) || entry.hidden === true) continue;
    const id =
      typeof entry.model === 'string' && entry.model
        ? entry.model
        : typeof entry.id === 'string'
          ? entry.id
          : '';
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,99}$/.test(id) ||
      choices.some((choice) => choice.id === id)
    )
      continue;
    const name =
      typeof entry.displayName === 'string' && entry.displayName.trim()
        ? entry.displayName.trim().slice(0, 60)
        : id;
    const notes = [
      id === pick && codexModels.includes(id) ? 'the most capable' : '',
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
 * Codex's `model/list`, through a short-lived app-server, read with the
 * session's own paging. Null when it does not answer in 10 seconds or
 * refuses.
 */
async function codexModelList(executable: string): Promise<unknown[] | null> {
  const server = startCodexServer({ executable, config: [] });
  let finish: (value: unknown[] | null) => void = () => {};
  const answer = new Promise<unknown[] | null>((resolve) => {
    finish = resolve;
  });
  const deadline = Date.now() + commandMs;
  const timer = setTimeout(() => finish(null), commandMs);
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
      answer,
    ]).catch(() => null);
    if (!opened || Array.isArray(opened)) return null;
    connection = opened;
    const call: CodexCall = (method, params, onResult, onError) => {
      const id = nextId++;
      answers.set(id, { onResult, onError });
      opened.send(JSON.stringify({ method, id, params }));
    };
    call('initialize', codexInitialize('1'), () => {
      opened.send(JSON.stringify({ method: 'initialized', params: {} }));
      listCodexModels(call, finish);
    });
    return await answer;
  } finally {
    clearTimeout(timer);
    connection?.close();
    server.stop();
  }
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
  const shown = await run(executable, ['--version']);
  if (shown.missing)
    return {
      harness: 'claude',
      installed: false,
      version: null,
      signedIn: null,
      plan: null,
      models: [],
    };
  const auth = await run(executable, ['auth', 'status']);
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
  const shown = await run(executable, ['--version']);
  if (shown.missing)
    return {
      harness: 'codex',
      installed: false,
      version: null,
      signedIn: null,
      plan: null,
      models: [],
    };
  const login = await run(executable, ['login', 'status']);
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
