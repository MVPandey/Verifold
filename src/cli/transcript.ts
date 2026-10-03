import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { appendFile, lstat, open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';

const kinds = ['request', 'text', 'thinking', 'tool', 'note'] as const;
const statuses = ['running', 'done', 'failed'] as const;

/**
 * One node of a harness transcript, as the harness reported it. A tool call
 * holds its input and later its output. `parent` is the tool call that started
 * a subagent, so subagent work nests under that call.
 */
export interface TranscriptEntry {
  readonly id: string;
  /** Update counter of the log. A later update to the same entry gets a higher number. */
  readonly seq: number;
  /** Creation order in the log. It does not change, so the page can keep entries in order. */
  readonly order: number;
  readonly parent: string | null;
  readonly at: string;
  readonly kind: (typeof kinds)[number];
  /** Tool name. */
  readonly name?: string;
  /** One line for a collapsed tool call, for example the command or the file path. */
  readonly title?: string;
  readonly input?: string;
  readonly output?: string;
  readonly status?: (typeof statuses)[number];
  readonly text?: string;
}

/** A new entry, or fields to merge into the entry with the same ID. */
export interface TranscriptUpdate {
  readonly id?: string;
  readonly parent?: string | null;
  readonly kind?: TranscriptEntry['kind'];
  readonly name?: string;
  readonly title?: string;
  readonly input?: string;
  readonly output?: string;
  readonly status?: TranscriptEntry['status'];
  readonly text?: string;
}

/** An update with its final ID and time, as one line of a transcript file. */
interface StampedUpdate extends TranscriptUpdate {
  readonly id: string;
  readonly at: string;
}

/** Receives the updates of harness runs. Each run gets its own ID prefix, so runs do not mix. */
export interface TranscriptSink {
  run(): (update: TranscriptUpdate) => void;
}

/** Each text field is capped. The cut is visible in the text. */
const fieldLimit = 64 * 1024;
/** A transcript stops growing at this size, with a note. */
export const transcriptLimit = 16 * 1024 * 1024;
const cutNote =
  'Verifold stopped recording this transcript at 16 MB. Later events are not recorded.';

/** Text without terminal control sequences, other control characters, or direction overrides. Tabs and line breaks stay. */
function bounded(value: string): string {
  const text = stripVTControlCharacters(value)
    // eslint-disable-next-line no-control-regex -- Harness output must not control the display.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  const size = Buffer.byteLength(text);
  return size <= fieldLimit
    ? text
    : `${Buffer.from(text).subarray(0, fieldLimit).toString('utf8')}\n… [Verifold cut ${size - fieldLimit} more bytes here]`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Readable text for any JSON value. Strings stay as they are. */
function show(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length && value.every(record))
    return value
      .map((part) =>
        typeof part.text === 'string'
          ? part.text
          : JSON.stringify(part, null, 2),
      )
      .join('\n');
  return JSON.stringify(value, null, 2) ?? '';
}

const titleFields = [
  'command',
  'file_path',
  'notebook_path',
  'path',
  'url',
  'query',
  'pattern',
  'description',
  'message',
  'prompt',
];

/** One line that names what a tool call acts on. */
function title(input: unknown): string {
  const line = (value: string): string =>
    (value.split('\n')[0] ?? '').slice(0, 200);
  if (typeof input === 'string') return line(input);
  if (Array.isArray(input) && input.every((part) => typeof part === 'string'))
    return line(input.join(' '));
  if (!record(input)) return '';
  for (const field of titleFields) {
    const value = input[field];
    if (typeof value === 'string') return line(value);
  }
  return line(JSON.stringify(input));
}

/** Transcript updates from one Claude Code stream-json event. */
export function claudeUpdates(event: unknown): TranscriptUpdate[] {
  if (!record(event)) return [];
  const parent =
    typeof event.parent_tool_use_id === 'string'
      ? event.parent_tool_use_id
      : null;
  if (event.type === 'system' && event.subtype === 'init')
    return [
      {
        kind: 'note',
        parent,
        text: `Claude Code session started${typeof event.model === 'string' ? ` with ${event.model}` : ''}.`,
      },
    ];
  if (event.type === 'result')
    return [
      {
        kind: 'note',
        parent,
        text: `The turn ended${event.is_error === true ? ' with an error' : ''}${typeof event.duration_ms === 'number' ? ` after ${Math.round(event.duration_ms / 1000)} s` : ''}.`,
      },
    ];
  if (
    (event.type !== 'assistant' && event.type !== 'user') ||
    !record(event.message)
  )
    return [];
  const user = event.type === 'user';
  const content = event.message.content;
  if (typeof content === 'string')
    return [
      { kind: user ? 'request' : 'text', parent, text: bounded(content) },
    ];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown): TranscriptUpdate[] => {
    if (!record(block)) return [];
    if (block.type === 'text' && typeof block.text === 'string')
      return [
        { kind: user ? 'request' : 'text', parent, text: bounded(block.text) },
      ];
    if (block.type === 'thinking' && typeof block.thinking === 'string')
      return [{ kind: 'thinking', parent, text: bounded(block.thinking) }];
    if (block.type === 'tool_use' && typeof block.id === 'string')
      return [
        {
          id: block.id,
          kind: 'tool',
          parent,
          name: typeof block.name === 'string' ? block.name : 'Tool',
          title: title(block.input),
          input: bounded(show(block.input ?? {})),
          status: 'running',
        },
      ];
    if (block.type === 'tool_result' && typeof block.tool_use_id === 'string')
      return [
        {
          id: block.tool_use_id,
          output: bounded(show(block.content ?? '')),
          status: block.is_error === true ? 'failed' : 'done',
        },
      ];
    return [];
  });
}

