import type {
  Agent,
  BriefLine,
  CheckBlock,
  Direction,
  Lab,
  Notice,
  Post,
  Question,
  Reach,
  ReachWhen,
  Thread,
} from '../protocol/api.ts';
import { agentsWord } from './agent-rows.ts';
import { checkWords as ranWords } from './answer.ts';
import type { ReachQuery } from './controls.ts';
import { roleName, shortTime } from './format.ts';
import { threadedLab, type ViewMode } from './view-mode.ts';

/** How far a message goes. */
export type BoxLevel = 'coordinator' | 'thread' | 'agent' | 'lab';

/** A post that the box answers: a reply or an objection. */
export interface BoxAct {
  readonly kind: 'reply' | 'object';
  readonly post: Post;
}

/** How many names a reach line lists. Past that, it counts. */
const namedAgents = 5;

const ended = (agent: Pick<Agent, 'status'>): boolean =>
  agent.status === 'closed' ||
  agent.status === 'stopped' ||
  agent.status === 'crashed';

/** The agents that a person can write to, those of the thread first: who wrote there last, then who follows it. */
export function boxAgents(
  lab: Pick<Lab, 'agents'>,
  thread: Pick<Thread, 'followers'> | null,
  posts: readonly Pick<Post, 'author'>[],
): readonly Agent[] {
  const near = [
    ...posts.map((post) => post.author).reverse(),
    ...(thread?.followers ?? []),
  ];
  const rank = (agent: Agent): number => {
    const place = near.indexOf(agent.id);
    return place < 0 ? near.length : place;
  };
  return lab.agents
    .filter((agent) => agent.direction !== null && !ended(agent))
    .sort((a, b) => rank(a) - rank(b));
}

/** The levels of a box. The home has no thread, and a process that only shows the lab has no Coordinator to ask. */
export function boxLevels(
  lab: Pick<Lab, 'agentsHere'>,
  thread: unknown,
  agent: Pick<Agent, 'handle'> | null,
): readonly { readonly level: BoxLevel; readonly label: string }[] {
  return [
    ...(lab.agentsHere
      ? [{ level: 'coordinator' as const, label: 'Ask the Coordinator' }]
      : []),
    ...(thread ? [{ level: 'thread' as const, label: 'This thread' }] : []),
    ...(thread && agent
      ? [{ level: 'agent' as const, label: roleName(agent.handle) }]
      : []),
    { level: 'lab', label: 'Everyone' },
  ];
}

/**
 * What a send does. One value drives the send, the reach read, and the key of
 * the person's intent, so the line under the box cannot differ from the send.
 * `held`: the box keeps its text and sends nothing, and `why` says so.
 */
export type BoxTarget =
  | { readonly action: 'ask' }
  | { readonly action: 'held'; readonly why: string }
  | { readonly action: 'home' }
  | { readonly action: 'thread'; readonly thread: string }
  | {
      readonly action: 'to';
      readonly thread: string | null;
      /** An agent ID, or `all`. */
      readonly to: string;
    }
  | {
      readonly action: 'reply' | 'object';
      readonly thread: string | null;
      readonly post: string;
    };

const missWords: Readonly<
  Record<Reach['missed'][number]['why'], (one: boolean) => string>
> = {
  closed: (one) =>
    one ? "is closed, so it won't" : "are closed, so they won't",
  stopped: (one) =>
    one ? "is stopped, so it won't" : "are stopped, so they won't",
  crashed: (one) =>
    one
      ? "stopped by itself, so it won't until you start it again"
      : "stopped by themselves, so they won't until you start them again",
};

/** Why a pinned agent cannot get a message. Null: it can. */
function pinWords(
  agent: Pick<Agent, 'handle' | 'status'> | undefined,
): string | null {
  const keep = 'Your text stays. Choose another agent or level.';
  if (!agent) return `This page no longer shows that agent. ${keep}`;
  const why =
    agent.status === 'closed' ||
    agent.status === 'stopped' ||
    agent.status === 'crashed'
      ? agent.status
      : null;
  return why
    ? `${roleName(agent.handle)} ${missWords[why](true)}. ${keep}`
    : null;
}

