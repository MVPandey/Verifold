/**
 * What each kind of post needs and does in a lab with threads: pure rules,
 * with no lab. `shapePost` checks a post before Verifold commits its proof,
 * and a refusal says exactly what to change. `wakeList` says who a post wakes.
 * `openObjections` says which objections still stand. Together they replace a
 * switch on kinds in the lab.
 */
import {
  object,
  parsePrior,
  type BoardAgent,
  type Post,
  type PostKind,
} from '../board.ts';
import {
  checkableKinds,
  checkLimits,
  postMethods,
  postOutcomes,
  threadLimits,
} from '../lab-tools.ts';
import { runActive, type RunRecord } from '../runs.ts';
import { personReaders } from './reach.ts';
import { fail, text, type Check, type Thread } from './schema.ts';
import { checkTitle, reopeningKinds } from './threads.ts';

/** What the rules read of the lab. */
export interface PostContext {
  readonly author: string;
  readonly kind: PostKind;
  /** The IDs of the post's mentions. */
  readonly mentions: readonly string[];
  /** Proof items of the post. */
  readonly proof: number;
  readonly post: (id: string) => Post | undefined;
  readonly threads: readonly Thread[];
  /** The agent IDs that work now, so a post can reach them. */
  readonly working: readonly string[];
  readonly name: (author: string) => string;
}

/** A post's place and its fields beyond the text. */
export interface PostShape
  extends Pick<Post, 'outcome' | 'accepts' | 'method' | 'raters' | 'prior'> {
  /** An existing thread, or the title and the why of a new one. */
  readonly thread: string | { readonly title: string; readonly why: string };
}

interface Draft extends PostContext {
  readonly target: Post | undefined;
  readonly outcome: Post['outcome'];
  readonly accepts: boolean;
}

/** The post that the draft replies to. Refuses a draft with no `replyTo`. */
function target(draft: Draft, what: string): Post {
  return draft.target ?? fail(`${what} Give replyTo.`);
}

function proof(draft: Draft, what: string): void {
  if (!draft.proof)
    fail(
      `${what} needs proof: give a file, a figure, a diff, or a run in artifacts. For progress with no proof, use verifold_status.`,
    );
}

/** A post that an answer can reply to: an ask, an objection, or the person's own message. */
function answerable(post: Post): boolean {
  return (
    post.kind === 'ask' ||
    post.kind === 'objection' ||
    (post.kind === 'question' && post.author === 'person')
  );
}

const rules: Readonly<Partial<Record<PostKind, (draft: Draft) => void>>> = {
  result: (draft) => proof(draft, 'A result'),
  check: (draft) => {
    if (
      target(draft, 'A check names the post that it tests.').author ===
      draft.author
    )
      fail(
        'A check tests the work of another author. Post your own new work as a result.',
      );
    proof(draft, 'A check');
    if (!draft.outcome) fail('A check gives an outcome: holds or fails.');
  },
  ask: (draft) => {
    const [named, ...rest] = draft.mentions;
    if (!named || rest.length)
      fail(
        'An ask names one agent or the person. Give exactly one name in mentions.',
      );
    if (named !== 'person' && !draft.working.includes(named))
      fail(
        `${draft.name(named)} does not work now. Ask an agent that works, or the person.`,
      );
  },
  answer: (draft) => {
    const replied = target(
      draft,
      'An answer replies to an ask, an objection, or a message from the person.',
    );
    if (!answerable(replied))
      fail(
        `${replied.id} is a ${replied.kind} post, so no answer replies to it. Use verifold_agree to agree, or post an objection to disagree.`,
      );
    if (!draft.accepts) return;
    if (replied.kind !== 'objection')
      fail('Only an answer to an objection gives accepts.');
    const aimed = replied.replyTo ? draft.post(replied.replyTo) : undefined;
    if (draft.author !== aimed?.author && draft.author !== replied.author)
      fail(
        `Only the author of ${aimed?.id ?? 'the post'} or of ${replied.id} accepts the objection. Leave accepts out.`,
      );
  },
  objection: (draft) => {
    target(draft, 'An objection names the post that it targets.');
  },
  'ruled-out': (draft) => proof(draft, 'A ruled-out post'),
};