/** A transcript update for one Codex item, from either protocol. */
function codexItem(
  item: Record<string, unknown>,
  started: boolean,
  parent: string | null,
): TranscriptUpdate[] {
  const id = typeof item.id === 'string' ? item.id : undefined;
  const tool = (
    name: string,
    input: unknown,
    output: unknown,
    failed: boolean,
    line: string = title(input),
  ): TranscriptUpdate[] =>
    id
      ? [
          {
            id,
            kind: 'tool',
            parent,
            name,
            title: line,
            input: bounded(show(input ?? '')),
            ...(output === undefined || output === null || output === ''
              ? {}
              : { output: bounded(show(output)) }),
            status: started ? 'running' : failed ? 'failed' : 'done',
          },
        ]
      : [];
  switch (item.type) {
    case 'agent_message':
    case 'agentMessage':
      return started || typeof item.text !== 'string'
        ? []
        : [{ kind: 'text', parent, text: bounded(item.text) }];
    case 'reasoning': {
      if (started) return [];
      const text = [item.text, item.summary, item.content]
        .flatMap((part) =>
          typeof part === 'string'
            ? [part]
            : Array.isArray(part)
              ? part.map(show)
              : [],
        )
        .join('\n')
        .trim();
      return text ? [{ kind: 'thinking', parent, text: bounded(text) }] : [];
    }
    case 'command_execution':
    case 'commandExecution': {
      const exit = item.exit_code ?? item.exitCode;
      return tool(
        'Command',
        item.command,
        item.aggregated_output ?? item.aggregatedOutput,
        (typeof exit === 'number' && exit !== 0) ||
          item.status === 'failed' ||
          item.status === 'declined',
      );
    }
    case 'file_change':
    case 'fileChange':
      return tool(
        'File change',
        item.changes,
        undefined,
        item.status === 'failed' || item.status === 'declined',
        Array.isArray(item.changes)
          ? item.changes
              .filter(record)
              .map((change) =>
                typeof change.path === 'string' ? change.path : '',
              )
              .join(', ')
              .slice(0, 200)
          : '',
      );
    case 'web_search':
    case 'webSearch':
      return tool('Web search', item.query, item.results, false);
    case 'mcp_tool_call':
    case 'mcpToolCall':
    case 'dynamicToolCall':
      return tool(
        `${typeof item.server === 'string' ? `${item.server}.` : ''}${typeof item.tool === 'string' ? item.tool : 'tool'}`,
        item.arguments,
        item.error ?? item.result ?? item.contentItems,
        (item.error !== undefined && item.error !== null) ||
          item.success === false ||
          item.status === 'failed',
      );
    case 'collab_tool_call':
    case 'collabAgentToolCall':
      return tool(
        'Agents',
        item.prompt ?? item.tool,
        item.agentsStates,
        item.status === 'failed',
      );
    case 'error':
      return typeof item.message === 'string'
        ? [{ kind: 'note', parent, text: bounded(item.message) }]
        : [];
    default:
      return [];
  }
}

/** Transcript updates from one `codex exec --json` event. */
export function codexExecUpdates(event: unknown): TranscriptUpdate[] {
  if (!record(event)) return [];
  if (
    (event.type === 'item.started' || event.type === 'item.completed') &&
    record(event.item)
  )
    return codexItem(event.item, event.type === 'item.started', null);
  if (event.type === 'turn.failed' || event.type === 'error')
    return [
      { kind: 'note', parent: null, text: 'Codex reported a failed turn.' },
    ];
  return [];
}

