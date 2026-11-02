/**
 * The lab's idea map, and the draw of long shots from it: pure functions, with
 * no lab and no model. An idea is a short phrase from a paper or from lab
 * work. Verifold draws combinations of ideas itself, and agents judge them.
 * An idea counts as the same idea only with the exact same text.
 */
import { object } from '../board.ts';
import { longShotLimits, readingLimits } from '../lab-tools.ts';

export interface Idea {
  /** `i-N`. */
  readonly id: string;
  readonly text: string;
  /** The papers on the reading map that hold it. Empty: it comes from lab work. */
  readonly sources: readonly string[];
  /** The lab tried it. */
  readonly tried: boolean;
  readonly by: string;
  readonly at: string;
}

/** A saved idea, or null. A harness can write in the project, so every field is checked. */
export function parseIdea(value: unknown): Idea | null {
  const entry = object(value);
  return entry &&
    typeof entry.id === 'string' &&
    /^i-[1-9]\d{0,5}$/.test(entry.id) &&
    typeof entry.text === 'string' &&
    entry.text &&
    typeof entry.by === 'string' &&
    typeof entry.at === 'string' &&
    !Number.isNaN(Date.parse(entry.at))
    ? {
        id: entry.id,
        text: entry.text.slice(0, readingLimits.idea),
        sources: (Array.isArray(entry.sources) ? entry.sources : [])
          .filter(
            (item): item is string =>
              typeof item === 'string' && /^s-[1-9]\d{0,5}$/.test(item),
          )
          .slice(0, readingLimits.sourcesPerIdea),
        tried: entry.tried === true,
        by: entry.by.slice(0, 20),
        at: entry.at,
      }
    : null;
}

/**
 * The map with one idea more, or with its source and its tried flag on the
 * idea that has the same text. A full map keeps the ideas that it has and
 * takes no new one: the caller reads the same list back.
 */
export function withIdea(
  ideas: readonly Idea[],
  fields: Pick<Idea, 'text' | 'tried' | 'by' | 'at'> & {
    readonly source?: string;
  },
): readonly Idea[] {
  const { source, ...rest } = fields;
  const sources = source ? [source] : [];
  const same = ideas.find((idea) => idea.text === fields.text);
  if (same)
    return ideas.map((idea) =>
      idea === same
        ? {
            ...idea,
            tried: idea.tried || fields.tried,
            sources: [...new Set([...idea.sources, ...sources])].slice(
              0,
              readingLimits.sourcesPerIdea,
            ),
          }
        : idea,
    );
  if (ideas.length >= readingLimits.ideas) return ideas;
  const last = Math.max(0, ...ideas.map((idea) => Number(idea.id.slice(2))));
  return [...ideas, { ...rest, id: `i-${last + 1}`, sources }];
}

/** A combination's key: the same ideas in any order give the same key. */
export function combinationKey(ideas: readonly Idea[]): string {
  return ideas
    .map((idea) => idea.id)
    .sort()
    .join('+');
}

/**
 * Up to `count` different combinations of `longShotLimits.size` ideas, drawn
 * at random. A combination of only tried ideas is no long shot, so the draw
 * skips it. Few ideas can hold fewer combinations than `count`, so the tries
 * are bounded. `random` gives a number from 0 up to 1, as `Math.random` does.
 * `skip` holds the keys of earlier draws.
 */
export function drawCombinations(
  ideas: readonly Idea[],
  count: number,
  random: () => number,
  skip: ReadonlySet<string> = new Set(),
): readonly (readonly Idea[])[] {
  if (ideas.length < longShotLimits.size) return [];
  const drawn = new Map<string, readonly Idea[]>();
  for (let tries = 0; tries < count * 50 && drawn.size < count; tries++) {
    const pool = [...ideas];
    const picked = Array.from({ length: longShotLimits.size }, () =>
      pool.splice(Math.floor(random() * pool.length), 1),
    ).flat();
    const key = combinationKey(picked);
    if (!skip.has(key) && picked.some((idea) => !idea.tried))
      drawn.set(key, picked);
  }
  return [...drawn.values()];
}

/** The rank of each value in a ranking, from 1. Equal values share a rank. */
function ranks(values: readonly number[]): readonly number[] {
  return values.map(
    (value) => 1 + values.filter((other) => other > value).length,
  );
}

/**
 * The candidates, best first, by reciprocal rank fusion (k = 60) on two
 * rankings: how much sense a candidate makes, and how few papers already
 * combine its ideas. A candidate must do well on both to come first. Ties keep
 * their order.
 */
export function rankCandidates<
  T extends { readonly sense: number; readonly prior: number },
>(candidates: readonly T[]): readonly T[] {
  const sense = ranks(candidates.map((candidate) => candidate.sense));
  const rare = ranks(candidates.map((candidate) => -candidate.prior));
  const fused = candidates.map(
    (candidate, index) =>
      [
        candidate,
        1 / (60 + (sense[index] ?? 0)) + 1 / (60 + (rare[index] ?? 0)),
      ] as const,
  );
  return [...fused].sort((a, b) => b[1] - a[1]).map(([candidate]) => candidate);
}
