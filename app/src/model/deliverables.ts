/** What the lab page says about the person's deliverables: the counts, each state, and each offer. */

import type { AgentView, Deliverable, DeliverableOffer, LabView, RerunLine } from '../api/types.ts';
import { authorName } from './agents.ts';
import type { Tab } from './coordinator.ts';
import { dayClock } from './format.ts';

/** The most characters in a deliverable's sentence, as `MAX_SENTENCE` in the server's `protocol/deliverables.py`. */
export const MAX_SENTENCE = 300;

/** The most deliverables that a lab has at one time, as `MAX_DELIVERABLES` in the server. */
export const MAX_DELIVERABLES = 20;

/** One count of the line that opens the panel, such as 1 and "with no file yet". */
export interface Count {
  readonly count: number;
  readonly label: string;
}

/**
 * Return the counts of the deliverables by state, in the order that the line shows them. The count of the ones
 * where the person asked for changes is in the list only when it is above zero.
 */
export function deliverCounts(list: readonly Deliverable[]): readonly Count[] {
  const count = (state: Deliverable['state']): number =>
    list.filter((item) => item.state === state).length;
  const changes = count('changes_asked');
  return [
    { count: count('accepted'), label: 'accepted' },
    { count: count('offered'), label: 'offered' },
    ...(changes > 0 ? [{ count: changes, label: 'with changes asked' }] : []),
    { count: count('none'), label: 'with no file yet' },
  ];
}

/**
 * Return the line that the close banner adds about the deliverables, or `null` when the person stated none. It
 * states counts only: the agents can close a lab whatever the counts are.
 */
export function deliverLine(list: readonly Deliverable[]): string | null {
  if (list.length === 0) return null;
  const counts = deliverCounts(list)
    .map((item) => `${item.count} ${item.label}`)
    .join(', ');
  return `Your deliverables: ${counts}.`;
}

/** Return the one state of a deliverable in words, with the time of the person's decision when it has one. */
export function stateLine(item: Deliverable, now: Date): string {
  const at = item.decided_at ? ` at ${dayClock(item.decided_at, now)}` : '';
  switch (item.state) {
    case 'accepted':
      return `Accepted by you${at}`;
    case 'offered':
      return 'Offered, not accepted yet';
    case 'changes_asked':
      return `You asked for changes${at}`;
    case 'none':
      return 'No file yet';
  }
}

/** Return who offered a file and when, such as "Offered by Maren. Revised 12 times, last at 03:10." */
export function offerLine(
  offer: DeliverableOffer,
  agents: readonly AgentView[],
  now: Date,
): string {
  const at = dayClock(offer.at, now);
  const when =
    offer.revised === 0
      ? `Written at ${at}`
      : `Revised ${offer.revised === 1 ? 'once' : `${offer.revised} times`}, last at ${at}`;
  return `Offered by ${authorName(agents, offer.by)}. ${when}.`;
}

/** Return whether a text is a new sentence for a deliverable: it has words, and it is not the sentence that stands. */
export function isNewSentence(text: string, standing = ''): boolean {
  const line = text.trim();
  return line !== '' && line !== standing;
}

/**
 * Return what the person decided about one offer, in words: the offer waits, the person asked for changes, or the
 * person's acceptance of it stands.
 */
export function offerState(offer: DeliverableOffer, now: Date): string {
  const at = offer.decided_at ? ` at ${dayClock(offer.decided_at, now)}` : '';
  switch (offer.state) {
    case 'accepted':
      return `Accepted by you${at}`;
    case 'changes_asked':
      return `You asked for changes${at}`;
    case 'waiting':
      return 'Waits for your decision';
  }
}

/** Return whether the author of an offer left the lab, so that nobody hears a request for changes to it. */
export function authorLeft(offer: DeliverableOffer, agents: readonly AgentView[]): boolean {
  return agents.some((view) => view.agent.id === offer.by && view.left !== null);
}

/**
 * What a form needs from the lab to say what its change does: whether an agent says that the lab is done or the
 * agents closed it, whether it is out of time, and the last post about a change.
 */
export type LabNow = Pick<LabView, 'state' | 'out_of_time' | 'deliverables_told_at'> & {
  /** The reruns that are wanted in the lab. An offer has files, so an agent can rerun it as any result. */
  readonly reruns_wanted?: readonly RerunLine[];
};

/** How long after a post about a new sentence or a removal the next such change sends no post, as `TOLD_WINDOW` in the server. */
const TOLD_WINDOW_MS = 60_000;

/** What a hint adds for a post in a lab that is out of time: no turn starts until the lab has time. */
const LATER = ' The lab is out of time: the agents get the post when the lab has time again.';

/**
 * Return what a new deliverable does to the lab. It is new work, so it ends a close that one agent posted, and it
 * opens a lab that the agents closed.
 */
export function addHint(lab: LabNow): string {
  const later = lab.out_of_time ? LATER : '';
  if (lab.state === 'closing') {
    return `An agent says that the lab is done. Adding this ends that close, and the lab goes on.${later}`;
  }
  if (lab.state === 'closed')
    return `The agents closed the lab. Adding this opens the lab again.${later}`;
  return `The agents get a post about it.${later}`;
}