/** Transcript updates from one `codex app-server` item notification. `parent` nests subagent threads. */
export function codexAppUpdates(
  method: string,
  item: unknown,
  parent: string | null,
): TranscriptUpdate[] {
  return (method === 'item/started' || method === 'item/completed') &&
    record(item)
    ? codexItem(item, method === 'item/started', parent)
    : [];
}

/** The text that Verifold or the person sent to the harness. */
export function requestUpdate(text: string): TranscriptUpdate {
  return { kind: 'request', parent: null, text: bounded(text) };
}

/** Pass each harness run of `run` to `sink` too, beside the caller's own transcript callback. */
export function withTranscript<
  R extends { readonly onTranscript?: (update: TranscriptUpdate) => void },
  T,
>(
  run: (request: R) => Promise<T>,
  sink: TranscriptSink,
): (request: R) => Promise<T> {
  return (request) => {
    const apply = sink.run();
    return run({
      ...request,
      onTranscript: (update: TranscriptUpdate) => {
        request.onTranscript?.(update);
        apply(update);
      },
    });
  };
}

/** A random prefix for the IDs of one run. Harness IDs can repeat across runs, for example Codex item IDs. */
function prefixer(): (update: TranscriptUpdate) => StampedUpdate {
  const prefix = `${randomBytes(4).toString('hex')}.`;
  let count = 0;
  return (update) => ({
    ...update,
    id: prefix + (update.id ?? `#${++count}`),
    ...(typeof update.parent === 'string'
      ? { parent: prefix + update.parent }
      : {}),
    at: new Date().toISOString(),
  });
}

/** One saved line, checked. Unknown fields are dropped. */
function parseLine(line: string): StampedUpdate | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    value.id.length > 300 ||
    typeof value.at !== 'string' ||
    value.at.length > 40
  )
    return null;
  const { kind, status, parent } = value;
  const text = (key: string): Record<string, string> => {
    const field = value[key];
    return typeof field === 'string' ? { [key]: bounded(field) } : {};
  };
  return {
    id: value.id,
    at: value.at,
    ...(parent === null || (typeof parent === 'string' && parent.length <= 300)
      ? { parent }
      : {}),
    ...(kinds.find((known) => known === kind)
      ? { kind: kind as TranscriptEntry['kind'] }
      : {}),
    ...(statuses.find((known) => known === status)
      ? { status: status as TranscriptEntry['status'] }
      : {}),
    ...text('name'),
    ...text('title'),
    ...text('input'),
    ...text('output'),
    ...text('text'),
  };
}

/**
 * Appends transcript updates to a private file, one JSON line each, up to the
 * size limit. Writes run in order. A failed write stops the file, never the run.
 */
export class TranscriptWriter implements TranscriptSink {
  private readonly file: string;
  private bytes: number;
  private full: boolean;
  private writing: Promise<void> = Promise.resolve();

  private constructor(file: string, bytes: number, full: boolean) {
    this.file = file;
    this.bytes = bytes;
    this.full = full;
  }

  /** Continue the file, if it exists. A path that is not a regular file is never written. */
  static async open(file: string): Promise<TranscriptWriter> {
    try {
      const stats = await lstat(file);
      return new TranscriptWriter(
        file,
        stats.size,
        !stats.isFile() || stats.size >= transcriptLimit,
      );
    } catch {
      return new TranscriptWriter(file, 0, false);
    }
  }

  run(): (update: TranscriptUpdate) => void {
    const stamp = prefixer();
    return (update) => this.write(stamp(update));
  }

  /** Wait until every update is in the file. */
  async flushed(): Promise<void> {
    await this.writing;
  }

  private write(update: StampedUpdate): void {
    if (this.full) return;
    let line = `${JSON.stringify(update)}\n`;
    this.bytes += Buffer.byteLength(line);
    if (this.bytes > transcriptLimit) {
      this.full = true;
      line = `${JSON.stringify({ id: 'cut', at: update.at, parent: null, kind: 'note', text: cutNote })}\n`;
    }
    const file = this.file;
    this.writing = this.writing
      .then(() => appendFile(file, line, { mode: 0o600 }))
      .catch(() => {
        this.full = true;
      });
  }
}

export interface TranscriptPage {
  /** Changes when the server starts a new log, so the page starts again. */
  readonly epoch: string;
  readonly last: number;
  /** More entries wait. Ask again with `last`. */
  readonly more: boolean;
  readonly entries: readonly TranscriptEntry[];
}

