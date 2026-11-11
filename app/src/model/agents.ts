import { PERSON } from '../api/types.ts';
import type { AgentActivity, AgentView, HarnessOption } from '../api/types.ts';
import { duration, minutesBetween, money, tokens } from './format.ts';

/** The dot before an agent's state. */
export type Dot = 'live' | 'wait' | 'idle' | 'stop';

export interface StateLine {
  readonly text: string;
  readonly dot: Dot;
}

/** An author's face: two letters and a color that stay the same on every screen. */
export interface Face {
  readonly kind: 'member' | 'person' | 'rerun';
  readonly initials: string;
  /** The member's place in the lab's palette. The stylesheet has eight colors and starts again after them. */
  readonly color: number | null;
  readonly name: string;
}

/** Return the lab's members: its agents without the blind checkers. */
export function members(agents: readonly AgentView[]): readonly AgentView[] {
  return agents.filter((view) => view.agent.checks === null);
}

/**
 * Return an author's face. A member's letters and color come from its position among the lab's members. A blind
 * checker has no name and no color.
 */
export function face(agents: readonly AgentView[], authorId: string): Face {
  if (authorId === PERSON) return { kind: 'person', initials: 'You', color: null, name: 'You' };
  const position = members(agents).findIndex((view) => view.agent.id === authorId);
  const name = authorName(agents, authorId);
  if (position < 0) return { kind: 'rerun', initials: '', color: null, name };
  const number = position + 1;
  const initials = number < 10 ? `${name.slice(0, 1).toUpperCase()}${number}` : String(number);
  return { kind: 'member', initials, color: position % 8, name };
}

/** Return the name of an author: the agent's name, "Blind rerun" for a blind checker, or "You" for the person. */
export function authorName(agents: readonly AgentView[], authorId: string): string {
  if (authorId === PERSON) return 'You';
  const agent = agents.find((view) => view.agent.id === authorId)?.agent;
  if (agent === undefined) return authorId;
  return agent.checks === null ? agent.name : 'Blind rerun';
}

/** Return how a sentence names an author, such as "objected to the blind rerun’s check". */
export function called(agents: readonly AgentView[], authorId: string): string {
  if (authorId === PERSON) return 'you';
  const name = authorName(agents, authorId);
  return name === 'Blind rerun' ? 'the blind rerun' : name;
}

/** Return the title of a harness, such as "Claude Code". */
export function harnessTitle(harnesses: readonly HarnessOption[], name: string): string {
  return harnesses.find((option) => option.name === name)?.title ?? name;
}

/** Return what an agent is doing, in one line, with how long it has done it. */
export function stateLine(activity: AgentActivity, now: Date): StateLine {
  const minutes = activity.at ? minutesBetween(activity.at, now) : 0;
  const since = minutes > 0 ? `, ${duration(minutes)}` : '';
  switch (activity.state) {
    case 'working':
      return { text: `${activity.detail || 'Working'}${since}`, dot: 'live' };
    case 'waiting':
      return { text: `${activity.detail || 'Waiting for you'}${since}`, dot: 'wait' };
    case 'idle':
      return { text: `Idle${since}`, dot: 'idle' };
    case 'starting':
      return { text: 'Starting', dot: 'idle' };
    case 'stopped':
      return { text: 'Stopped', dot: 'stop' };
  }
}

/** Return what an agent has cost: its price when the harness gives one, or else its tokens. */
export function costLine(view: AgentView): string {
  if (view.turns === 0) return 'No turns yet';
  const turns = `${view.turns} ${view.turns === 1 ? 'turn' : 'turns'}`;
  if (view.cost_usd !== null) return `${money(view.cost_usd)} over ${turns}`;
  const { input_tokens: input, output_tokens: output } = view.usage;
  return `${tokens(input)} tokens in, ${tokens(output)} out over ${turns}. No price.`;
}

/** Return how many members work now, such as "3 of 4 members working, 2 blind reruns". */
export function workingLine(agents: readonly AgentView[]): string {
  const all = members(agents);
  const busy = (view: AgentView): boolean => view.activity.state === 'working';
  const reruns = agents.filter((view) => view.agent.checks !== null && busy(view)).length;
  const line = `${all.filter(busy).length} of ${all.length} ${all.length === 1 ? 'member' : 'members'} working`;
  if (reruns === 0) return line;
  return `${line}, ${reruns} blind ${reruns === 1 ? 'rerun' : 'reruns'}`;
}

/** Return what the lab has cost so far, such as "$0.37 and 463k tokens" for harnesses with and without prices. */
export function labTotal(agents: readonly AgentView[]): string {
  const usd = agents.reduce((sum, view) => sum + (view.cost_usd ?? 0), 0);
  const unpriced = agents
    .filter((view) => view.cost_usd === null)
    .reduce((sum, view) => sum + view.usage.input_tokens + view.usage.output_tokens, 0);
  if (unpriced === 0) return money(usd);
  return usd > 0 ? `${money(usd)} and ${tokens(unpriced)} tokens` : `${tokens(unpriced)} tokens`;
}