/**
 * Return what a new sentence or a removal does to the lab. It sends no post while a close stands, and none when a
 * post about such a change went out in the last minute. The agents then read the change when they read the board.
 */
export function changeHint(lab: LabNow, now: Date): string {
  const read = 'The agents read it when they next read the board.';
  if (lab.state === 'closing') {
    return `An agent says that the lab is done, so this change sends no post, and that close stands. ${read}`;
  }
  if (lab.state === 'closed') {
    return `The agents closed the lab, so this change sends no post, and the lab stays closed. ${read}`;
  }
  const told = lab.deliverables_told_at;
  if (told !== null && now.getTime() - new Date(told).getTime() < TOLD_WINDOW_MS) {
    return `The agents were told of a change in the last minute, so this one sends no post. ${read}`;
  }
  return `The agents get a post about the change. The record keeps the earlier sentence.${lab.out_of_time ? LATER : ''}`;
}

/**
 * Return what a request for changes does to the lab. It asks an agent for more work, so it ends a close that one
 * agent posted, and it opens a lab that the agents closed.
 */
export function askHint(lab: LabNow): string {
  const later = lab.out_of_time ? LATER : '';
  if (lab.state === 'closing') {
    return `An agent says that the lab is done. Asking for changes ends that close, and the lab goes on.${later}`;
  }
  if (lab.state === 'closed') {
    return `The agents closed the lab. Asking for changes opens the lab again.${later}`;
  }
  return `The agent gets it as a reply to its offer.${later}`;
}

/** Return the question that the page asks before it removes a deliverable. It names an acceptance that stands. */
export function removeQuestion(item: Deliverable): string {
  const accepted = item.state === 'accepted' ? ' You accepted an offer for it.' : '';
  return `Remove this deliverable?${accepted} Its offers stay as posts.`;
}

/**
 * Return the hint under the reply box of the thread of a deliverable's offers: who gets the person's post. It
 * goes to the agents that offered files there or watch the thread. When none of them is in the lab, it goes to
 * every agent that is not on call, and only then it ends a close.
 */
export function offersReplyHint(
  reaches: readonly string[],
  agents: readonly AgentView[],
  state: LabView['state'],
): string {
  if (reaches.length === 0) {
    const effect =
      state === 'closed'
        ? ' It opens the lab again.'
        : state === 'closing'
          ? ' It ends the close, and the lab goes on.'
          : '';
    return `No agent that offered files here or watches this thread is in the lab, so every agent that is not on call gets your post.${effect}`;
  }
  const names = reaches.map((id) => authorName(agents, id)).join(', ');
  const effect =
    state === 'closed' ? ' The lab stays closed.' : state === 'closing' ? ' The close stands.' : '';
  return `Your post goes to ${names}: the agents that offered files here or watch this thread.${effect}`;
}

/** One line under a deliverable about other work in its thread, with the post that the line links to. */
export interface ThreadFact {
  readonly text: string;
  readonly post: string;
}

/**
 * Return what else is open in the thread of a deliverable's offers, one line for each post: a dispute of a post
 * that is not one of the offers above, an ask without an answer, and a rerun that is wanted for such a post.
 */
export function threadFacts(
  item: Deliverable,
  wanted: readonly RerunLine[],
): readonly ThreadFact[] {
  const shown = new Set(item.offers.map((offer) => offer.post));
  const reruns = wanted.filter((line) => line.thread === item.thread && !shown.has(line.post));
  return [
    ...item.disputed.map((post) => ({ text: 'An agent disputes a post in the thread', post })),
    ...item.open_asks.map((post) => ({ text: 'A question in the thread has no answer', post })),
    ...reruns.map((line) => ({
      text:
        line.taken_by.length > 0
          ? 'An agent took the rerun of a post in the thread'
          : 'A rerun of a post in the thread is wanted',
      post: line.post,
    })),
  ];
}

/** Return the line that unfolds the removed deliverables that have offers, such as "1 removed deliverable with offers". */
export function removedHeading(count: number): string {
  return `${count} removed ${count === 1 ? 'deliverable' : 'deliverables'} with offers`;
}

/** The panel that is docked beside the wall: a tab of the panel for the coordinator, the deliverables, or none. */
export type Docked = Tab | 'deliver' | null;

/**
 * Return whether a panel is docked, so that the page makes room for it. A tab of the panel for the coordinator
 * shows only while an agent holds the coordinator seat.
 */
export function isDocked(panel: Docked, hasCoordinator: boolean): boolean {
  return panel === 'deliver' || (panel !== null && hasCoordinator);
}

/**
 * Return what the reruns and checks of an offer say, in a few words, or `null` when there is nothing to say: a
 * rerun is wanted, an agent took it, an independent rerun held the offer up, or an agent's check holds. A check
 * that failed shows as a dispute, with its link.
 */
export function rerunFact(offer: DeliverableOffer, wanted: readonly RerunLine[]): string | null {
  const line = wanted.find((item) => item.post === offer.post);
  if (line) return line.taken_by.length > 0 ? 'An agent took its rerun' : 'A rerun is wanted';
  if (offer.standing === 'held_up') return 'Held up by an independent rerun';
  return offer.standing === 'checked' ? 'Checked by an agent' : null;
}
