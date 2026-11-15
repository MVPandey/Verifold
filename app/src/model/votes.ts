import type {
  AgentView,
  Badge,
  BadgeLine,
  Given,
  LabView,
  PostView,
  ProposalLine,
  VoteLine,
} from '../api/types.ts';
import { PERSON } from '../api/types.ts';
import { ownName } from './agents.ts';
import { duration, minutesBetween } from './format.ts';

/** The words on each badge. */
export const BADGE_WORDS: Readonly<Record<Badge, string>> = {
  promising: 'Promising',
  confirmed: 'Confirmed',
  breakthrough: 'Breakthrough',
};

/** The most characters in the reason of a vote or a badge, as the server takes it. */
export const MAX_WHY = 140;

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** Return the badges that stand on a post. A Breakthrough that waits for its second is none. */
export function standingBadges(item: PostView): readonly BadgeLine[] {
  return (item.badges ?? []).filter((line) => !line.waits);
}

/** Return whether a Breakthrough badge stands on a post. */
export function hasBreakthrough(item: PostView): boolean {
  return standingBadges(item).some((line) => line.badge === 'breakthrough');
}

/** Return the Breakthrough badge that an agent proposed for a post and nobody seconded yet, or `null`. */
export function waitingProposal(item: PostView): BadgeLine | null {
  return (item.badges ?? []).find((line) => line.waits) ?? null;
}

/** Return the person's own standing vote on a post, or `null`. */
export function yourVote(item: PostView): VoteLine | null {
  return (item.votes ?? []).find((vote) => vote.by === PERSON) ?? null;
}

/**
 * Return the votes of a post in the order of the list: the person's first, then the coordinator's, then the
 * others as they were cast. The order marks whose vote it is. Every vote counts the same, and nothing is sorted
 * by a count.
 */
export function orderVotes(
  votes: readonly VoteLine[],
  agents: readonly AgentView[],
): readonly VoteLine[] {
  const coordinator = agents.find((view) => view.coordinator)?.agent.id;
  const first = (vote: VoteLine): number =>
    vote.by === PERSON ? 0 : vote.by === coordinator ? 1 : 2;
  return [...votes].sort((one, other) => first(one) - first(other));
}

/** Return the words of the control that opens a post's votes, such as "4 votes, yours is up. Show who and why". */
export function votesLine(item: PostView): string {
  const count = (item.up ?? 0) + (item.down ?? 0);
  const yours = yourVote(item);
  const votes = count === 1 ? '1 vote' : `${count} votes`;
  const mine = yours ? `, yours is ${yours.direction}` : '';
  return count > 0 ? `${votes}${mine}. Show who and why` : 'Show who gave the badges';
}

/** Return how many votes the detail does not list, because it lists the newest ones. */
export function votesLeftOut(item: PostView): number {
  return Math.max((item.up ?? 0) + (item.down ?? 0) - (item.votes ?? []).length, 0);
}

/** Return whether the person can give a post the Promising badge: another wrote it, and the person has not yet. */
export function canMarkPromising(item: PostView): boolean {
  const given = (item.badges ?? []).find((line) => line.badge === 'promising')?.given ?? [];
  return item.post.author !== PERSON && !given.some((one) => one.by === PERSON);
}

/** Return who gave a badge, such as "Given by you." or "Given by Quill." */
export function givenBy(given: Given, agents: readonly AgentView[]): string {
  return given.by === PERSON ? 'Given by you.' : `Given by ${ownName(agents, given.by)}.`;
}

/**
 * Return who proposed a Breakthrough badge and who seconded it, such as "Proposed by Quill, seconded by Maren as
 * coordinator." An agent seconds only while it holds the coordinator seat, so the line says so also after the
 * seat changed.
 */
export function secondedBy(line: BadgeLine, agents: readonly AgentView[]): string {
  const proposed = LIST.format(line.given.map((given) => ownName(agents, given.by)));
  const second = line.second;
  if (!second) return `Proposed by ${proposed}.`;
  return second.by === PERSON
    ? `Proposed by ${proposed}, seconded by you.`
    : `Proposed by ${proposed}, seconded by ${ownName(agents, second.by)} as coordinator.`;
}

/**
 * Return the line of a Breakthrough badge that waits, such as "Proposed as a breakthrough by Quill. Waits for the
 * coordinator or you." The coordinator can second it when an agent holds the seat and neither proposed the badge
 * nor wrote the post.
 */
export function proposedLine(
  item: PostView,
  line: BadgeLine,
  agents: readonly AgentView[],
): string {
  const proposers = line.given.map((given) => given.by);
  const coordinator = agents.find((view) => view.coordinator && view.left === null)?.agent.id;
  const can =
    coordinator !== undefined &&
    coordinator !== item.post.author &&
    !proposers.includes(coordinator);
  const names = LIST.format(proposers.map((id) => ownName(agents, id)));
  return `Proposed as a breakthrough by ${names}. Waits for ${can ? 'the coordinator or you' : 'you'}.`;
}

/** One row of the seat's list for a Breakthrough badge that waits for its second. */
export interface ProposalRow {
  readonly proposal: ProposalLine;
  /** The name of the agent that proposed it. */
  readonly name: string;
  /** How long it has waited, such as "12 min". */
  readonly waited: string;
}

/** Return the Breakthrough badges that wait for a second, oldest first, as rows of the seat's list. */
export function proposalRows(lab: LabView, now: Date): readonly ProposalRow[] {
  return lab.proposals.map((proposal) => ({
    proposal,
    name: ownName(lab.agents, proposal.by),
    waited: duration(minutesBetween(proposal.at, now)),
  }));
}

/** Return the heading of those rows, such as "Proposed for a Breakthrough badge (1)". */
export function proposalsHeading(count: number): string {
  return `Proposed for a Breakthrough badge (${count})`;
}
