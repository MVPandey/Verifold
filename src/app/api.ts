import {
  protocolVersion,
  type ActionBodies,
  type ActionName,
  type ActionResult,
  type BoardPage,
  type BringRead,
  type DirectionDiff,
  type FileDiff,
  type HistoryList,
  type HistoryRun,
  type HistoryTask,
  type HistoryTurns,
  type PostThread,
  type RunDetail,
  type Snapshot,
  type TurnDetail,
  type TurnPage,
} from '../protocol/api.ts';
import { exchangeLaunch, readFragment } from '../ui/token.ts';

/**
 * The desk's token for this tab. The URL fragment carries it, or a one-time
 * launch code that the desk exchanges for it, as on the desk's own page. The
 * fragment then becomes the app's route.
 */
export async function takeToken(): Promise<string | null> {
  const { token, launch } = readFragment('#/');
  if (launch) return (await exchangeLaunch(launch)) ?? (token || null);
  return token || null;
}

/**
 * How an action ended. `pending`: Verifold took it, and it goes on in the
 * background (202), so a later snapshot shows how it ends. `refused`:
 * Verifold answered and said no, so a new attempt needs a new key. `lost`:
 * no answer came, so nobody knows whether it ran, and a retry keeps the key.
 */
export type ActOutcome =
  | { readonly ok: true; readonly pending?: true }
  | { readonly refused: string }
  | { readonly lost: string };

function isError(
  value: unknown,
): value is Extract<ActionResult, { error: string }> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'string'
  );
}

/**
 * Run a lab action with the key of the person's intent. The caller makes
 * the key once per intent and gives it again on a retry (see intent.ts), so
 * an action whose answer was lost runs once.
 */
export async function act<Name extends ActionName>(
  token: string,
  name: Name,
  body: ActionBodies[Name],
  key: string,
): Promise<ActOutcome> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/actions/${name}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...body, key }),
    });
  } catch {
    return { lost: 'Verifold did not answer. Send again to retry.' };
  }
  if (response.ok)
    return response.status === 202 ? { ok: true, pending: true } : { ok: true };
  const result: unknown = await response.json().catch(() => null);
  return {
    refused: isError(result)
      ? result.error
      : 'Verifold could not run this. Try again.',
  };
}

/** What a read of folded detail gave: the data, or why there is none. */
export type Loaded<T> = { readonly value: T } | { readonly error: string };

/** Which steps of a turn to read: before a step's index, how many, and tool calls only. */
export interface StepQuery {
  readonly before?: number;
  readonly limit?: number;
  readonly tools?: boolean;
}

