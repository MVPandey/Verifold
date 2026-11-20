import type {
  ActionView,
  AgentView,
  AllowanceTerms,
  AllowanceView,
  LabView,
  Missed,
  Post,
  PostView,
} from '../api/types.ts';
import { authorName } from './agents.ts';
import { dayClock, duration, minutesBetween } from './format.ts';

/** An action post as the server sends it. */
export type ActionPost = Extract<Post, { kind: 'action' }>;

/** Return whether a post that waits for the person is an action. */
export function isAction(item: PostView): item is PostView & { readonly post: ActionPost } {
  return item.post.kind === 'action';
}

/**
 * Return an amount in an allowance's unit, as the record holds it. A unit of one sign, such as `$`, comes first, as
 * `$4.25`. Any other unit comes after the number, as `4.25 USD`. The board knows no currency, so the app rounds
 * nothing.
 */
export function amount(value: string, unit: string): string {
  const sign = [...unit].length === 1 && !/[\p{L}\p{N}]/u.test(unit);
  return sign ? `${unit}${value}` : `${value} ${unit}`;
}

/**
 * Return `left` minus `taken` as a decimal string, exactly, for the amounts that an allowance holds. The server
 * sends each amount with at most six digits after the point.
 */
export function minus(left: string, taken: string): string {
  const scale = 1_000_000n;
  const micros = (text: string): bigint => {
    const [whole = '0', part = ''] = text.split('.');
    return BigInt(whole) * scale + BigInt(part.padEnd(6, '0').slice(0, 6));
  };
  const result = micros(left) - micros(taken);
  const sign = result < 0n ? '-' : '';
  const size = result < 0n ? -result : result;
  const part = (size % scale).toString().padStart(6, '0').replace(/0+$/, '');
  return `${sign}${(size / scale).toString()}${part ? `.${part}` : ''}`;
}

/** Return the share of an allowance's total that it allowed, from 0 to 100, for its meter. */
export function meterPercent(view: AllowanceView): number {
  const total = Number(view.terms.total);
  return total > 0 ? Math.min(100, (Number(view.drawn) / total) * 100) : 0;
}

/** Return the holder of an allowance or the author of an action by name. */
export function holderName(agents: readonly AgentView[], id: string): string {
  return authorName(agents, id);
}

/**
 * Return the heading of an allowance: what the holder may do, in the person's words. A purpose that starts with a
 * word in capitals keeps it, and any other starts in lower case after "may".
 */
export function allowanceHeading(terms: AllowanceTerms, agents: readonly AgentView[]): string {
  const purpose = terms.purpose;
  const plain = /^[A-Z][a-z]/.test(purpose)
    ? `${purpose.charAt(0).toLowerCase()}${purpose.slice(1)}`
    : purpose;
  return `${holderName(agents, terms.holder)} may ${plain}`;
}

/** Return the facts of a draft, one line each: the bound for one action, the total, the end, and the check. */
export function draftFacts(terms: AllowanceTerms, now: Date): readonly string[] {
  const unit = terms.unit;
  return [
    `Up to ${amount(terms.per_action, unit)} an action`,
    `Up to ${amount(terms.total, unit)} in all`,
    `Until ${dayClock(terms.ends_at, now)}`,
    ...(terms.check_above
      ? [`Above ${amount(terms.check_above, unit)}, a check by another agent first`]
      : []),
  ];
}

/** Return the line under an allowance's heading: what it allowed, its bound for one action, and its end. */
export function usedLine(view: AllowanceView, now: Date): string {
  const unit = view.terms.unit;
  return [
    `${amount(view.drawn, unit)} of ${amount(view.terms.total, unit)} used`,
    `up to ${amount(view.terms.per_action, unit)} an action`,
    `until ${dayClock(view.terms.ends_at, now)}`,
  ].join(' · ');
}

/** The words of each state of an allowance that is no draft, for its kicker. */
const ALLOWANCE_STATES: Readonly<Record<AllowanceView['state'], string>> = {
  draft: 'not started',
  in_force: 'in force',
  over: 'its end time came',
  ended: 'you ended it',
  replaced: 'a newer one replaced it',
};

/** Return the kicker of an allowance, such as "Allowance · in force". */
export function allowanceKicker(view: AllowanceView): string {
  return `Allowance · ${view.stopped ? 'stopped at its total' : ALLOWANCE_STATES[view.state]}`;
}

/** Return the note that says what the board does and does not do about an allowance. */
export function recordedNote(name: string): string {
  return `${name} holds the key. The board counts what ${name} declares and stops ${name} at the limit.`;
}

/** Return what the person reads about an allowance whose actions passed its total. */
export function stoppedLine(name: string): string {
  return `${name}’s actions passed the total, so the board stopped ${name}. End this allowance or confirm a new one to let ${name} go on.`;
}

