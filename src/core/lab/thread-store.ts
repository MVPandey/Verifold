/**
 * The lab's threads, in `.verifold/lab/threads.json`. Threads change, so they
 * stay apart from the write-once post files. The store keeps them in memory,
 * read once at load, and applies the pure rules of threads.ts, post-rules.ts,
 * and thread-digest.ts to them. The lab's queue runs every change, so the
 * store has no lock of its own. A harness can write in the project, so the
 * file is parsed with care and a bad record is skipped.
 */
import {
  boardLimits,
  clip,
  number,
  type Board,
  type BoardAgent,
  type Digest,
  type DigestOptions,
  type NewPost,
  type Post,
  type ReadState,
} from '../board.ts';
import { threadLimits } from '../lab-tools.ts';
import {
  shapePost,
  wakeList,
  type PostContext,
  type PostShape,
} from './post-rules.ts';
import { readObject, RecordFile } from './record-file.ts';
import { fail, type Thread } from './schema.ts';
import { threadDigest, threadLines } from './thread-digest.ts';
import {
  afterPost,
  agreedWith,
  decided,
  dueProposals,
  followed,
  parseThread,
  placed,
  planThread,
  planThreadRecord,
} from './threads.ts';

export class ThreadStore {
  private threads: readonly Thread[] = [];
  /** The highest thread number that a record or a post uses, so no new thread takes the number of a lost record. */
  private last = 0;
  private readonly path: string;
  private readonly file: RecordFile;
  private readonly board: Pick<Board, 'digest' | 'get' | 'list'>;
  /** Milliseconds that a proposal stays open to objections. */
  private readonly objectionMs: number;

  /** `paused`: the lab's records moved, so nothing writes until the next load. */
  constructor(
    path: string,
    paused: () => boolean,
    board: Pick<Board, 'digest' | 'get' | 'list'>,
    objectionMs: number,
  ) {
    this.path = path;
    this.board = board;
    this.objectionMs = objectionMs;
    this.file = new RecordFile(path, () =>
      paused() ? null : { schemaVersion: 1, threads: this.threads },
    );
  }

  /**
   * Read the records, after the board. `started`: when a lab with threads
   * started, so it gets its plan thread if the file has none. Null: a lab from
   * before threads, or no lab, which holds no thread.
   */
  async load(started: string | null): Promise<void> {
    const saved = started === null ? null : await readObject(this.path);
    const list = Array.isArray(saved?.threads) ? saved.threads : [];
    const threads = list
      .slice(0, threadLimits.threads)
      .flatMap((entry) => parseThread(entry) ?? []);
    this.threads = threads;
    if (started !== null && !this.get(planThread))
      this.threads = [planThreadRecord(started), ...threads];
    this.last = Math.max(
      ...this.threads.map((thread) => number(thread.id)),
      ...this.board.list().map((post) => number(post.thread ?? 't-0')),
      0,
    );
  }

  /**
   * Verifold's note when posts name threads that have no record, as after a
   * file that it could not read: the lab must not look as if it had no threads.
   * Null when each thread has its record. Its key keeps it to one note.
   */
  lostNote(): NewPost | null {
    const lost = [
      ...new Set(this.board.list().flatMap((post) => post.thread ?? [])),
    ].filter((id) => !this.get(id));
    return lost.length
      ? {
          author: 'verifold',
          kind: 'status',
          text: clip(
            `Verifold could not read the records of ${lost.length} threads, so they have no title, state, or followers now. Their posts stay on the board: ${lost.join(', ')}`,
            boardLimits.text,
          ),
          mentions: [],
          artifacts: [],
          key: `threads-lost-${lost.length}`,
        }
      : null;
  }

  /** All threads, oldest first. */
  list(): readonly Thread[] {
    return this.threads;
  }

  get(id: unknown): Thread | undefined {
    return this.threads.find((thread) => thread.id === id);
  }

  /** The newest threads that are not closed, one line each. */
  lines(limit = 20): readonly string[] {
    return threadLines(
      this.threads.filter((thread) => thread.state !== 'closed').slice(-limit),
    );
  }

  /** The posts of a thread, oldest first. */
  posts(thread: Thread): readonly Post[] {
    return this.board.list().filter((post) => post.thread === thread.id);
  }

  /** Check a post of an agent. Throws a refusal that says what to change. */
  shape(
    args: Record<string, unknown>,
    context: Omit<PostContext, 'post' | 'threads'>,
  ): PostShape {
    return shapePost(args, {
      ...context,
      post: (id) => this.board.get(id),
      threads: this.threads,
    });
  }

  /** The post with its thread: see `placed`. */
  place(fields: NewPost): NewPost {
    return placed(
      fields,
      fields.replyTo ? this.board.get(fields.replyTo) : undefined,
    );
  }