/** The API paths of an agent's turns, of one turn's steps, and of a post's thread. */
export const paths = {
  turns: (agent: string, before: string): string =>
    `/api/v1/agents/${encodeURIComponent(agent)}/turns?before=${encodeURIComponent(before)}`,
  turn: (agent: string, turn: string, query: StepQuery = {}): string => {
    const search = new URLSearchParams();
    if (query.before !== undefined) search.set('before', String(query.before));
    if (query.limit !== undefined) search.set('limit', String(query.limit));
    if (query.tools) search.set('tools', '1');
    const rest = search.toString();
    return `/api/v1/agents/${encodeURIComponent(agent)}/turns/${encodeURIComponent(turn)}${rest ? `?${rest}` : ''}`;
  },
  /** What a bring-in of a direction can copy. */
  bring: (direction: string): string =>
    `/api/v1/directions/${encodeURIComponent(direction)}/bring`,
  /** One file's diff at the commit of a bring-in. */
  bringDiff: (direction: string, file: string, commit: string): string =>
    `/api/v1/directions/${encodeURIComponent(direction)}/bring/diff?${new URLSearchParams({ file, commit }).toString()}`,
  /** A post and the replies below it. */
  thread: (post: string): string => `/api/v1/posts/${encodeURIComponent(post)}`,
  /** A run in full, with its kept files and the end of its log. */
  run: (id: string): string => `/api/v1/runs/${encodeURIComponent(id)}`,
  /** A direction's diff since its start, or the diff that a post cites, with one file's diff. */
  diff: (
    direction: string,
    query: { readonly file?: string; readonly proof?: string } = {},
  ): string => {
    const search = new URLSearchParams();
    if (query.proof !== undefined) search.set('proof', query.proof);
    if (query.file !== undefined) search.set('file', query.file);
    const rest = search.toString();
    return `/api/v1/directions/${encodeURIComponent(direction)}/diff${rest ? `?${rest}` : ''}`;
  },
  /** The page of the board before a post. */
  board: (before: string): string =>
    `/api/v1/board?before=${encodeURIComponent(before)}`,
  /** History: the project's runs and its memory files. */
  history: '/api/v1/history',
  /** One run of History: `current` or an archive ID. */
  historyRun: (id: string): string =>
    `/api/v1/history/${encodeURIComponent(id)}`,
  /** One task of a research-flow run, in full. */
  historyTask: (id: string, task: string): string =>
    `/api/v1/history/${encodeURIComponent(id)}/tasks/${encodeURIComponent(task)}`,
  /** The turns of a research attempt (`attempt:<id>`) or a session (`session:<id>`) in a run. */
  historyTurns: (id: string, source: string): string =>
    `/api/v1/history/${encodeURIComponent(id)}/turns?${new URLSearchParams({ source }).toString()}`,
  /** One file's diff of a task version in a run. */
  historyDiff: (
    id: string,
    task: string,
    version: number,
    file: string,
  ): string =>
    `/api/v1/history/${encodeURIComponent(id)}/tasks/${encodeURIComponent(task)}/diff?${new URLSearchParams({ version: String(version), file }).toString()}`,
} as const;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isHistoryList(value: unknown): value is HistoryList {
  return (
    object(value) &&
    (value.current === null || object(value.current)) &&
    Array.isArray(value.runs) &&
    typeof value.more === 'boolean' &&
    Array.isArray(value.memory)
  );
}

export function isHistoryRun(value: unknown): value is HistoryRun {
  return (
    object(value) &&
    (value.kind === 'lab' || value.kind === 'research') &&
    object(value.entry) &&
    typeof value.entry.id === 'string'
  );
}

export function isHistoryTask(value: unknown): value is HistoryTask {
  return (
    object(value) &&
    typeof value.id === 'string' &&
    Array.isArray(value.attempts)
  );
}

export function isHistoryTurns(value: unknown): value is HistoryTurns {
  return (
    object(value) &&
    Array.isArray(value.turns) &&
    typeof value.more === 'boolean'
  );
}

export function isTurnPage(value: unknown): value is TurnPage {
  return (
    object(value) &&
    Array.isArray(value.turns) &&
    typeof value.more === 'boolean'
  );
}

export function isPostThread(value: unknown): value is PostThread {
  return (
    object(value) &&
    Array.isArray(value.posts) &&
    value.posts.length > 0 &&
    typeof value.more === 'boolean'
  );
}

export function isTurnDetail(value: unknown): value is TurnDetail {
  return (
    object(value) &&
    object(value.turn) &&
    Array.isArray(value.steps) &&
    typeof value.more === 'boolean'
  );
}

export function isBringRead(value: unknown): value is BringRead {
  return (
    object(value) &&
    (value.list === null ||
      (object(value.list) &&
        typeof value.list.commit === 'string' &&
        Array.isArray(value.list.files))) &&
    (value.error === null || typeof value.error === 'string') &&
    Array.isArray(value.history)
  );
}

export function isRunDetail(value: unknown): value is RunDetail {
  return (
    object(value) &&
    object(value.run) &&
    typeof value.run.id === 'string' &&
    Array.isArray(value.outputs) &&
    (value.log === null || object(value.log)) &&
    typeof value.cancelable === 'boolean'
  );
}

