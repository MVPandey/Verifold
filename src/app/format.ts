import type { Asker, Harness } from '../protocol/api.ts';

/** Dollars, as the desk and the call words write them: "$25", "$11.97". */
export { usd } from '../ui/call-words.ts';
/** Durations and deadlines, in the words that the terminal uses too. */
export { span, since, due } from '../ui/lab-lines.ts';

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

/** A text cut to `max` characters, with "…" at the cut. */
export function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Who wrote a post, as a name: "You", an agent's handle, or "Verifold". */
export function authorOf(post: {
  readonly author: string;
  readonly handle: string | null;
}): string {
  return post.author === 'person' ? 'You' : (post.handle ?? 'Verifold');
}
