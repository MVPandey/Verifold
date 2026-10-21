import type { Asker, Harness } from '../protocol/api.ts';

/** Dollars: whole amounts without cents, others with two decimals. */
export function usd(value: number): string {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

const minute = 60_000;

/** A duration in plain words: "40 s", "6 min", "1 h 20 min", "3 days". */
export function span(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / minute);
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))} s`;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

/** Since a time, as a duration: "6 min". */
export function since(at: string, now: number): string {
  return span(now - Date.parse(at));
}

/**
 * A deadline. Within the next six days, the weekday and time: "Fri 18:00".
 * Further out, in the past, or on today's weekday next week, the date as
 * well, so a weekday is never ambiguous: "Mon 27 Oct, 07:00".
 */
export function due(at: string, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const days = (date.getTime() - now) / (24 * 60 * minute);
  const nextWeek = date.getDay() === new Date(now).getDay() && days > 1;
  if (days >= 0 && days < 6 && !nextWeek)
    return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  const day = date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  return `${day}, ${time}`;
}

/** A clock time: "22:41". */
export function clock(at: string): string {
  return new Date(at).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Who asked: "claude-2 asked", "claude-2 and codex-2 asked". */
export function asked(askers: readonly Asker[]): string {
  const names = askers.map((asker) => asker.handle);
  if (!names.length) return 'Verifold asks';
  const last = names.pop() ?? '';
  return `${names.length ? `${names.join(', ')} and ` : ''}${last} asked`;
}

export function harnessName(harness: Harness): string {
  return harness === 'claude' ? 'Claude' : 'Codex';
}
