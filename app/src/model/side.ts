import type { AgentView, ThreadSummary } from '../api/types.ts';
import { ownName } from './agents.ts';

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** Return whether a thread is a side thread: a thread between named agents. Only a side thread has members. */
export function isSide(summary: ThreadSummary): boolean {
  return summary.members.length > 0;
}

/** Return the members of a side thread by name, as one phrase such as "Agent 1 and Agent 2". */
export function memberNames(members: readonly string[], agents: readonly AgentView[]): string {
  return LIST.format(members.map((id) => ownName(agents, id)));
}

/** A side thread as one line of the lab page: who talks, about what, and how much. */
export interface SideLine {
  readonly id: string;
  readonly who: string;
  readonly title: string;
  readonly count: string;
}

/** Return the lab's side threads as lines, in the order that the server sends them: the most recent first. */
export function sideLines(
  threads: readonly ThreadSummary[],
  agents: readonly AgentView[],
): readonly SideLine[] {
  return threads.filter(isSide).map((summary) => ({
    id: summary.thread.id,
    who: memberNames(summary.members, agents),
    title: summary.thread.title,
    count: summary.posts === 1 ? '1 post' : `${summary.posts} posts`,
  }));
}

/** Return the heading of the group of side threads, which says how many the lab has. */
export function sideHeading(count: number): string {
  return count === 1 ? '1 side thread' : `${count} side threads`;
}

/** Return the line of an opened side thread: who it is between, and that it is open to all. */
export function betweenLine(members: readonly string[], agents: readonly AgentView[]): string {
  return `A side thread between ${memberNames(members, agents)}. Every agent and you can read it.`;
}
