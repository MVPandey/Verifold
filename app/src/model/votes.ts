import type {
  AgentView,
  AnswerView,
  Badge,
  BadgeLine,
  Given,
  LabView,
  Post,
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

/**
 * Return the badges that stand on a post. A Breakthrough that waits for its second is none, and neither is a
 * Confirmed whose check a later failed check followed.
 */
export function standingBadges(item: PostView): readonly BadgeLine[] {
  return (item.badges ?? []).filter((line) => !line.waits && !line.lapsed);
}

/** Return the badges that a post's list shows: the ones that stand, and a Confirmed that stands no longer. */
export function listedBadges(item: PostView): readonly BadgeLine[] {
  return (item.badges ?? []).filter((line) => !line.waits);
}

/**
 * Return whether a post takes votes and badges. A request of a harness and a request for a move are no work to
 * judge, so the server takes none on them.
 */
export function takesVotes(post: Post): boolean {
  return post.kind !== 'request' && !(post.kind === 'ask' && post.request);
}

/**
 * Return the name of a count's control, which says what a press does and what the count is, such as "Vote up. 3
 * up votes, yours among them". Without `press`, it is the count alone.
 */
export function countLabel(
  direction: 'up' | 'down',
  votes: number,
  mine: boolean,
  press: boolean,
): string {
  const count =
    votes === 0
      ? `No ${direction} votes`
      : `${votes} ${direction} ${votes === 1 ? 'vote' : 'votes'}`;
  const whole = mine ? `${count}, yours among them` : count;
  return press ? `Vote ${direction}. ${whole}` : whole;
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
  const others = item.post.author !== PERSON && takesVotes(item.post);
  return others && !given.some((one) => one.by === PERSON);
}

/** Return who gave a badge, such as "Given by you." or "Given by Quill." */
export function givenBy(given: Given, agents: readonly AgentView[]): string {
  return given.by === PERSON ? 'Given by you.' : `Given by ${ownName(agents, given.by)}.`;
}

/**
 * Return what a Confirmed badge's giver said once, when its word confirms the post no longer, such as "Was
 * confirmed by p-7; a later check failed", or `null` while it does.
 */
export function lapsedLine(given: Given, agents: readonly AgentView[]): string | null {
  if (!given.lapsed) return null;
  const by = given.proof ?? (given.by === PERSON ? 'you' : ownName(agents, given.by));
  const why =
    given.lapsed === 'check_conceded'
      ? 'the author of that check conceded an objection to it'
      : 'a later check failed';
  return `Was confirmed by ${by}; ${why}.`;
}

/**
 * Return who proposed a Breakthrough badge and who seconded it, with the seconder's capacity, such as "Proposed
 * by Quill, seconded by Maren, the coordinator you seated." Only the person and a coordinator to which the
 * person gave the seat second, so the line says so also after the seat changed.
 */
export function secondedBy(line: BadgeLine, agents: readonly AgentView[]): string {
  const proposed = LIST.format(line.given.map((given) => ownName(agents, given.by)));
  const second = line.second;
  if (!second) return `Proposed by ${proposed}.`;
  return second.by === PERSON
    ? `Proposed by ${proposed}, seconded by you.`
    : `Proposed by ${proposed}, seconded by ${ownName(agents, second.by)}, the coordinator you seated.`;
}

/**
 * Return the line of a Breakthrough badge that waits, with who can second it, such as "Proposed as a breakthrough
 * by Quill. Waits for Maren, the coordinator you seated, or you." Without such a coordinator, it waits for the
 * person alone.
 */
export function proposedLine(line: BadgeLine, agents: readonly AgentView[]): string {
  const names = LIST.format(line.given.map((given) => ownName(agents, given.by)));
  const who = line.seconder
    ? `${ownName(agents, line.seconder)}, the coordinator you seated, or you`
    : 'you';
  return `Proposed as a breakthrough by ${names}. Waits for ${who}.`;
}

/** Return the post with a Breakthrough badge that the lab's answer builds on, when the answer itself has none. */
export function breakthroughUnder(view: AnswerView): PostView | null {
  if (hasBreakthrough(view.answer)) return null;
  return view.builds_on.find(hasBreakthrough) ?? null;
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
