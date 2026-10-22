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
import {
  parseMessage,
  type Delivery,
  type Message,
  type MessageKind,
} from '../core/team-records.ts';

export type { Delivery, Message, MessageKind };

/**
 * Messages between the person, the coordinator, research, and task workers.
 * Each one is a file under `.verifold/messages/`. After the first write, only
 * its delivery, status, and answer change. A message is information for its
 * recipient. It cannot change a task's scope, permissions, or limits. The task
 * manager makes every change in its own queue, so this store has no lock of
 * its own.
 */

export const messageLimits = {
  /** Messages in one project. A full project refuses new messages; none is deleted. */
  project: 2000,
  /** Messages that one task attempt can send. */
  attempt: 50,
  text: 4000,
  evidence: 10,
  evidenceText: 500,
};

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

  /** Change the delivery, the status, or the answer of a message. */
  async update(
    message: Message,
    change: Partial<
      Pick<Message, 'delivery' | 'deliveredAt' | 'status' | 'via' | 'answer'>
    >,
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
