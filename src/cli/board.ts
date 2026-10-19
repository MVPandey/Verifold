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
 * The lab's board: posts from the agents, the person, and Verifold. Each post
 * is one file under `.verifold/board/`, written once and never changed. The
 * store keeps an index in memory, read once at load, so readers do not read
 * the files again. The lab's queue runs every `add`, so the store has no lock
 * of its own. A harness can write in the project, so every file is parsed with
 * care and a bad one is skipped.
 */

export type PostKind =
  | 'plan'
  | 'claim'
  | 'evidence'
  | 'objection'
  | 'question'
  | 'rerun'
  | 'ruled-out'
  | 'status';

export type Artifact =
  | {
      /** A figure is a file with an image or PDF extension. */
      readonly type: 'file' | 'figure';
      readonly path: string;
      readonly commit: string;
      readonly sha256: string;
      readonly bytes: number;
    }
  | {
      readonly type: 'diff';
      readonly from: string;
      readonly to: string;
      readonly paths: readonly string[];
    }
  | { readonly type: 'run'; readonly run: string };

export interface Post {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly at: string;
  /** `person`, `verifold`, or an agent ID. The tool pipe sets it, never the post's text. */
  readonly author: string;
  /** The harness of an agent author. */
  readonly harness?: 'claude' | 'codex';
  readonly kind: PostKind;
  readonly direction?: string;
  readonly text: string;
  readonly replyTo?: string;
  /** Agent IDs, `person`, or `all`. */
  readonly mentions: readonly string[];
  readonly artifacts: readonly Artifact[];
  /** The harness call that made it, so a repeated call adds nothing. */
  readonly key?: string;
}

export type NewPost = Omit<Post, 'schemaVersion' | 'id' | 'at'>;

/** An agent that can get posts: its ID and the direction that it owns. */
export interface BoardAgent {
  readonly id: string;
  readonly direction: string | null;
}

export const boardLimits = {
  /** Posts in one run. A full board refuses new posts; none is deleted. */
  posts: 5000,
  /** Characters in an agent's or Verifold's post. */
  text: 280,
  /** Characters in a post from the person. */
  personText: 4000,
  /** Bytes in one post file. */
  file: 20_000,
  artifacts: 4,
  mentions: 5,
  /** Paths in one diff. */
  paths: 10,
  /** Lines in one digest. */
  digest: 30,
  /** Shown posts that an agent's read state keeps after its read mark. */
  seen: 500,
};

const kinds: readonly PostKind[] = [
  'plan',
  'claim',
  'evidence',
  'objection',
  'question',
  'rerun',
  'ruled-out',
  'status',
];
/** A post of these kinds states a result, so it must point to its proof. */
const proofKinds: ReadonlySet<PostKind> = new Set([
  'claim',
  'evidence',
  'rerun',
  'ruled-out',
]);
const postId = /^p-[1-9]\d{0,5}$/;
const postFile = /^p-[1-9]\d{0,5}\.json$/;
const agentId = /^a-[1-9]\d{0,3}$/;
const directionId = /^d-[1-9]\d{0,3}$/;
const commit = /^[0-9a-f]{40}$/;
const figure = /\.(png|jpe?g|gif|svg|webp|pdf)$/i;

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A relative path inside the project: no root, no `..` part, and one line. */
function safePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 300 &&
    !value.startsWith('/') &&
    !/[\p{Cc}\\]/u.test(value) &&
    !value.split('/').some((part) => part === '..' || part === '')
  );
}

function parseArtifact(value: unknown): Artifact | null {
  const entry = object(value);
  if (!entry) return null;
  if (
    (entry.type === 'file' || entry.type === 'figure') &&
    safePath(entry.path) &&
    (entry.type === 'file' || figure.test(entry.path)) &&
    typeof entry.commit === 'string' &&
    commit.test(entry.commit) &&
    typeof entry.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(entry.sha256) &&
    Number.isSafeInteger(entry.bytes) &&
    (entry.bytes as number) >= 0
  )
    return {
      type: entry.type,
      path: entry.path,
      commit: entry.commit,
      sha256: entry.sha256,
      bytes: entry.bytes as number,
    };
  if (
    entry.type === 'diff' &&
    typeof entry.from === 'string' &&
    commit.test(entry.from) &&
    typeof entry.to === 'string' &&
    commit.test(entry.to) &&
    Array.isArray(entry.paths) &&
    entry.paths.length > 0 &&
    entry.paths.length <= boardLimits.paths &&
    entry.paths.every(safePath)
  )
    return {
      type: 'diff',
      from: entry.from,
      to: entry.to,
      paths: entry.paths,
    };
  if (
    entry.type === 'run' &&
    typeof entry.run === 'string' &&
    /^r-[1-9]\d{0,5}$/.test(entry.run)
  )
    return { type: 'run', run: entry.run };
  return null;
}

