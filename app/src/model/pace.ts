import { PERSON } from '../api/types.ts';
import type { AgentView, CapLine, PauseLine, SeatLimits } from '../api/types.ts';
import { dayClock, tokens } from './format.ts';

/** The most tokens that a limit per hour holds, as the server allows. */
export const MAX_TOKENS_PER_HOUR = 10 ** 12;

/** The tokens per hour of the coordinator's seat while the person sets no other number. */
export const DEFAULT_COORDINATOR_TOKENS = 10_000_000;

/** The percent of a window above which a seat counts as near its provider's limit, as the server counts it. */
export const NEAR_LIMIT = 80;

/** Return who set a pause or a limit: "you", or "the coordinator". */
function who(by: string): string {
  return by === PERSON ? 'you' : 'the coordinator';
}

/**
 * Return a seat's usage limit in one line, by its fullest window, such as "62% of the 5-hour limit, resets
 * 14:10". It is `null` when the harness reported none.
 */
export function limitsLine(limits: SeatLimits | null, now: Date): string | null {
  if (!limits) return null;
  const fullest = [...limits.windows].sort(
    (one, other) => other.used_percent - one.used_percent,
  )[0];
  const refused = limits.status === 'reached';
  if (!fullest) return refused ? 'The provider refuses its requests' : null;
  const resets = fullest.resets_at ? `, resets ${dayClock(fullest.resets_at, now)}` : '';
  const line = `${Math.round(fullest.used_percent)}% of the ${fullest.label} limit${resets}`;
  return refused ? `The provider refuses its requests: ${line}` : line;
}

/** Return whether a seat is near its provider's limit: a window above `NEAR_LIMIT`, or a provider that refuses it. */
export function nearLimit(limits: SeatLimits | null): boolean {
  if (!limits) return false;
  return limits.status === 'reached' || limits.windows.some((one) => one.used_percent > NEAR_LIMIT);
}

/** Return a pause in one line, such as "Paused by the coordinator until 04:30". */
export function pauseLine(pause: PauseLine, now: Date): string {
  const until = pause.until ? ` until ${dayClock(pause.until, now)}` : '';
  return `Paused by ${who(pause.by)}${until}`;
}

/** Return a seat's limit of tokens per hour in one line, such as "3M of its 10M tokens this hour". */
export function capLine(cap: CapLine): string {
  return `${tokens(cap.spent ?? 0)} of its ${tokens(cap.tokens_per_hour)} tokens this hour`;
}

/** Return the lab's limit of tokens per hour in one sentence, such as "Spent 3M of 10M tokens this hour." */
export function labCapLine(cap: CapLine | null): string {
  if (!cap) return 'No limit of tokens per hour for the lab.';
  const by = cap.by === PERSON ? '' : ' The coordinator set this limit.';
  return `Spent ${tokens(cap.spent ?? 0)} of ${tokens(cap.tokens_per_hour)} tokens this hour.${by}`;
}

/**
 * Return whether a seat's activity says already that a pause holds it, as Verifold's words for a seat that waits
 * for its pace do. A seat line then names the pause once.
 */
export function pauseTold(view: AgentView): boolean {
  const activity = view.activity;
  return (
    view.pause !== null &&
    view.pause !== undefined &&
    activity.state === 'waiting' &&
    activity.waits_for === 'pace' &&
    activity.detail.startsWith('Paused by')
  );
}

/**
 * Return the lines of a seat's pace and usage limits, in the order that the seat line shows them: its pause, its
 * provider's limit, and its limit of tokens per hour. A seat that left has none. With `told`, the seat's activity
 * says already that the pause holds it, so the line gives only the pause's end, when it has one.
 */
export function seatLines(view: AgentView, now: Date, told = false): readonly string[] {
  if (view.left) return [];
  const pause = view.pause
    ? told
      ? view.pause.until
        ? `Until ${dayClock(view.pause.until, now)}`
        : null
      : pauseLine(view.pause, now)
    : null;
  return [pause, limitsLine(view.limits, now), view.cap ? capLine(view.cap) : null].filter(
    (line) => line !== null,
  );
}

/**
 * Return the next time of day `hh:mm` on the person's clock after `now`, as an ISO time, or `null` for text that
 * is no such time.
 */
export function nextTime(text: string, now: Date): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at.toISOString();
}
