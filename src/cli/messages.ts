import { randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Messages between the person, the coordinator, and task workers. Each one is
 * a file under `.verifold/messages/`. After the first write, only its delivery
 * and status change. A message is information for its recipient. It cannot
 * change a task's scope, permissions, or limits. The task manager makes every
 * change in its own queue, so this store has no lock of its own.
 */

export type MessageKind =
  | 'note'
  | 'blocker'
  | 'objection'
  | 'withdrawal'
  | 'decision';

/**
 * How far a message got. A task worker gets its messages with its next turn:
 * `sent` with the turn, then `delivered` when that turn ends normally, or
 * `uncertain` when it fails or the process stops first. Verifold never resends
 * an uncertain message by itself. `board`: the desk shows it to the person.
 */
export type Delivery = 'queued' | 'sent' | 'delivered' | 'uncertain' | 'board';

export interface Message {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly at: string;
  /** `person`, `coordinator`, or a task ID. */
  readonly from: string;
  /** For a worker: the attempt that sent it. The harness pipe identifies it, never the message text. */
  readonly sender?: {
    readonly claim: string;
    readonly attempt: number;
    readonly revision: number;
  };
  /** `person`, `coordinator`, or a task ID. */
  readonly to: string;
  /** The recipient task's revision when the message was sent. */
  readonly revision?: number;
  readonly kind: MessageKind;
  readonly text: string;
  /** An objection: the artifact version it is about, and its evidence. */
  readonly about?: { readonly task: string; readonly version: number };
  readonly evidence?: readonly string[];
  /** A withdrawal or decision: the objection or blocker that it closes. */
  readonly closes?: string;
  /** Blockers and objections stay open until a decision or a withdrawal closes them. */
  readonly status?: 'open' | 'withdrawn' | 'upheld' | 'overruled' | 'resolved';
  readonly delivery: Delivery;
  readonly deliveredAt?: string;
  /** The harness call that made it, so a repeated call adds nothing. */
  readonly key?: string;
}

export const messageLimits = {
  /** Messages in one project. A full project refuses new messages; none is deleted. */
  project: 2000,
  /** Messages that one task attempt can send. */
  attempt: 50,
  text: 4000,
  evidence: 10,
  evidenceText: 500,
};

const kinds: readonly MessageKind[] = [
  'note',
  'blocker',
  'objection',
  'withdrawal',
  'decision',
];
const deliveries: readonly Delivery[] = [
  'queued',
  'sent',
  'delivered',
  'uncertain',
  'board',
];

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseMessage(value: unknown): Message | null {
  const entry = object(value);
  return entry &&
    entry.schemaVersion === 1 &&
    typeof entry.id === 'string' &&
    /^m-[1-9]\d{0,5}$/.test(entry.id) &&
    typeof entry.at === 'string' &&
    typeof entry.from === 'string' &&
    typeof entry.to === 'string' &&
    typeof entry.text === 'string' &&
    kinds.includes(entry.kind as MessageKind) &&
    deliveries.includes(entry.delivery as Delivery)
    ? (entry as unknown as Message)
    : null;
}

export class Messages {
  private readonly directory: string;

  constructor(root: string) {
    this.directory = join(root, '.verifold', 'messages');
  }

  /** All messages, oldest first. An unreadable file is skipped. */
  async list(): Promise<Message[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return [];
    }
    const messages: Message[] = [];
    for (const name of names
      .filter((entry) => /^m-[1-9]\d{0,5}\.json$/.test(entry))
      .map((entry) => Number(entry.slice(2, -5)))
      .sort((a, b) => a - b)
      .slice(0, messageLimits.project)) {
      try {
        const path = join(this.directory, `m-${name}.json`);
        const stats = await lstat(path);
        if (!stats.isFile() || stats.size > 100_000) continue;
        const message = parseMessage(JSON.parse(await readFile(path, 'utf8')));
        if (message?.id === `m-${name}`) messages.push(message);
      } catch {
        /* Skip an unreadable message. */
      }
    }
    return messages;
  }

  /** Add a message. A message with the same key exists already: return it, and add nothing. */
  async add(
    fields: Omit<Message, 'schemaVersion' | 'id' | 'at'>,
    all: readonly Message[],
  ): Promise<Message> {
    const known = fields.key
      ? all.find((entry) => entry.key === fields.key)
      : undefined;
    if (known) return known;
    if (all.length >= messageLimits.project)
      throw new Error(
        `This project holds ${messageLimits.project} messages, the limit. No message is deleted.`,
      );
    const number =
      Math.max(0, ...all.map((entry) => Number(entry.id.slice(2)))) + 1;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const message: Message = {
      schemaVersion: 1,
      id: `m-${number}`,
      at: new Date().toISOString(),
      ...fields,
    };
    await this.write(message);
    return message;
  }

  /** Change the delivery or the status of a message. */
  async update(
    message: Message,
    change: Partial<Pick<Message, 'delivery' | 'deliveredAt' | 'status'>>,
  ): Promise<Message> {
    const next = { ...message, ...change };
    await this.write(next);
    return next;
  }

  private async write(message: Message): Promise<void> {
    const temporary = join(
      this.directory,
      `.m.${randomBytes(4).toString('hex')}.tmp`,
    );
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(message, null, 2)}\n`);
      } finally {
        await file.close();
      }
      await rename(temporary, join(this.directory, `${message.id}.json`));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