/** The post, or why it is not valid. */
function check(entry: Record<string, unknown>): Post | string {
  const author = entry.author;
  if (
    typeof author !== 'string' ||
    !(author === 'person' || author === 'verifold' || agentId.test(author))
  )
    return 'The author is not valid.';
  const harness = entry.harness;
  if (harness !== undefined && harness !== 'claude' && harness !== 'codex')
    return 'The harness is not valid.';
  if (!kinds.includes(entry.kind as PostKind))
    return `Give a kind: ${kinds.join(', ')}.`;
  const kind = entry.kind as PostKind;
  const text = typeof entry.text === 'string' ? entry.text.trim() : '';
  const limit = author === 'person' ? boardLimits.personText : boardLimits.text;
  if (!text || text.length > limit)
    return `Write the post in 1 to ${limit} characters.`;
  const direction = entry.direction;
  if (
    direction !== undefined &&
    !(typeof direction === 'string' && directionId.test(direction))
  )
    return 'The direction is not valid.';
  const replyTo = entry.replyTo;
  if (
    replyTo !== undefined &&
    !(typeof replyTo === 'string' && postId.test(replyTo))
  )
    return 'The post that it replies to is not valid.';
  const mentions = entry.mentions ?? [];
  if (
    !Array.isArray(mentions) ||
    mentions.length > boardLimits.mentions ||
    new Set(mentions).size !== mentions.length ||
    !mentions.every(
      (name) =>
        name === 'person' ||
        name === 'all' ||
        (typeof name === 'string' && agentId.test(name)),
    )
  )
    return `Mention up to ${boardLimits.mentions} different agents, the person, or all.`;
  const list = entry.artifacts ?? [];
  if (!Array.isArray(list) || list.length > boardLimits.artifacts)
    return `Give up to ${boardLimits.artifacts} artifacts.`;
  const artifacts = list.map(parseArtifact);
  if (artifacts.some((artifact) => artifact === null))
    return 'An artifact is not valid.';
  if (proofKinds.has(kind) && author !== 'person' && !artifacts.length)
    return `A ${kind} post needs its proof: a file, a figure, a diff, or a run.`;
  const key = entry.key;
  if (
    key !== undefined &&
    !(typeof key === 'string' && key.length > 0 && key.length <= 300)
  )
    return 'The key is not valid.';
  if (
    typeof entry.id !== 'string' ||
    !postId.test(entry.id) ||
    typeof entry.at !== 'string' ||
    Number.isNaN(Date.parse(entry.at))
  )
    return 'The post ID or time is not valid.';
  return {
    schemaVersion: 1,
    id: entry.id,
    at: entry.at,
    author,
    ...(harness ? { harness } : {}),
    kind,
    ...(direction ? { direction } : {}),
    text,
    ...(replyTo ? { replyTo } : {}),
    mentions: mentions as string[],
    artifacts: artifacts as Artifact[],
    ...(key ? { key } : {}),
  };
}

function number(id: string): number {
  return Number(id.slice(2));
}

/** A short form of a commit for a digest line. */
function short(value: string): string {
  return value.slice(0, 7);
}

function artifactText(artifact: Artifact): string {
  switch (artifact.type) {
    case 'file':
    case 'figure':
      return `${artifact.type} ${artifact.path} at ${short(artifact.commit)}`;
    case 'diff':
      return `diff ${short(artifact.from)}..${short(artifact.to)} (${artifact.paths.join(', ')})`;
    case 'run':
      return `run ${artifact.run}`;
  }
}

/**
 * One digest line for a post. The post's text is JSON-quoted, so a line break
 * or a quote in it cannot look like a line from Verifold.
 */
export function postLine(
  post: Post,
  name: (author: string) => string = (author) => author,
): string {
  return `- ${post.id} [${post.kind}] from ${name(post.author)}${post.direction ? ` in ${post.direction}` : ''}${post.replyTo ? `, reply to ${post.replyTo}` : ''}: ${JSON.stringify(post.text)}${post.artifacts.length ? ` Proof: ${post.artifacts.map(artifactText).join('; ')}.` : ''}`;
}

export class Board {
  private readonly directory: string;
  private posts: Post[] = [];
  /** The highest post number in the folder at load, valid or not, so a new post never replaces a file. */
  private last = 0;

  constructor(root: string) {
    this.directory = join(root, '.verifold', 'board');
  }