function size(entry: TranscriptUpdate): number {
  return (
    (entry.input?.length ?? 0) +
    (entry.output?.length ?? 0) +
    (entry.text?.length ?? 0) +
    200
  );
}

/** A merged transcript in memory, for the desk. It holds at most the size limit. */
export class TranscriptLog implements TranscriptSink {
  readonly epoch = randomBytes(6).toString('hex');
  private readonly limit: number;
  private readonly entries = new Map<string, TranscriptEntry>();
  private seq = 0;
  private created = 0;
  private bytes = 0;
  private full = false;

  /** `limit` counts characters of text fields, with a fixed amount for each update. */
  constructor(limit = transcriptLimit) {
    this.limit = limit;
  }

  run(): (update: TranscriptUpdate) => void {
    const stamp = prefixer();
    return (update) => this.apply(stamp(update));
  }

  apply(update: StampedUpdate): void {
    if (this.full) return;
    this.bytes += size(update);
    if (this.bytes > this.limit) {
      this.full = true;
      update = {
        id: 'cut',
        at: update.at,
        parent: null,
        kind: 'note',
        text: cutNote,
      };
    }
    const previous = this.entries.get(update.id);
    const fields = Object.fromEntries(
      Object.entries(update).filter(([, value]) => value !== undefined),
    ) as Partial<TranscriptEntry>;
    const entry: TranscriptEntry = {
      // A tool result can arrive without its call, for example after the size limit.
      kind:
        update.output !== undefined || update.status !== undefined
          ? 'tool'
          : 'note',
      parent: null,
      ...previous,
      ...fields,
      at: previous?.at ?? update.at,
      id: update.id,
      seq: ++this.seq,
      order: previous?.order ?? ++this.created,
    };
    // A changed entry moves to the end, so a page in update order holds each entry once.
    this.entries.delete(update.id);
    this.entries.set(update.id, entry);
  }

  /** Entries changed after `after`, in update order, up to about `limit` characters. */
  page(epoch: string | null, after: number, limit = 1_000_000): TranscriptPage {
    const from = epoch === this.epoch ? after : 0;
    const entries: TranscriptEntry[] = [];
    let total = 0;
    let more = false;
    for (const entry of this.entries.values()) {
      if (entry.seq <= from) continue;
      if (entries.length && total > limit) {
        more = true;
        break;
      }
      total += size(entry);
      entries.push(entry);
    }
    return {
      epoch: this.epoch,
      last: more ? (entries.at(-1)?.seq ?? from) : Math.max(from, this.seq),
      more,
      entries,
    };
  }
}

/** Reads at most this much of a file for one page, so one request stays short. */
const readStep = 4 * 1024 * 1024;

/** Follows a transcript file as it grows. Each call reads only the new lines. */
export class TranscriptFile {
  // The file has its own limit, so the log only guards against a changed file.
  log = new TranscriptLog(transcriptLimit * 2);
  /** The file exists. A run from before Verifold saved transcripts has none. */
  found = false;
  private readonly path: string;
  private offset = 0;
  private partial = '';
  private decoder = new StringDecoder('utf8');
  private reading: Promise<void> | null = null;

  constructor(path: string) {
    this.path = path;
  }

  /** Read the new lines. Calls at the same time share one read. */
  refresh(): Promise<void> {
    this.reading ??= this.read().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async read(): Promise<void> {
    let stats;
    try {
      stats = await lstat(this.path);
    } catch {
      this.found = false;
      return;
    }
    this.found = stats.isFile();
    if (!this.found) return;
    if (stats.size < this.offset) {
      // The file was replaced. Start again.
      this.log = new TranscriptLog(transcriptLimit * 2);
      this.offset = 0;
      this.partial = '';
      this.decoder = new StringDecoder('utf8');
    }
    const end = Math.min(
      stats.size,
      this.offset + readStep,
      transcriptLimit + fieldLimit * 4,
    );
    if (end <= this.offset) return;
    const handle = await open(
      this.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const buffer = Buffer.alloc(end - this.offset);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        this.offset,
      );
      this.offset += bytesRead;
      const lines = (
        this.partial + this.decoder.write(buffer.subarray(0, bytesRead))
      ).split('\n');
      this.partial = lines.pop() ?? '';
      if (this.partial.length > transcriptLimit) this.partial = '';
      for (const line of lines) {
        const update = line.trim() ? parseLine(line) : null;
        if (update) this.log.apply(update);
      }
    } finally {
      await handle.close();
    }
  }
}
