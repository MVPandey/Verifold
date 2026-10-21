import type { Asker, Harness } from '../protocol/api.ts';

/** Dollars, as the desk and the call words write them: "$25", "$11.97". */
export { usd } from '../ui/call-words.ts';

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

const families: Readonly<Record<string, string>> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
};

/**
 * A model ID as a name: "claude-opus-5-5[1m]" is "Opus 5.5 (1M)", and
 * "gpt-6-astra" is "GPT-6 Astra". An alias such as "opus[1m]" shows its
 * family without a version, "Opus (1M)", because an alias moves to newer
 * models over time. Any other ID shows as it is.
 */
export function modelName(id: string): string {
  const oneM = /\[1m\]$/i.test(id);
  const bare = id.replace(/\[1m\]$/i, '');
  const context = oneM ? ' (1M)' : '';
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(bare);
  const family = claude ? families[claude[1] ?? ''] : families[bare];
  if (claude && family)
    return `${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}${context}`;
  if (family) return `${family}${context}`;
  const gpt = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/.exec(bare);
  if (gpt?.[1] && gpt[2])
    return `GPT-${gpt[1]} ${gpt[2].charAt(0).toUpperCase()}${gpt[2].slice(1)}${context}`;
  return id;
}
