import type { LabView } from '../api/types.ts';
import { clock, duration, minutesBetween } from './format.ts';

/** The longest time that the person can give a lab at once, as the server allows: one week. */
export const MAX_MINUTES = 7 * 24 * 60;

/** Return the lab's state for the header, such as "Running, 26 min" or "Out of time". */
export function runStatus(lab: LabView, now: Date): string {
  return lab.out_of_time
    ? 'Out of time'
    : `Running, ${duration(minutesBetween(lab.opened_at, now))}`;
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
