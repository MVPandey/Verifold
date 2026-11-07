/** How the app writes times, durations, money, and token counts. */

/** Return the local time of day of an ISO time, as `14:04`. */
export function clock(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
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