const oneLine = (value: string): string => value.replace(/\s+/g, ' ');

/**
 * Where the post goes: its target's thread, a named thread, or a new one. A
 * reply always has a legal form: it stays in its target's thread, and it opens
 * a new thread when that thread's record is gone. Only a kind that needs its
 * reply goes into a closed thread.
 */
function place(
  args: Record<string, unknown>,
  replied: Post | undefined,
  context: PostContext,
): PostShape['thread'] {
  const named = args.thread;
  const home = replied?.thread;
  const record = context.threads.find((entry) => entry.id === home);
  if (replied && record) {
    if (args.title !== undefined || (named && named !== home))
      fail(
        `A reply stays in its target's thread. ${replied.id} is in ${record.id}. Leave title out, and give thread ${record.id} or none.`,
      );
    if (record.state === 'closed' && !reopeningKinds.has(context.kind))
      fail(
        `${record.id} is closed. Leave replyTo out, open a new thread with title and why, and name ${replied.id} in the text.`,
      );
    return record.id;
  }
  if (named !== undefined) {
    const thread =
      context.threads.find((entry) => entry.id === named) ??
      fail(
        `No thread ${typeof named === 'string' ? named.slice(0, 20) : ''} is in the lab. verifold_board with view threads lists them.`,
      );
    if (thread.state === 'closed')
      fail(
        `${thread.id} is closed. Open a new thread with title and why, and cite the post that you build on.`,
      );
    return thread.id;
  }
  if (args.title === undefined)
    fail(
      home
        ? `${home} has no record now. Give title and why to open a new thread for this reply.`
        : 'Give thread to post in a thread, or title and why to open one. verifold_board with view threads lists them.',
    );
  const title = oneLine(
    text(args.title, threadLimits.title, 'the title of the thread'),
  );
  checkTitle(title, context.threads);
  return {
    title,
    why: oneLine(
      text(args.why, threadLimits.why, 'one line on why it matters'),
    ),
  };
}

/** How a check post says that it checked. Refuses a shape that the record cannot use. */
function methodOf(
  args: Record<string, unknown>,
  kind: PostKind,
): Pick<Post, 'method' | 'raters'> {
  if (args.method === undefined && args.raters === undefined) return {};
  if (kind !== 'check') fail('Only a check gives a method or raters.');
  const method =
    postMethods.find((entry) => entry === args.method) ??
    fail(`A method is one of: ${postMethods.join(', ')}.`);
  if (
    method === 'rerun' &&
    !(Array.isArray(args.artifacts) ? args.artifacts : []).some(
      (item) => object(item)?.type === 'run',
    )
  )
    fail('A rerun cites its run as proof: {type: run, run: r-N}.');
  if (method !== 'ratings') {
    if (args.raters !== undefined) fail('Only ratings give raters.');
    return { method };
  }
  const { raters } = args;
  if (
    !Number.isSafeInteger(raters) ||
    (raters as number) < 1 ||
    (raters as number) > threadLimits.raters
  )
    fail(
      `Give raters: the AI ratings of each answer, from 1 to ${threadLimits.raters}.`,
    );
  return { method, raters: raters as number };
}

/** What a post says of earlier work. Refuses it on a kind that has none. */
function priorOf(
  args: Record<string, unknown>,
  kind: PostKind,
): Pick<Post, 'prior'> {
  if (args.prior === undefined) return {};
  if (kind !== 'proposal' && kind !== 'ruled-out')
    fail('Only a proposal or a ruled-out post gives prior.');
  const prior = parsePrior(args.prior);
  return prior ? { prior } : {};
}

/** Check a post of an agent. Throws a refusal that says what to change. */
export function shapePost(
  args: Record<string, unknown>,
  context: PostContext,
): PostShape {
  const replied =
    typeof args.replyTo === 'string'
      ? (context.post(args.replyTo) ??
        fail(`No post ${args.replyTo.slice(0, 20)} is on the board.`))
      : undefined;
  const outcome =
    args.outcome === undefined
      ? undefined
      : (postOutcomes.find((entry) => entry === args.outcome) ??
        fail('An outcome is holds or fails.'));
  if (outcome && context.kind !== 'check')
    fail('Only a check gives an outcome.');
  const accepts = args.accepts === true;
  if (accepts && context.kind !== 'answer')
    fail('Only an answer to an objection gives accepts.');
  rules[context.kind]?.({ ...context, target: replied, outcome, accepts });
  return {
    thread: place(args, replied, context),
    ...methodOf(args, context.kind),
    ...priorOf(args, context.kind),
    ...(outcome ? { outcome } : {}),
    ...(accepts ? { accepts: true } : {}),
  };
}

