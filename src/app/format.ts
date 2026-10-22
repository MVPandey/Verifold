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

/** Month names that do not change with the browser's language: en-GB gives "Sept". */
const months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * A time with its day: "today at 19:40", "on 19 Oct at 19:40", or "on 19 Oct
 * 2025 at 19:40" in another year. `now`: the app's clock. Without it, the
 * time when the page renders, and the app's clock renders every page again
 * every 30 seconds, so "today" changes at midnight.
 */
export function dayClock(at: string, now = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString())
    return `today at ${clock(at)}`;
  const year =
    date.getFullYear() === today.getFullYear() ? '' : ` ${date.getFullYear()}`;
  return `on ${date.getDate()} ${months[date.getMonth()] ?? ''}${year} at ${clock(at)}`;
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
 * A model ID, read once: its family and its name as the app shows it.
 * "claude-opus-5-5[1m]" is Opus, "Opus 5.5 (1M)", and "gpt-6-astra" is
 * "GPT-6 Astra". A Claude family counts wherever it stands in a Claude ID,
 * so a Bedrock ID such as "us.anthropic.claude-opus-5-5-v1:0" and an older
 * one such as "claude-3-opus-20240229" are Opus too. An alias such as
 * "opus[1m]" shows no version, "Opus (1M)", because an alias moves to newer
 * models over time. Any other ID is a family of its own and shows as it is.
 */
function readModel(id: string): {
  readonly family: string;
  readonly name: string;
} {
  const context = /\[1m\]$/i.test(id) ? ' (1M)' : '';
  const bare = id.replace(/\[1m\]$/i, '');
  // The version comes after the family in "claude-opus-5-5", and before it in "claude-3-5-sonnet".
  const after =
    /claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(bare);
  const before = /claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku|fable)/.exec(
    bare,
  );
  const family = families[bare]
    ? bare
    : bare.includes('claude')
      ? (after?.[1] ??
        before?.[3] ??
        /(opus|sonnet|haiku|fable)/.exec(bare)?.[1])
      : undefined;
  if (family) {
    const [major, minor] = after
      ? [after[2], after[3]]
      : before
        ? [before[1], before[2]]
        : [];
    const version = major ? ` ${major}${minor ? `.${minor}` : ''}` : '';
    return {
      family,
      name: `${families[family] ?? family}${version}${context}`,
    };
  }
  const gpt = /^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/.exec(bare);
  return {
    family: bare,
    name:
      gpt?.[1] && gpt[2]
        ? `GPT-${gpt[1]} ${gpt[2].charAt(0).toUpperCase()}${gpt[2].slice(1)}${context}`
        : id,
  };
}

/** A model ID as a name, such as "Opus 5.5 (1M)". */
export function modelName(id: string): string {
  return readModel(id).name;
}

/**
 * An agent's model by name. When the harness reports a model of another
 * family than the one that Verifold asked for, the name says so: "Sonnet
 * 5.5, asked for Opus".
 */
export function agentModelName(
  model: string,
  requested: string | null | undefined,
): string {
  const shown = readModel(model);
  const asked = requested ? readModel(requested) : null;
  return asked && asked.family !== shown.family
    ? `${shown.name}, asked for ${asked.name}`
    : shown.name;
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