  /** Read the posts once. An unreadable, oversized, or invalid file is skipped. */
  async load(): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.directory)).filter((name) =>
        postFile.test(name),
      );
    } catch {
      names = [];
    }
    const numbers = names
      .map((name) => Number(name.slice(2, -5)))
      .sort((a, b) => a - b);
    const posts: Post[] = [];
    for (const value of numbers.slice(0, boardLimits.posts)) {
      try {
        const path = join(this.directory, `p-${value}.json`);
        const stats = await lstat(path);
        if (!stats.isFile() || stats.size > boardLimits.file) continue;
        const entry = object(JSON.parse(await readFile(path, 'utf8')));
        const post = entry && entry.schemaVersion === 1 ? check(entry) : null;
        if (post && typeof post !== 'string' && post.id === `p-${value}`)
          posts.push(post);
      } catch {
        /* Skip an unreadable post. */
      }
    }
    this.posts = posts;
    this.last = numbers.at(-1) ?? 0;
  }

  /** All posts, oldest first. */
  list(): readonly Post[] {
    return this.posts;
  }

  get(id: string): Post | undefined {
    return this.posts.find((post) => post.id === id);
  }

  /** The number of the newest post, or 0. A new agent's read cursor starts here. */
  latest(): number {
    const post = this.posts.at(-1);
    return post ? number(post.id) : 0;
  }

  /**
   * Add a post. A post with the same key exists already: return it, and add
   * nothing. A post that it replies to must exist. Throws with a reason that
   * the author can read.
   */
  async add(fields: NewPost): Promise<Post> {
    const known = fields.key
      ? this.posts.find((post) => post.key === fields.key)
      : undefined;
    if (known) return known;
    if (this.posts.length >= boardLimits.posts)
      throw new Error(
        `The board holds ${boardLimits.posts} posts, the limit. No post is deleted.`,
      );
    const post = check({
      ...fields,
      schemaVersion: 1,
      id: `p-${this.last + 1}`,
      at: new Date().toISOString(),
    });
    if (typeof post === 'string') throw new Error(post);
    if (post.replyTo && !this.get(post.replyTo))
      throw new Error(`No post ${post.replyTo} is on the board.`);
    const body = `${JSON.stringify(post, null, 2)}\n`;
    if (Buffer.byteLength(body) > boardLimits.file)
      throw new Error('The post is too large. Make it shorter.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(
      this.directory,
      `.p.${randomBytes(4).toString('hex')}.tmp`,
    );
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(body);
      } finally {
        await file.close();
      }
      await rename(temporary, join(this.directory, `${post.id}.json`));
    } finally {
      await rm(temporary, { force: true });
    }
    this.last += 1;
    this.posts.push(post);
    return post;
  }

  /**
   * Whether a post wakes an agent. It does when it replies to the agent's
   * post, mentions the agent, objects in the agent's direction, or comes from
   * the person in the agent's direction. A post from the person to nobody in
   * particular wakes every agent. Any other post waits for the agent's next
   * digest.
   */
  wakes(post: Post, agent: BoardAgent): boolean {
    if (post.author === agent.id) return false;
    if (post.replyTo && this.get(post.replyTo)?.author === agent.id)
      return true;
    if (
      post.mentions.includes(agent.id) ||
      (post.author === 'person' && post.mentions.includes('all'))
    )
      return true;
    const inDirection =
      agent.direction !== null && post.direction === agent.direction;
    if (post.kind === 'objection' && inDirection) return true;
    if (post.author !== 'person') return false;
    return (
      inDirection || (!post.direction && !post.replyTo && !post.mentions.length)
    );
  }

  /** The agents that a post wakes. */
  targets(post: Post, agents: readonly BoardAgent[]): string[] {
    return agents
      .filter((agent) => this.wakes(post, agent))
      .map((agent) => agent.id);
  }

  /**
   * The digest of an agent's unread posts, and the agent's read state after
   * it. Unread posts are the posts after `readThrough` that others wrote and
   * that are not in `seen`. The `include` posts come first, even when read: for
   * example the posts of events that come once more. Then come the posts that
   * wake the agent, then the others in order, in at most `limit` lines. A post
   * that does not fit stays unread: `readThrough` stops before it, and `seen`
   * keeps the shown posts after that point.
   */
  digest(
    agent: BoardAgent,
    read: { readonly readThrough: number; readonly seen?: readonly string[] },
    options: {
      readonly include?: readonly string[];
      readonly limit?: number;
      readonly name?: (author: string) => string;
    } = {},
  ): {
    readonly lines: string[];
    readonly readThrough: number;
    readonly seen: string[];
  } {
    const seen = new Set(read.seen ?? []);
    const unread = this.posts.filter(
      (post) =>
        number(post.id) > read.readThrough &&
        post.author !== agent.id &&
        !seen.has(post.id),
    );
    const listed = new Set(unread.map((post) => post.id));
    const again: Post[] = [];
    for (const id of options.include ?? []) {
      const post = this.get(id);
      if (post && post.author !== agent.id && !listed.has(id)) {
        again.push(post);
        listed.add(id);
      }
    }
    const ordered = [
      ...again,
      ...unread.filter((post) => this.wakes(post, agent)),
      ...unread.filter((post) => !this.wakes(post, agent)),
    ];
    const limit = options.limit ?? boardLimits.digest;
    // When the posts do not fit, the last line says how many more wait. It never takes the only line.
    const shown =
      ordered.length <= limit
        ? ordered
        : ordered.slice(0, Math.max(1, limit - 1));
    const shownIds = new Set(shown.map((post) => post.id));
    const hidden = unread.filter((post) => !shownIds.has(post.id));
    const through = hidden[0]
      ? Math.max(read.readThrough, number(hidden[0].id) - 1)
      : Math.max(read.readThrough, this.latest());
    return {
      lines: [
        ...shown.map((post) => postLine(post, options.name)),
        ...(hidden.length
          ? [
              `- ${hidden.length} more unread posts. Read them with verifold_board.`,
            ]
          : []),
      ],
      readThrough: through,
      seen: [...new Set([...seen, ...shownIds])]
        .filter((id) => number(id) > through)
        .slice(-boardLimits.seen),
    };
  }
}
