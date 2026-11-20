/**
 * Who is on a piece of work, in the person's words.
 *
 * A task is the agents' word. The person reads who is on a piece of work and for how long, such as "Rowan is on
 * this, 12 min left", and learns no new noun.
 */
import type { AgentView, Post, PostView, TaskCard, TaskState } from '../api/types.ts';
import { authorName } from './agents.ts';
import { duration } from './format.ts';

/** A piece of work as a line needs it: where it stands, the agent on it, and when that agent's hold ends. */
export interface OnIt {
  readonly state: TaskState;
  /** The agent that holds the work, or whose work came back. */
  readonly agent: string | null;
  /** When the holder's hold ends unless it works on the piece again. */
  readonly until: string | null;
}

/** The most pieces of work that a closed card lists. The opened thread lists every one. */
export const MAX_CARD_TASKS = 3;

/** Return the line that says who is on a piece of work, such as "Rowan is on this, 12 min left". */
export function onItLine(work: OnIt, agents: readonly AgentView[], now: Date): string {
  const name = work.agent ? authorName(agents, work.agent) : null;
  switch (work.state) {
    case 'claimed':
      return name && work.until
        ? `${name} is on this, ${left(work.until, now)}`
        : 'An agent is on this';
    case 'handed_back':
      return name ? `${name} handed this back` : 'The work came back';
    case 'done':
      return 'Done';
    case 'withdrawn':
      return 'Withdrawn';
    case 'open':
      return 'Nobody has taken this yet';
  }
}

function left(until: string, now: Date): string {
  const minutes = Math.max(0, Math.floor((new Date(until).getTime() - now.getTime()) / 60_000));
  return minutes < 1 ? 'less than a minute left' : `${duration(minutes)} left`;
}

/**
 * Return a task's post as a piece of work, or `null` for any other post. The agent whose work came back is the
 * author of the hand-back that the view names, which `posts` holds.
 */
export function workOf(item: PostView, posts: readonly PostView[]): OnIt | null {
  if (item.post.kind !== 'task') return null;
  const view = item.task ?? {};
  const back = posts.find((other) => other.post.id === view.hand_back)?.post.author ?? null;
  return {
    state: view.state ?? 'open',
    agent: view.held_by?.agent ?? back,
    until: view.held_by?.until ?? null,
  };
}

/**
 * Return the labeled parts of a piece of work that an agent handed out, of the work that came back, or of an idea,
 * each as plain text. A part of the work that came back with nothing in it is left out.
 */
export function partsOf(post: Post): readonly (readonly [string, string])[] {
  if (post.kind === 'idea') {
    return [
      ['The test', post.test],
      ['Rules it out', post.rules_out],
    ];
  }
  if (post.kind === 'task') {
    return [
      ['Wanted', post.output],
      ['Within', post.bounds],
    ];
  }
  if (post.kind !== 'hand_back') return [];
  const parts = [
    ['Found', post.findings],
    ['Concerns', post.concerns],
    ['Differs from the ask', post.deviations],
  ] as const;
  return parts.filter(([, text]) => text.length > 0);
}

/** Return the pieces of work that a card lists, and how many more the thread has. A closed card lists a few. */
export function cardTasks(
  tasks: readonly TaskCard[],
  open: boolean,
): { readonly shown: readonly TaskCard[]; readonly more: number } {
  const shown = open ? tasks : tasks.slice(0, MAX_CARD_TASKS);
  return { shown, more: tasks.length - shown.length };
}