/** What wakes whom, once a post is on the board. */
export interface WakeContext {
  readonly target: Post | undefined;
  readonly thread: Thread | undefined;
  /** The agents that work now. */
  readonly agents: readonly BoardAgent[];
}

/**
 * The agent IDs that a post wakes. An objection wakes the author of its
 * target, or the owner of its direction when a checker wrote the target. An
 * ask wakes who it names. An answer wakes who wrote what it answers. The
 * person's words wake who `personReaders` says, the same rule as the reach line
 * under the box. A plan, a rerun, and Verifold's own notes wake who they
 * mention. Other posts wait for each agent's next turn.
 */
export function wakeList(post: Post, context: WakeContext): readonly string[] {
  const { agents, target } = context;
  if (post.author === 'person') return personReaders(post, context);
  const works = new Set(agents.map((agent) => agent.id));
  const live = (list: readonly string[]): readonly string[] =>
    [...new Set(list)].filter((id) => id !== post.author && works.has(id));
  if (
    post.author === 'verifold' ||
    post.kind === 'plan' ||
    post.kind === 'rerun' ||
    post.kind === 'ask'
  )
    return live(post.mentions);
  if (post.kind === 'answer') return live(target ? [target.author] : []);
  if (post.kind !== 'objection' || !target) return [];
  return live(
    works.has(target.author)
      ? [target.author]
      : agents
          .filter((agent) => agent.direction === target.direction)
          .map((agent) => agent.id),
  );
}

/**
 * The objections that stand, by the post that each one targets, oldest first.
 * An objection ends with an answer that accepts it, with a check of Verifold
 * that took it and ended with a rerun, or with a later `check` post that holds
 * from an agent who wrote neither the target nor the objection. A check that
 * fails ends nothing: its target stays disputed, and the check shows.
 */
export function openObjections(
  posts: readonly Post[],
  checks: readonly Pick<Check, 'state' | 'objections'>[],
): ReadonlyMap<string, readonly Post[]> {
  const ended = new Set([
    ...checks
      .filter((check) => check.state === 'done')
      .flatMap((check) => check.objections),
    ...posts.flatMap((post) =>
      post.kind === 'answer' && post.accepts && post.replyTo
        ? [post.replyTo]
        : [],
    ),
  ]);
  const authors = new Map(posts.map((post) => [post.id, post.author]));
  const open = new Map<string, Post[]>();
  for (const post of posts) {
    if (!post.replyTo) continue;
    const list = open.get(post.replyTo) ?? [];
    if (post.kind === 'objection' && !ended.has(post.id))
      open.set(post.replyTo, [...list, post]);
    if (
      post.kind === 'check' &&
      post.outcome === 'holds' &&
      authors.get(post.replyTo) !== post.author
    ) {
      const left = list.filter((entry) => entry.author === post.author);
      if (left.length) open.set(post.replyTo, left);
      else open.delete(post.replyTo);
    }
  }
  return open;
}

/** The run that a post cites, when the ledger has it. */
export function citedRun(
  post: Pick<Post, 'artifacts'>,
  run: (id: string) => RunRecord | undefined,
): RunRecord | undefined {
  const cited = post.artifacts.find((artifact) => artifact.type === 'run');
  return cited?.type === 'run' ? run(cited.run) : undefined;
}

/** Why no new check of a post can start now. */
export type CheckBlock = 'kind' | 'no-run' | 'run-active' | 'limit' | 'going';

