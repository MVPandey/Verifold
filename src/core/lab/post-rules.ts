/**
 * What each kind of post needs and does in a lab with threads: pure rules,
 * with no lab. `shapePost` checks a post before Verifold commits its proof,
 * and a refusal says exactly what to change. `wakeList` says who a post wakes.
 * `openObjections` says which objections still stand. Together they replace a
 * switch on kinds in the lab.
 */
import type { BoardAgent, Post, PostKind } from '../board.ts';
import { postOutcomes, threadLimits } from '../lab-tools.ts';
import { fail, text, type Check, type Thread } from './schema.ts';
import { checkTitle, planThread } from './threads.ts';

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
export interface PostShape extends Pick<Post, 'outcome' | 'accepts'> {
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

/** Where the post goes: its target's thread, a named thread, or a new one. */
function place(
  args: Record<string, unknown>,
  replied: Post | undefined,
  context: PostContext,
): PostShape['thread'] {
  const named = args.thread;
  const home = replied?.thread;
  if (home && (args.title !== undefined || (named && named !== home)))
    fail(
      `A reply stays in its target's thread. ${replied.id} is in ${home}. Leave title out, and give thread ${home} or none.`,
    );
  const id = home ?? named;
  if (id !== undefined) {
    const thread =
      context.threads.find((entry) => entry.id === id) ??
      fail(
        `No thread ${typeof id === 'string' ? id.slice(0, 20) : ''} is in the lab. verifold_board with view threads lists them.`,
      );
    if (thread.state === 'closed')
      fail(
        `${thread.id} is closed. Open a new thread with title and why, and cite the post that you build on.`,
      );
    return thread.id;
  }
  if (args.title === undefined)
    fail(
      'Give thread to post in a thread, or title and why to open one. verifold_board with view threads lists them.',
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

/** The person's words reach who they name, then the thread's followers. A post to nobody in the plan thread reaches every agent. */
function personWakes(post: Post, context: WakeContext): readonly string[] {
  const { agents, target, thread } = context;
  const everyone = agents.map((agent) => agent.id);
  const named = [
    ...post.mentions,
    ...(target ? [target.author] : []),
    ...agents
      .filter((agent) => post.direction && agent.direction === post.direction)
      .map((agent) => agent.id),
  ];
  if (post.mentions.includes('all')) return everyone;
  if (thread?.id === planThread) return named.length ? named : everyone;
  return post.mentions.length
    ? named
    : [...named, ...(thread?.followers ?? [])];
}

/**
 * The agent IDs that a post wakes. An objection wakes the author of its
 * target, or the owner of its direction when a checker wrote the target. An
 * ask wakes who it names. An answer wakes who wrote what it answers. The
 * person's words wake followers. A plan, a rerun, and Verifold's own notes wake
 * who they mention. Other posts wait for each agent's next turn.
 */
export function wakeList(post: Post, context: WakeContext): readonly string[] {
  const { agents, target } = context;
  const works = new Set(agents.map((agent) => agent.id));
  const owner = (direction: string | undefined): string[] =>
    agents
      .filter((agent) => agent.direction === direction)
      .map((agent) => agent.id);
  let list: readonly string[] = [];
  if (post.author === 'person') list = personWakes(post, context);
  else if (post.author === 'verifold') list = post.mentions;
  else if (post.kind === 'plan' || post.kind === 'rerun' || post.kind === 'ask')
    list = post.mentions;
  else if (post.kind === 'answer') list = target ? [target.author] : [];
  else if (post.kind === 'objection' && target)
    list = works.has(target.author) ? [target.author] : owner(target.direction);
  return [...new Set(list)].filter((id) => id !== post.author && works.has(id));
}

/**
 * The objections that stand, by the post that each one targets, oldest
 * first. An objection ends with an answer that accepts it, with a later
 * `check` post that fails its target, or with a check of Verifold that took
 * it and ended with a rerun, whatever the rerun found.
 */
export function openObjections(
  posts: readonly Post[],
  checks: readonly Check[],
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
  const open = new Map<string, Post[]>();
  for (const post of posts) {
    if (post.kind === 'objection' && post.replyTo && !ended.has(post.id))
      open.set(post.replyTo, [...(open.get(post.replyTo) ?? []), post]);
    if (post.kind === 'check' && post.outcome === 'fails' && post.replyTo)
      open.delete(post.replyTo);
  }
  return open;
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
