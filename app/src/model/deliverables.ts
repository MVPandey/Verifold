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

/** What a form needs from the lab to say what its change does: whether a close stands, and the last post about a change. */
export type LabNow = Pick<LabView, 'close' | 'deliverables_told_at'> & {
  /** The reruns that are wanted in the lab. An offer has files, so an agent can rerun it as any result. */
  readonly reruns_wanted?: readonly RerunLine[];
};

/** How long after a post about a new sentence or a removal the next such change sends no post, as `TOLD_WINDOW` in the server. */
const TOLD_WINDOW_MS = 60_000;

/** Return what a new deliverable does to the lab. In a lab that the agents closed, it opens the lab again. */
export function addHint(lab: LabNow): string {
  return lab.close
    ? 'The agents said the lab is done. Adding this opens the lab again.'
    : 'The agents get a post about it.';
}

/**
 * Return what a new sentence or a removal does to the lab. It sends no post while a close stands, and none when a
 * post about such a change went out in the last minute. The agents then read the change when they read the board.
 */
export function changeHint(lab: LabNow, now: Date): string {
  if (lab.close) {
    return 'The agents said the lab is done, so this change sends no post and the lab stays closed. The agents read it when they next read the board.';
  }
  const told = lab.deliverables_told_at;
  if (told !== null && now.getTime() - new Date(told).getTime() < TOLD_WINDOW_MS) {
    return 'The agents were told of a change in the last minute, so this one sends no post. They read it when they next read the board.';
  }
  return 'The agents get a post about the change. The record keeps the earlier sentence.';
}

/** Return what a request for changes does to the lab. In a lab that the agents closed, it opens the lab again. */
export function askHint(lab: LabNow): string {
  return lab.close
    ? 'The agents said the lab is done. Asking for changes opens the lab again.'
    : 'The agent gets it as a reply to its offer.';
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