/**
 * What the box's choice sends. `pinned`: the agent that the person chose,
 * which a new post never changes. An agent that ended holds the message: the
 * box never moves it to another agent by itself.
 */
export function boxTarget(choice: {
  readonly thread: string | null;
  readonly act: BoxAct | null;
  readonly level: BoxLevel;
  readonly pinned: Pick<Agent, 'id' | 'handle' | 'status'> | undefined;
}): BoxTarget {
  const { thread, act, level, pinned } = choice;
  if (act) return { action: act.kind, thread, post: act.post.id };
  if (level === 'coordinator') return { action: 'ask' };
  if (level === 'agent') {
    const why = pinWords(pinned);
    return why || !pinned
      ? { action: 'held', why: why ?? '' }
      : { action: 'to', thread, to: pinned.id };
  }
  if (level === 'lab' && thread) return { action: 'to', thread, to: 'all' };
  return thread ? { action: 'thread', thread } : { action: 'home' };
}

/**
 * The reach read of a target. Null: no agent reads it, so there is nothing to
 * read. The home's post names no one, so a name in its text narrows it.
 * `names`: the `@` names of the text.
 */
export function targetQuery(
  target: BoxTarget,
  names: string,
): ReachQuery | null {
  switch (target.action) {
    case 'ask':
    case 'held':
      return null;
    case 'home':
      return { named: names };
    case 'thread':
      return { thread: target.thread, named: names };
    case 'to':
      return {
        thread: target.thread ?? undefined,
        to: target.to,
        named: names,
      };
    case 'reply':
    case 'object':
      return {
        thread: target.thread ?? undefined,
        replyTo: target.post,
        named: names,
      };
  }
}

/** What makes two sends one intent, beyond their text: the action and its target, so a retry can never replay another send. */
export function targetKey(target: BoxTarget): string {
  return JSON.stringify(target);
}

/** The `@` names in a text, as the server reads them. */
export function atNames(text: string): string {
  return (text.match(/(?:^|\s)@[\w.-]+/g) ?? [])
    .map((name) => name.trim())
    .join(' ');
}

function names(handles: readonly string[]): string {
  return handles.length > namedAgents
    ? `${handles.length} agents`
    : agentsWord(handles);
}

function whenWords(
  when: ReachWhen,
  one: boolean,
  until: string | null,
  now: number,
): string {
  const its = one ? 'its' : 'their';
  switch (when) {
    case 'step':
      return one ? 'after its current step' : 'after their current steps';
    case 'now':
      return 'now';
    case 'slot':
      return 'when a slot is free';
    case 'usage':
      return `when ${its} usage window resets${until ? ` at ${shortTime(until, now)}` : ''}`;
    case 'resume':
      return 'after you resume the lab';
    case 'more-time':
      return 'after you give the lab more time';
    case 'terminal':
      return `after you give back ${its} terminal`;
    case 'plan':
      return 'after the plan is kept';
  }
}

/** Items by their key, in the order that the keys came. */
function grouped<T>(
  items: readonly T[],
  key: (item: T) => string,
): readonly (readonly T[])[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const group = groups.get(key(item));
    if (group) group.push(item);
    else groups.set(key(item), [item]);
  }
  return [...groups.values()];
}

/** The reach line: who reads this and when, then who does not and why. */
export function reachWords(reach: Reach, now: number): string {
  const readers = grouped(
    reach.readers,
    (reader) => `${reader.when} ${reader.until ?? ''}`,
  ).flatMap((group) => {
    const [first] = group;
    if (!first) return [];
    const one = group.length === 1;
    return [
      `${names(group.map((reader) => reader.handle))} read${one ? 's' : ''} this ${whenWords(first.when, one, first.until, now)}.`,
    ];
  });
  const missed = grouped(reach.missed, (miss) => miss.why).flatMap((group) => {
    const [first] = group;
    if (!first) return [];
    return [
      `${names(group.map((miss) => miss.handle))} ${missWords[first.why](group.length === 1)}.`,
    ];
  });
  return [
    ...(readers.length
      ? readers
      : ['No agent works now, so no agent reads this.']),
    ...missed,
  ].join(' ');
}