/** The mark of each state of an action in an allowance's list, with its tone. */
export function actionMark(action: ActionView): { readonly text: string; readonly tone: string } {
  switch (action.state) {
    case 'allowed':
      return action.receipt ? { text: 'done', tone: 'good' } : { text: 'allowed', tone: 'turn' };
    case 'yes':
      return { text: 'you allowed it', tone: 'turn' };
    case 'no':
      return { text: 'you said no', tone: 'bad' };
    case 'waits':
      return { text: 'waits for you', tone: 'turn' };
    case 'missed':
      return { text: 'missed', tone: 'bad' };
  }
}

/** Return the amount of an action in an allowance's list: its real cost when a receipt came, or else its cost. */
export function actionAmount(action: ActionView, unit: string): string {
  return amount(action.real_cost ?? action.cost, unit);
}

/** What a request for an action says: its heading, its lines of facts, and when its offer ends. */
export interface RequestWords {
  readonly heading: string;
  readonly wants: string;
  readonly loses: string;
  readonly ends: string;
}

/**
 * Return the words of an action that waits for the person. `allowance` is the one that the action names, or `null`
 * when its seat held none in force.
 */
export function requestWords(
  item: PostView & { readonly post: ActionPost },
  allowance: AllowanceView | null,
  agents: readonly AgentView[],
  now: Date,
): RequestWords {
  const { post } = item;
  const name = holderName(agents, post.author);
  const unit = allowance?.terms.unit ?? '';
  const cost = unit ? amount(post.cost, unit) : post.cost;
  const undo = post.undoable ? 'It can be undone.' : 'It cannot be undone.';
  const why =
    post.needs === 'per_action' && allowance
      ? `Your allowance is ${amount(allowance.terms.per_action, unit)} an action.`
      : post.needs === 'total' && allowance
        ? `Your allowance has ${amount(minus(allowance.terms.total, allowance.drawn), unit)} left of ${amount(allowance.terms.total, unit)}.`
        : `${name} holds no allowance in force.`;
  const left = Math.max(
    0,
    Math.ceil((new Date(post.offer_ends).getTime() - now.getTime()) / 60_000),
  );
  return {
    heading:
      post.needs === 'none' ? 'An action without an allowance' : 'An action above your limit',
    wants: `${name} wants to act: ${post.text}`,
    loses: `It can lose ${cost}. ${why} ${undo}`,
    ends: `The offer ends at ${dayClock(post.offer_ends, now)}, in ${duration(left)}.`,
  };
}

/** Return the IDs of the actions among the posts that wait for the person. */
export function actionIds(needs: readonly PostView[]): ReadonlySet<string> {
  return new Set(needs.filter(isAction).map((item) => item.post.id));
}

/** Return the allowance that an action names, as the lab shows it, or `null`. */
export function allowanceOf(lab: LabView, post: ActionPost): AllowanceView | null {
  return (lab.allowances ?? []).find((view) => view.allowance === post.allowance) ?? null;
}

/** Return the allowances that the lab page shows: the drafts that wait, and each one in force or stopped. */
export function shownAllowances(lab: LabView): readonly AllowanceView[] {
  return (lab.allowances ?? []).filter(
    (view) => view.state === 'draft' || view.state === 'in_force' || view.stopped,
  );
}

/** Return the allowances whose actions passed their totals, which wait for the person. */
export function stoppedAllowances(lab: LabView): readonly AllowanceView[] {
  return (lab.allowances ?? []).filter((view) => view.stopped);
}

/** Return the line of the fold of what the person missed: how many, and that nothing was done. */
export function missedHeading(missed: readonly Missed[]): string {
  return `Missed while you were away · ${String(missed.length)}`;
}

/** The line under that heading. */
export const NOTHING_DONE = 'Their time ended before you answered. Nothing was done.';

/** Return one row of what the person missed: who, what, and when it stopped waiting. */
export function missedRow(item: Missed, agents: readonly AgentView[], now: Date): string {
  return `${holderName(agents, item.agent)}: ${item.what}. Ended ${dayClock(item.ended_at, now)}, after ${duration(minutesBetween(item.since, new Date(item.ended_at)))}.`;
}

/** Return the line that says when an ask stops waiting for the person, or `null` for one that waits until an answer. */
export function askEnds(post: Post, now: Date): string | null {
  if (post.kind !== 'ask' || !post.ends_at) return null;
  const left = Math.max(0, Math.ceil((new Date(post.ends_at).getTime() - now.getTime()) / 60_000));
  return `It waits until ${dayClock(post.ends_at, now)}, in ${duration(left)}.`;
}
