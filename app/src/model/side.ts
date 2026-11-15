import type { AgentView, ThreadSummary } from '../api/types.ts';
import { ownName } from './agents.ts';
import { cardStatus } from './turns.ts';

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** Return whether a thread is a side thread: a thread between named agents. Only a side thread has members. */
export function isSide(summary: ThreadSummary): boolean {
  return summary.members.length > 0;
}

/** Return the members of a side thread by name, as one phrase such as "Agent 1 and Agent 2". */
export function memberNames(members: readonly string[], agents: readonly AgentView[]): string {
  return LIST.format(members.map((id) => ownName(agents, id)));
}

/** A side thread as one line of the lab page: who talks, about what, how much, and what is open in it. */
export interface SideLine {
  readonly id: string;
  readonly who: string;
  readonly title: string;
  readonly count: string;
  /** What a card's status says, in short: disputed results, results that nobody checked, open asks, and calls. */
  readonly marks: readonly string[];
}

/** Return the marks of a side thread, from the counts in its summary. A count of zero gives no mark. */
function marks(summary: ThreadSummary): readonly string[] {
  const { openAsks, openCalls } = cardStatus(summary);
  const { disputed, not_checked: open } = summary;
  return [
    disputed > 0 ? `${disputed} disputed` : null,
    open > 0 ? `${open} not checked` : null,
    openAsks,
    openCalls,
  ].filter((mark) => mark !== null);
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
    marks: marks(summary),
  }));
}

/** Return a small count in words, as a sentence writes it. */
function inWords(count: number): string {
  return count === 2 ? 'two' : count === 3 ? 'three' : String(count);
}

/**
 * Return the line of the folded group of side threads: how many the lab has, and between how many agents each
 * is, such as "6 side threads between two or three agents."
 */
export function sideHeading(side: readonly ThreadSummary[]): string {
  const sizes = side.map((summary) => summary.members.length);
  const least = Math.min(...sizes);
  const most = Math.max(...sizes);
  const between =
    least === most
      ? inWords(least)
      : `${inWords(least)} ${most === least + 1 ? 'or' : 'to'} ${inWords(most)}`;
  return `${side.length === 1 ? '1 side thread' : `${side.length} side threads`} between ${between} agents.`;
}

/** Return the line of an opened side thread: who it is between, and that it is open to all. */
export function betweenLine(members: readonly string[], agents: readonly AgentView[]): string {
  return `A side thread between ${memberNames(members, agents)}. Every agent and you can read it.`;
}

/**
 * Return the hint under the reply box of a side thread. While the agents say that the lab is done, it also says
 * that a reply here does not open the lab again, because only the members hear it.
 */
export function sideReplyHint(done: boolean): string {
  const hint = 'The members of this side thread get your reply.';
  return done ? `${hint} It does not open the lab again. For that, post in another thread.` : hint;
}
