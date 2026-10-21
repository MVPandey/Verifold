import type { Asker, Harness, StepCounts } from '../protocol/api.ts';

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

/** A deadline: "Fri 18:00" within a week, else "Oct 30 18:00". */
export function due(at: string, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const days = (date.getTime() - now) / (24 * 60 * minute);
  const day =
    days >= 0 && days < 6.5
      ? date.toLocaleDateString('en-US', { weekday: 'short' })
      : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${day} ${time}`;
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

const kinds: readonly [keyof StepCounts, string, string][] = [
  ['search', 'search', 'searches'],
  ['page', 'page', 'pages'],
  ['read', 'file read', 'files read'],
  ['command', 'command', 'commands'],
  ['edit', 'edit', 'edits'],
  ['run', 'run', 'runs'],
  ['post', 'post', 'posts'],
  ['helper', 'helper', 'helpers'],
  ['other', 'other step', 'other steps'],
];

/** A folded turn: "Worked 6 min · 4 searches · 3 pages". Running: "Working · 2 commands". */
export function worked(
  counts: StepCounts,
  startedAt: string,
  endedAt: string | null,
  now: number,
): string {
  const parts = kinds
    .filter(([kind]) => counts[kind] > 0)
    .map(
      ([kind, one, many]) =>
        `${counts[kind]} ${counts[kind] === 1 ? one : many}`,
    );
  const head =
    endedAt === null
      ? `Working for ${since(startedAt, now)}`
      : `Worked ${span(Date.parse(endedAt) - Date.parse(startedAt))}`;
  return [head, ...parts].join(' · ');
}
