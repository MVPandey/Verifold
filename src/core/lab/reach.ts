/**
 * Who the person's words reach, and when: pure rules, with no lab. `wakeList`
 * uses `personReaders` to wake agents, and the box on a page shows what
 * `reachOf` says, so the line under the box and the wakes are one answer. The
 * app reaches this through `GET /api/v1/reach`.
 */
import { directionId, type BoardAgent, type Post } from '../board.ts';
import type { DirectionView, Thread } from './schema.ts';
import { planThread } from './threads.ts';

/** What the rules read of a post, or of a post that the person is about to send. */
export type Words = Pick<Post, 'mentions' | 'direction'>;

/** What the person's words are near. */
export interface WordsPlace {
  /** The post that they reply to. */
  readonly target: Pick<Post, 'author'> | undefined;
  readonly thread: Pick<Thread, 'id' | 'followers'> | undefined;
  /** The agents that work now. */
  readonly agents: readonly BoardAgent[];
}

/** Who the person's words are for: who they name, then the followers of the thread. */
function addressed(words: Words, place: WordsPlace): readonly string[] {
  const { agents, target, thread } = place;
  if (words.mentions.includes('all')) return agents.map((agent) => agent.id);
  const named = [
    ...words.mentions,
    ...(target ? [target.author] : []),
    ...agents
      .filter((agent) => words.direction && agent.direction === words.direction)
      .map((agent) => agent.id),
  ];
  return words.mentions.length || thread?.id === planThread
    ? named
    : [...named, ...(thread?.followers ?? [])];
}

/**
 * The agent IDs that the person's words wake. Words that would reach no one
 * reach every agent that works, so they always reach someone.
 */
export function personReaders(
  words: Words,
  place: WordsPlace,
): readonly string[] {
  const works = new Set(place.agents.map((agent) => agent.id));
  const reached = [...new Set(addressed(words, place))].filter((id) =>
    works.has(id),
  );
  return reached.length ? reached : [...works];
}

/** An agent of a direction, as the rules read it. */
export interface ReachAgent extends BoardAgent {
  readonly handle: string;
  readonly status: DirectionView['status'];
  /** When a wait ends. */
  readonly until: string | null;
  /** It has no process now, so a wake needs a free slot. */
  readonly parked: boolean;
}

/** When an agent reads the person's words. */
export type ReachWhen =
  | 'step'
  | 'now'
  | 'slot'
  | 'usage'
  | 'resume'
  | 'more-time'
  | 'terminal'
  | 'plan';

/** Why an agent that the words are for does not read them. */
export type ReachMiss = 'closed' | 'stopped' | 'crashed';

/** Who reads the person's words and when, and who does not and why. */
export interface Reach {
  readonly readers: readonly {
    readonly handle: string;
    readonly when: ReachWhen;
    /** When a wait ends. */
    readonly until: string | null;
  }[];
  readonly missed: readonly {
    readonly handle: string;
    readonly why: ReachMiss;
  }[];
}

/** What the rules read of the lab. */
export interface LabReach {
  /** Each direction's agent. */
  readonly agents: readonly ReachAgent[];
  /** Why the lab is paused. Null: it runs. */
  readonly paused: 'person' | 'deadline' | null;
  /** Every worker slot is taken. */
  readonly slotsFull: boolean;
}

/** Why an agent reads nothing. These states are the agents that `Lab.active` leaves out. Null: it works. */
export function endedWhy(status: ReachAgent['status']): ReachMiss | null {
  return status === 'closed' || status === 'stopped' || status === 'crashed'
    ? status
    : null;
}

function whenOf(agent: ReachAgent, lab: LabReach): ReachWhen {
  switch (agent.status) {
    case 'working':
    case 'starting':
      return 'step';
    case 'slot':
      return 'slot';
    case 'usage':
      return 'usage';
    case 'paused':
      return lab.paused === 'deadline' ? 'more-time' : 'resume';
    case 'terminal':
      return 'terminal';
    case 'plan':
      return 'plan';
    default:
      // The person's words pass the hourly turns, so only a slot can hold them.
      return agent.parked && lab.slotsFull ? 'slot' : 'now';
  }
}

/** Who the person's words reach now, from the same rule that wakes the agents. */
export function reachOf(
  words: Words,
  place: Pick<WordsPlace, 'target' | 'thread'>,
  lab: LabReach,
): Reach {
  const working = lab.agents.filter((agent) => !endedWhy(agent.status));
  const readers = new Set(personReaders(words, { ...place, agents: working }));
  const named = addressed(words, { ...place, agents: lab.agents });
  return {
    readers: working
      .filter((agent) => readers.has(agent.id))
      .map((agent) => ({
        handle: agent.handle,
        when: whenOf(agent, lab),
        until: agent.status === 'usage' ? agent.until : null,
      })),
    missed: lab.agents.flatMap((agent) => {
      const why = endedWhy(agent.status);
      return why && (!named.length || named.includes(agent.id))
        ? [{ handle: agent.handle, why }]
        : [];
    }),
  };
}

/**
 * The names that `@` picks out of the person's text. `handles`: the source of
 * a pattern of the lab's handles. A name that no agent has stays in the list,
 * so the caller can refuse it.
 */
export function namedIn(text: string, handles: string): readonly string[] {
  return [
    ...text.matchAll(new RegExp(`(?:^|\\s)@(${handles}|all|person)\\b`, 'g')),
  ].map((match) => match[1] ?? '');
}

/** `@d-2` in the person's post: the direction's ID, from its own pattern. */
const mentionedDirection = new RegExp(
  `(?:^|\\s)@(${directionId.source.slice(1, -1)})\\b`,
  'g',
);

/** The first `@d-N` in the person's text that names an open direction. */
export function directionNamedIn(
  text: string,
  directions: readonly { readonly id: string; readonly state: string }[],
): string | undefined {
  const open = new Set(
    directions
      .filter((direction) => direction.state === 'open')
      .map((direction) => direction.id),
  );
  return [...text.matchAll(mentionedDirection)]
    .map((match) => match[1] ?? '')
    .find((id) => open.has(id));
}
