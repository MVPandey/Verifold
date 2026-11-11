import type { LabView } from '../api/types.ts';
import { clock, duration, minutesBetween } from './format.ts';

/** The longest time that the person can give a lab at once, as the server allows: one week. */
export const MAX_MINUTES = 7 * 24 * 60;

/** Return the lab's clock for the top bar, such as "26 min of 1 h", "Running, 26 min", or "Out of time". */
export function clockLine(lab: LabView, now: Date): string {
  if (lab.out_of_time) return 'Out of time';
  const run = duration(minutesBetween(lab.opened_at, now));
  if (lab.ends_at === null) return `Running, ${run}`;
  return `${run} of ${duration(minutesBetween(lab.opened_at, new Date(lab.ends_at)))}`;
}

/** Return when the lab ends, in one sentence. */
export function endLine(lab: LabView, now: Date): string {
  if (lab.ends_at === null) return 'No time limit.';
  if (lab.out_of_time) return 'Out of time. The agents wait until you give the lab more time.';
  return `Ends at ${clock(lab.ends_at)}, in ${duration(minutesLeft(lab, now))}.`;
}

/** Return the minutes to send so that the lab gets `add` more minutes than it has left. */
export function moreTime(lab: LabView, add: number, now: Date): number {
  return Math.min(MAX_MINUTES, minutesLeft(lab, now) + add);
}

function minutesLeft(lab: LabView, now: Date): number {
  if (lab.ends_at === null || lab.out_of_time) return 0;
  return Math.max(0, Math.ceil((new Date(lab.ends_at).getTime() - now.getTime()) / 60_000));
}