  /** An agent's digest: see `threadDigest`. */
  digest(
    agent: BoardAgent,
    read: ReadState,
    options: DigestOptions = {},
  ): Digest {
    return threadDigest(
      this.board,
      this.threads,
      agent,
      read,
      this.objectionMs,
      options,
    );
  }

  /** Open a thread. Refuses when the lab holds the most threads. */
  private async open(
    fields: Pick<Thread, 'title' | 'why' | 'openedBy' | 'at' | 'direction'>,
  ): Promise<Thread> {
    if (this.threads.length >= threadLimits.threads)
      fail(
        `The lab holds ${threadLimits.threads} threads, the limit. Post in an open thread.`,
      );
    this.last += 1;
    const thread: Thread = {
      ...fields,
      id: `t-${this.last}`,
      state: 'open',
      followers: [],
      agreed: [],
    };
    this.threads = [...this.threads, thread];
    await this.file.save();
    return thread;
  }

  /** The thread fields of a post of `by`. A thread that `shape` opens opens now, once the post can land. */
  async fields(
    shape: PostShape,
    by: string,
    direction: string,
  ): Promise<Pick<Post, 'thread' | 'outcome' | 'accepts'>> {
    const { thread, ...rest } = shape;
    return {
      ...rest,
      thread:
        typeof thread === 'string'
          ? thread
          : (
              await this.open({
                ...thread,
                direction,
                openedBy: by,
                at: new Date().toISOString(),
              })
            ).id,
    };
  }

  /** Change one thread and save it. The change is in memory when the save fails: the next save writes it. */
  private async change(
    id: string,
    next: (thread: Thread) => Thread,
  ): Promise<Thread | undefined> {
    const thread = this.get(id);
    if (!thread) return undefined;
    const changed = next(thread);
    if (changed === thread) return thread;
    this.threads = this.threads.map((entry) =>
      entry === thread ? changed : entry,
    );
    await this.file.save();
    return changed;
  }

  /**
   * A post landed: its thread changes, and the rules of its kind say who
   * wakes. Returns those agent IDs. A failed save comes again with the next one.
   */
  async posted(
    post: Post,
    agents: readonly BoardAgent[],
  ): Promise<readonly string[]> {
    const target = post.replyTo ? this.board.get(post.replyTo) : undefined;
    if (post.thread)
      await this.change(post.thread, (thread) =>
        afterPost(thread, post, target),
      ).catch(() => {});
    const thread = post.thread ? this.get(post.thread) : undefined;
    const woken = wakeList(post, { target, thread, agents });
    // Whoever the person's words wake reads them, also from outside the thread.
    if (post.author === 'person' && thread && thread.id !== planThread)
      await this.change(thread.id, (entry) =>
        woken.reduce(followed, entry),
      ).catch(() => {});
    return woken;
  }

  /** `verifold_follow`. Returns the reply to the agent. */
  async follow(agent: string, thread: unknown): Promise<string> {
    const { id } = this.get(thread) ?? fail('Name a thread, such as t-3.');
    await this.change(id, (entry) => followed(entry, agent));
    return `You follow ${id}.`;
  }

  /** `verifold_agree`: a reaction on the post's thread. Returns the reply to the agent. */
  async agree(by: string, id: unknown): Promise<string> {
    const post =
      (typeof id === 'string' ? this.board.get(id) : undefined) ??
      fail('Name a post on the board, such as p-12.');
    if (post.author === by) fail('Agree with the post of another author.');
    if (!post.thread)
      fail(`${post.id} has no thread, so it takes no reaction.`);
    const at = new Date().toISOString();
    await this.change(post.thread, (thread) =>
      agreedWith(thread, post.id, by, at),
    );
    return `You agree with ${post.id}.`;
  }

  /**
   * Each proposal whose objection window ended becomes the decision of its
   * thread. Returns Verifold's notes for the board: followers read them in
   * their next turn.
   */
  async decide(): Promise<readonly NewPost[]> {
    const now = Date.now();
    const notes: NewPost[] = [];
    for (const { thread, proposal } of dueProposals(
      this.board.list(),
      this.threads,
      now,
      this.objectionMs,
    )) {
      await this.change(thread.id, (entry) =>
        decided(entry, proposal, new Date(now).toISOString()),
      ).catch(() => {});
      notes.push({
        author: 'verifold',
        kind: 'status',
        thread: thread.id,
        replyTo: proposal.id,
        text: `No objection came, so ${proposal.id} is now the decision of ${thread.id}.`,
        mentions: [],
        artifacts: [],
      });
    }
    return notes;
  }

  /** Wait until the newest records are on disk. */
  flush(): Promise<void> {
    return this.file.flush();
  }
}