/** The reach line of an objection also says what an objection does. */
export function objectWords(line: string): string {
  return `${line} An objection marks the post Disputed until a check or an answer settles it.`;
}

/** The line under the box when it asks the Coordinator. */
export function askWords(lab: Pick<Lab, 'paused'>): string {
  return lab.paused
    ? "The lab is paused, so the Coordinator can't answer until it runs again."
    : 'The Coordinator answers from the record. No agent wakes.';
}

/** What a post offers beyond Reply. `why`: why no check can start. */
export function postActs(post: Pick<Post, 'author' | 'noCheck'>): {
  readonly object: boolean;
  readonly canCheck: boolean;
  readonly why: string | null;
} {
  const agent = post.author !== 'person' && post.author !== 'verifold';
  return {
    object: agent,
    canCheck: agent && !post.noCheck,
    why: agent && post.noCheck ? checkWords[post.noCheck] : null,
  };
}

const checkWords: Readonly<Record<CheckBlock, string>> = {
  kind: 'No check: only a result gets one',
  'no-run': 'No check: it cites no run',
  'run-active': 'No check yet: its run has not ended',
  limit: 'No check: it had its checks',
  going: 'A check waits or runs now',
};

/** A control of a direction on a thread's page. */
export interface DirectionAct {
  readonly direction: Direction;
  readonly name: string;
}

/** The most agents that a thread's page offers to stop, and to reopen. The direction pages have the rest. */
const shownActs = 4;

/** The agents of a thread that the person can stop or reopen: the owner of its direction, its followers, and who wrote in it. */
export function threadActs(
  thread: Pick<Thread, 'direction' | 'followers'>,
  posts: readonly Pick<Post, 'author'>[],
  lab: Pick<Lab, 'agents' | 'directions'>,
): {
  readonly stop: readonly DirectionAct[];
  readonly reopen: readonly DirectionAct[];
} {
  const own = new Set([
    ...thread.followers,
    ...posts.map((post) => post.author),
  ]);
  const acts = lab.directions.flatMap((direction): readonly DirectionAct[] => {
    const agent = lab.agents.find((entry) => entry.id === direction.agent);
    return agent && (direction.id === thread.direction || own.has(agent.id))
      ? [{ direction, name: roleName(agent.handle) }]
      : [];
  });
  const open = ({ direction }: DirectionAct): boolean =>
    direction.state === 'open';
  return {
    stop: acts.filter(open).slice(0, shownActs),
    reopen: acts.filter((act) => !open(act)).slice(0, shownActs),
  };
}

/** The person can bring back this direction's agent from its page. */
export function canReopen(
  lab: Pick<Lab, 'agentsHere'> & Parameters<typeof threadedLab>[0],
  direction: Pick<Direction, 'state'>,
): boolean {
  return lab.agentsHere && threadedLab(lab) && direction.state !== 'open';
}

/** What Stop and Reopen do, for the controls that the page shows. */
export function workNote(acts: {
  readonly stop: readonly unknown[];
  readonly reopen: readonly unknown[];
}): string {
  return [
    ...(acts.stop.length
      ? [
          'Stop asks you to confirm, then ends the run and keeps the files and the record.',
        ]
      : []),
    ...(acts.reopen.length
      ? ['Reopen brings the work back and wakes the agent with this thread.']
      : []),
  ].join(' ');
}

const counted = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

