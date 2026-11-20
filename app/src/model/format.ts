/** How the app writes times, durations, money, token counts, amounts, and the article before a number. */

/** Return the local time of day of an ISO time, as `14:04`. */
export function clock(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/**
 * Return the local time of an ISO time as `14:04`. When the time is not from today, the day comes first, as
 * `Nov 5 14:04`.
 */
export function dayClock(iso: string, now: Date): string {
  const at = new Date(iso);
  if (at.toDateString() === now.toDateString()) return clock(iso);
  return `${at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${clock(iso)}`;
}

/** Return the whole minutes from `from` to `to`, never less than zero. */
export function minutesBetween(from: string, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - new Date(from).getTime()) / 60_000));
}

/** Return a duration in minutes as `26 min`, `2 h`, or `1 h 5 min`. */
export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Return how long ago an ISO time was, as `just now`, `26 min ago`, or `1 h 5 min ago`. */
export function ago(iso: string, now: Date): string {
  const minutes = minutesBetween(iso, now);
  return minutes < 1 ? 'just now' : `${duration(minutes)} ago`;
}

/** Return a token count as `900`, `463k`, or `74M`. */
export function tokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** Return an amount in US dollars as `$0.37`. */
export function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * Return the article that English puts before a whole number: `an` before a number that is said with a vowel sound
 * first, such as 8, 11, 18, 80 to 89, and 8,000, and `a` before every other.
 */
export function article(count: number): 'a' | 'an' {
  const digits = String(Math.abs(Math.trunc(count)));
  const lead = digits.slice(0, digits.length % 3 || 3);
  return lead.startsWith('8') || lead === '11' || lead === '18' ? 'an' : 'a';
}

/**
 * Return a decimal as the person reads it on the lab's page: at most two digits after the point for a value of 1 or
 * more, and four significant digits at most for a value below 1, rounded half away from zero, with no zeros at the
 * end. `119.7695` reads `119.77`, `42.840` reads `42.84`, and `0.123456` reads `0.1235`. A text that is no plain
 * decimal comes back as it is. The record and the thread keep the exact value.
 */
export function readable(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return value;
  const [, sign = '', whole = '0', part = ''] = match;
  const first = part.search(/[1-9]/);
  if (BigInt(whole) === 0n && first < 0) return '0';
  const keep = BigInt(whole) > 0n ? 2 : first + 4;
  let digits = BigInt(`${whole}${part}`);
  let scale = part.length;
  if (scale > keep) {
    const divisor = 10n ** BigInt(scale - keep);
    const rest = digits % divisor;
    digits = digits / divisor + (rest * 2n >= divisor ? 1n : 0n);
    scale = keep;
  }
  const text = digits.toString().padStart(scale + 1, '0');
  const fraction = text.slice(text.length - scale).replace(/0+$/, '');
  return `${sign}${text.slice(0, text.length - scale)}${fraction ? `.${fraction}` : ''}`;
}