export function isDirectionDiff(value: unknown): value is DirectionDiff {
  return (
    object(value) &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    Array.isArray(value.files) &&
    (value.diff === null || object(value.diff))
  );
}

export function isBoardPage(value: unknown): value is BoardPage {
  return (
    object(value) &&
    Array.isArray(value.posts) &&
    typeof value.more === 'boolean'
  );
}

export function isFileDiff(value: unknown): value is FileDiff {
  return (
    object(value) &&
    typeof value.text === 'string' &&
    typeof value.trimmed === 'boolean' &&
    typeof value.commit === 'string'
  );
}

/**
 * Read detail that a snapshot keeps folded, such as a turn's steps. The
 * answer is the data, or a reason in plain words: Verifold's own, when it
 * gave one, such as why a diff is not there. A read that `signal` aborted
 * answers with a reason too: the caller drops it.
 */
export async function load<T>(
  token: string,
  path: string,
  is: (value: unknown) => value is T,
  signal?: AbortSignal,
): Promise<Loaded<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      headers: { Authorization: `Bearer ${token}` },
      ...(signal ? { signal } : {}),
    });
  } catch {
    return { error: "Can't reach Verifold. Try again." };
  }
  if (response.status === 401)
    return {
      error:
        'This tab has no access key. Open Verifold from your terminal again.',
    };
  if (!response.ok) {
    const refusal: unknown = await response.json().catch(() => null);
    if (isError(refusal)) return { error: refusal.error };
    return response.status === 404
      ? { error: 'Verifold no longer has this. The lab may have moved on.' }
      : { error: 'Verifold could not send this. Try again.' };
  }
  const value: unknown = await response.json().catch(() => null);
  return is(value)
    ? { value }
    : { error: 'Verifold sent something this page cannot read. Reload it.' };
}

/**
 * Split Server-Sent Events text into whole events. Returns the events and
 * the unfinished rest. Comment lines, such as the heartbeat, are skipped.
 */
export function parseEvents(text: string): {
  readonly events: readonly { readonly event: string; readonly data: string }[];
  readonly rest: string;
} {
  const blocks = text.replace(/\r\n?/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: { event: string; data: string }[] = [];
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

/**
 * Why the stream stopped for good. `signed-out`: the token is not valid
 * (401). `outdated`: Verifold speaks another protocol version than this page.
 * `refused`: Verifold answered with another error, such as 403 or 503.
 */
export class StreamStop extends Error {
  readonly reason: 'signed-out' | 'outdated' | 'refused';
  constructor(reason: 'signed-out' | 'outdated' | 'refused') {
    super(reason);
    this.reason = reason;
  }
}

/** The server is Verifold itself. This check catches a wrong endpoint or another protocol version. */
function isSnapshot(value: unknown): value is Snapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    'protocolVersion' in value &&
    value.protocolVersion === protocolVersion &&
    'epoch' in value &&
    typeof value.epoch === 'string' &&
    'rev' in value &&
    typeof value.rev === 'number'
  );
}

function snapshotOf(data: string): Snapshot {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new StreamStop('refused');
  }
  if (isSnapshot(value)) return value;
  const version =
    typeof value === 'object' && value !== null && 'protocolVersion' in value
      ? value.protocolVersion
      : undefined;
  throw new StreamStop(
    version !== undefined && version !== protocolVersion
      ? 'outdated'
      : 'refused',
  );
}

/**
 * Read the event stream until it ends. A network failure throws as it is,
 * and the caller may retry it. Verifold's own refusals throw `StreamStop`.
 */
export async function readStream(
  token: string,
  signal: AbortSignal,
  onSnapshot: (snapshot: Snapshot) => void,
): Promise<void> {
  const response = await fetch('/api/v1/events', {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal,
  });
  if (response.status === 401) throw new StreamStop('signed-out');
  if (!response.ok || !response.body) throw new StreamStop('refused');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseEvents(buffer);
    buffer = rest;
    for (const event of events)
      if (event.event === 'snapshot') onSnapshot(snapshotOf(event.data));
  }
}