/** Why the person cannot ask for a check of a post now. Null: they can. */
export function checkBlock(
  post: Pick<Post, 'id' | 'kind' | 'artifacts'>,
  run: (id: string) => RunRecord | undefined,
  checks: readonly Pick<Check, 'claim' | 'state'>[],
): CheckBlock | null {
  if (!checkableKinds.some((kind) => kind === post.kind)) return 'kind';
  const cited = citedRun(post, run);
  if (!cited) return 'no-run';
  if (runActive(cited)) return 'run-active';
  const own = checks.filter(
    (check) => check.claim === post.id && check.state !== 'dropped',
  );
  if (own.some(({ state }) => state === 'queued' || state === 'running'))
    return 'going';
  return own.length >= checkLimits.perClaim ? 'limit' : null;
}

/** Why a post backs no verdict: it is a check that failed, or a check of it failed. Null when neither holds. */
export function refutation(post: Post, posts: readonly Post[]): string | null {
  if (post.kind === 'check' && post.outcome === 'fails')
    return `${post.id} is a check that failed, so it backs no verdict.`;
  const failed = posts.find(
    (entry) =>
      entry.kind === 'check' &&
      entry.outcome === 'fails' &&
      entry.replyTo === post.id,
  );
  return failed
    ? `${post.id} failed the check ${failed.id}, so it backs no verdict.`
    : null;
}

/** What `heldUp` reads of a check. */
export type HeldCheck = Pick<
  Check,
  | 'claim'
  | 'state'
  | 'outcome'
  | 'method'
  | 'blind'
  | 'result'
  | 'endedAt'
  | 'objections'
>;

/**
 * The one test of "held up", for a direction's verdict and a line's tag, so the
 * two cannot disagree. It needs a blind rerun of Verifold that held on `post`.
 * After that rerun, no check of any form failed, and no objection was accepted.
 * Nothing refutes the rerun, and no dispute stands. An agent's own `check` post
 * never holds a post up, whatever its method. `posts`: the lab's, or what
 * `evidencePosts` gives. A check that waits is the verdict's own concern.
 */
export function heldUp(
  post: Pick<Post, 'id'>,
  posts: readonly Post[],
  checks: readonly HeldCheck[],
): boolean {
  const when = (at: string | null): number => Date.parse(at ?? '');
  const own = checks.filter(
    (check) => check.claim === post.id && check.state === 'done',
  );
  const rerun = own
    .filter(
      (check) =>
        check.outcome === 'holds' && check.method === 'rerun' && check.blind,
    )
    .sort((a, b) => when(b.endedAt) - when(a.endedAt))[0];
  if (!rerun) return false;
  const byId = new Map(posts.map((entry) => [entry.id, entry]));
  const reran = rerun.result ? byId.get(rerun.result) : undefined;
  if (reran && refutation(reran, posts)) return false;
  const since = when(rerun.endedAt);
  const targets = new Set([post.id, ...(reran ? [reran.id] : [])]);
  const aimed = (entry: Post | undefined): boolean =>
    entry?.replyTo !== undefined && targets.has(entry.replyTo);
  const open = openObjections(posts, checks);
  return !(
    own.some(
      (check) => check.outcome !== 'holds' && when(check.endedAt) > since,
    ) ||
    posts.some(
      (entry) =>
        when(entry.at) > since &&
        ((entry.kind === 'check' &&
          entry.outcome === 'fails' &&
          aimed(entry)) ||
          (entry.kind === 'answer' &&
            entry.accepts === true &&
            entry.replyTo !== undefined &&
            byId.get(entry.replyTo)?.kind === 'objection' &&
            aimed(byId.get(entry.replyTo)))),
    ) ||
    [...targets].some((id) => open.has(id))
  );
}

/** The kinds that build on a post, so a dispute of that post marks them. */
const buildsOnKinds: ReadonlySet<PostKind> = new Set([
  'result',
  'proposal',
  'ruled-out',
  'claim',
  'evidence',
]);

/** The disputed post that a post replies to or names in its text, or null. */
export function citedDispute(
  post: Post,
  disputed: ReadonlySet<string>,
): string | null {
  if (!buildsOnKinds.has(post.kind)) return null;
  const cited = [
    post.replyTo,
    ...(post.text.match(/\bp-[1-9]\d{0,5}\b/g) ?? []),
  ];
  return (
    cited.find(
      (id): id is string =>
        id !== undefined && id !== post.id && disputed.has(id),
    ) ?? null
  );
}
