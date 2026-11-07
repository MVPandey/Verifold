import { PERSON } from '../api/types.ts';
import type { AgentActivity, AgentView, HarnessOption } from '../api/types.ts';
import { duration, minutesBetween, money, tokens } from './format.ts';

/** The color of an agent's avatar. The first harness of the setup gets the accent color. */
export type Tone = 'cc' | 'cx' | 'you';

/** The dot before an agent's state. */
export type Dot = 'live' | 'wait' | 'idle' | 'stop';

export interface StateLine {
  readonly text: string;
  readonly dot: Dot;
}

/** Return the mark in an author's avatar: the agent's number, C for a checker, or "You" for the person. */
export function mark(authorId: string): string {
  if (authorId === PERSON) return 'You';
  const number = /^agent-(\d+)$/.exec(authorId)?.[1];
  if (number) return number;
  return authorId.startsWith('checker-') ? 'C' : authorId.slice(0, 1).toUpperCase();
}

/** Return the name of an author: the agent's name, or "You" for the person. */
export function authorName(agents: readonly AgentView[], authorId: string): string {
  if (authorId === PERSON) return 'You';
  return agents.find((view) => view.agent.id === authorId)?.agent.name ?? authorId;
}

/** Return the title of a harness, such as "Claude Code". */
export function harnessTitle(harnesses: readonly HarnessOption[], name: string): string {
  return harnesses.find((option) => option.name === name)?.title ?? name;
}

/** Return the avatar color of an author. */
export function tone(
  harnesses: readonly HarnessOption[],
  agents: readonly AgentView[],
  authorId: string,
): Tone {
  if (authorId === PERSON) return 'you';
  const harness = agents.find((view) => view.agent.id === authorId)?.agent.harness;
  return harness !== undefined && harnesses[0]?.name === harness ? 'cc' : 'cx';
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

/** Return what the lab has cost so far, such as "$0.37 and 463k tokens" for harnesses with and without prices. */
export function labTotal(agents: readonly AgentView[]): string {
  const usd = agents.reduce((sum, view) => sum + (view.cost_usd ?? 0), 0);
  const unpriced = agents
    .filter((view) => view.cost_usd === null)
    .reduce((sum, view) => sum + view.usage.input_tokens + view.usage.output_tokens, 0);
  if (unpriced === 0) return money(usd);
  return usd > 0 ? `${money(usd)} and ${tokens(unpriced)} tokens` : `${tokens(unpriced)} tokens`;
}