/** The head of an answer. Each form says that no agent woke for it. */
export function answerHead(
  question: Pick<Question, 'at' | 'state'>,
  now: number,
): string {
  const quiet = 'No agent was disturbed.';
  switch (question.state) {
    case 'waiting':
      return `Reading the record. ${quiet}`;
    case 'answered':
      return `${shortTime(question.at, now)}. Answered from the record. ${quiet}`;
    case 'unanswered':
      return `It gave no answer. ${quiet}`;
  }
}

/** How an answer's check went, in one line. Null: it passed, or this lab keeps no plain words. */
export function answerCheck(answer: Pick<BriefLine, 'check'>): string | null {
  const { state, reason } = answer.check;
  return state === 'pending'
    ? 'A second agent is checking this answer.'
    : (reason ?? null);
}

/** "2 posts": what an answer cites. */
export function sourceWords(posts: readonly string[]): string {
  return counted(posts.length, 'post');
}

/** How many answers a page shows. Older ones stay on record. */
const shownAnswers = 2;

/** The person's newest questions, oldest first. */
export function newestQuestions(
  lab: Pick<Lab, 'questions'>,
): readonly Question[] {
  return (lab.questions ?? []).slice(-shownAnswers);
}

/** How many notices a page shows. */
const shownNotices = 3;

/** A notice in Verifold's words, with its posts in Technical. */
function noticeWords(
  notice: Notice,
  lab: Pick<Lab, 'agents'>,
  mode: ViewMode,
): string {
  const ids = mode === 'technical' ? ` (${notice.posts.join(', ')})` : '';
  if (notice.kind !== 'overlap')
    return `The Coordinator sees no answer yet to your message.${ids}`;
  const handles = notice.to.flatMap(
    (id) => lab.agents.find((agent) => agent.id === id)?.handle ?? [],
  );
  return `The Coordinator sees that ${handles.length ? agentsWord(handles) : 'two agents'} may do the same work.${ids}`;
}

/** The newest notices that the person can act on. `thread`: only those of one thread. */
export function noticesForYou(
  lab: Pick<Lab, 'agents' | 'notices'>,
  mode: ViewMode,
  thread?: string,
): readonly {
  readonly id: string;
  readonly text: string;
  readonly thread: string | null;
}[] {
  return (lab.notices ?? [])
    .filter(
      (notice) =>
        notice.forYou === true &&
        (thread === undefined || notice.thread === thread),
    )
    .slice(-shownNotices)
    .map((notice) => ({
      id: notice.id,
      text: noticeWords(notice, lab, mode),
      thread: notice.thread ?? null,
    }));
}

/** How many ended checks of the person a page shows. */
const shownChecks = 3;

/**
 * The person's checks that failed or that did not hold, each the newest of its
 * post, so a later check takes its line away. Ended checks can leave a smaller
 * snapshot, and then their posts still show them.
 */
export function checksForYou(
  lab: Pick<Lab, 'checks'>,
  mode: ViewMode,
): readonly {
  readonly id: string;
  readonly text: string;
  readonly post: string;
}[] {
  return lab.checks
    .filter(
      (check, index) =>
        check.byPerson === true &&
        (check.state === 'failed' ||
          (check.state === 'done' && check.outcome !== 'holds')) &&
        !lab.checks.slice(index + 1).some(({ post }) => post === check.post),
    )
    .slice(-shownChecks)
    .map((check) => ({
      id: check.id,
      post: check.post,
      text: `Your check: ${ranWords(check)}.${check.state === 'failed' && check.note ? ` ${check.note}` : ''}${mode === 'technical' ? ` (${check.id} of ${check.post})` : ''}`,
    }));
}

/** The label of a post's prior work: "Prior work · Helper 1.1 · 16:31 · 6 lookups". All but its first words come from the record. */
export function priorLabel(post: Pick<Post, 'search'>, now: number): string {
  const { search } = post;
  if (!search) return 'Prior work · No lookups on record';
  return [
    'Prior work',
    ...(search.helper
      ? [`Helper ${search.helper.replace(/^[a-z]+-/, '')}`]
      : []),
    shortTime(search.at, now),
    counted(search.lookups, 'lookup'),
  ].join(' · ');
}
