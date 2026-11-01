/**
 * The lab's threads, in `.verifold/lab/threads.json`. Threads change, so they
 * stay apart from the write-once post files. The store keeps them in memory,
 * read once at load, and applies the pure rules of threads.ts, post-rules.ts,
 * and thread-digest.ts to them. The lab's queue runs every change, so the
 * store has no lock of its own. A harness can write in the project, so the
 * file is parsed with care and a bad record is skipped.
 */
import {
  threadId,
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
import { threadDigest, threadLine } from './thread-digest.ts';
import {
  afterPost,
  agreedWith,
  decided,
  dueProposals,
  followed,
  overturned,
  parseThread,
  placed,
  planThreadRecord,
} from './threads.ts';

export class ThreadStore {
  private threads: readonly Thread[] = [];
  /** The highest thread number ever used, so a skipped record never gives its number to a new thread. */
  private last = 0;
  private readonly path: string;
  private readonly file: RecordFile;
  private readonly board: Pick<Board, 'digest' | 'get' | 'list'>;

  /** `paused`: the lab's records moved, so nothing writes until the next load. */
  constructor(
    path: string,
    paused: () => boolean,
    board: Pick<Board, 'digest' | 'get' | 'list'>,
  ) {
    this.path = path;
    this.board = board;
    this.file = new RecordFile(path, () =>
      paused()
        ? null
        : { schemaVersion: 1, last: this.last, threads: this.threads },
    );
  }

  /**
   * Read the records. `started`: when a lab with threads started, so it gets
   * its plan thread if the file has none. Null: a lab from before threads, or
   * no lab, which holds no thread.
   */
  async load(started: string | null): Promise<void> {
    const saved = started === null ? null : await readObject(this.path);
    const list = Array.isArray(saved?.threads) ? saved.threads : [];
    const threads = list
      .slice(0, threadLimits.threads)
      .flatMap((entry) => parseThread(entry) ?? []);
    const numbers = threads.map((thread) => Number(thread.id.slice(2)));
    const last = saved?.last;
    this.last = Math.max(
      typeof last === 'number' && threadId.test(`t-${last}`) ? last : 0,
      ...numbers,
    );
    this.threads = threads;
    if (started !== null && !numbers.includes(1)) {
      this.threads = [planThreadRecord(started), ...threads];
      this.last = Math.max(this.last, 1);
    }
  }

  /** All threads, oldest first. */
  list(): readonly Thread[] {
    return this.threads;
  }

  get(id: unknown): Thread | undefined {
    return this.threads.find((thread) => thread.id === id);
  }

  /** The newest threads that are not closed, one line each. */
  lines(limit = 20): string[] {
    return this.threads
      .filter((thread) => thread.state !== 'closed')
      .slice(-limit)
      .map(threadLine);
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
    return threadDigest(this.board, this.threads, agent, read, options);
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
    return wakeList(post, { target, thread, agents });
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

  /** The person overturns a thread's decision. Returns the thread's ID. Refuses a thread with no decision. */
  async overturn(id: unknown): Promise<string> {
    const thread = this.get(id) ?? fail('Name a thread, such as t-3.');
    await this.change(thread.id, overturned);
    return thread.id;
  }

  /**
   * Each proposal whose objection window of `windowMs` ended becomes the
   * decision of its thread. Returns Verifold's notes for the board: followers
   * read them in their next turn.
   */
  async decide(windowMs: number): Promise<readonly NewPost[]> {
    const now = Date.now();
    const notes: NewPost[] = [];
    for (const { thread, proposal } of dueProposals(
      this.board.list(),
      this.threads,
      now,
      windowMs,
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
