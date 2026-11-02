import test from 'node:test';
import assert from 'node:assert/strict';
import {
  combinationKey,
  drawCombinations,
  parseIdea,
  rankCandidates,
  withIdea,
  type Idea,
} from '../src/core/lab/ideas.ts';
import { longShotCount, shareLine, shareOf } from '../src/core/lab-share.ts';
import { longShotLimits, readingLimits } from '../src/core/lab-tools.ts';

const at = '2026-11-01T10:00:00.000Z';

/** A small seeded source, so a draw repeats. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function ideaList(count: number, tried = false): readonly Idea[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `i-${index + 1}`,
    text: `Idea ${index + 1}`,
    sources: [],
    tried,
    by: 'a-1',
    at,
  }));
}

await test('an idea joins the map once, by its exact text only', () => {
  const add = (
    ideas: readonly Idea[],
    text: string,
    more: { tried?: boolean; source?: string } = {},
  ): readonly Idea[] =>
    withIdea(ideas, { text, tried: false, by: 'a-1', at, ...more });
  const one = add([], 'Category residuals', { source: 's-1' });
  assert.deepEqual(
    one.map((idea) => [idea.id, idea.sources, idea.tried]),
    [['i-1', ['s-1'], false]],
  );
  // The same text adds its source and its tried flag. Other text is another idea.
  const same = add(one, 'Category residuals', { source: 's-2', tried: true });
  assert.equal(same.length, 1);
  assert.deepEqual(same[0]?.sources, ['s-1', 's-2']);
  assert.equal(same[0]?.tried, true);
  // A tried idea stays tried.
  assert.equal(add(same, 'Category residuals')[0]?.tried, true);
  assert.equal(add(same, 'category residuals').length, 2);
  // A source counts once, and an idea keeps a bounded list of them.
  const many = Array.from(
    { length: 20 },
    (_, index) => `s-${index + 1}`,
  ).reduce(
    (ideas, source) => add(ideas, 'Category residuals', { source }),
    one,
  );
  assert.equal(many[0]?.sources.length, readingLimits.sourcesPerIdea);
});

await test('a full map takes no new idea and still updates the ideas that it has', () => {
  const full = ideaList(readingLimits.ideas);
  const fields = { tried: true, by: 'a-1', at };
  assert.equal(withIdea(full, { ...fields, text: 'One more' }), full);
  assert.equal(
    withIdea(full, { ...fields, text: 'Idea 2' }).find(
      (idea) => idea.id === 'i-2',
    )?.tried,
    true,
  );
});

await test('an idea from a file keeps what is valid and drops what is not', () => {
  const good = {
    id: 'i-3',
    text: 'Region mixtures',
    sources: ['s-1', 'bad', 7],
    tried: 'yes',
    by: 'a-1',
    at,
  };
  assert.deepEqual(parseIdea(good), {
    id: 'i-3',
    text: 'Region mixtures',
    sources: ['s-1'],
    tried: false,
    by: 'a-1',
    at,
  });
  for (const bad of [
    null,
    { ...good, id: 'x' },
    { ...good, text: '' },
    { ...good, at: 'never' },
  ])
    assert.equal(parseIdea(bad), null);
});

await test('a draw repeats with its seed, and gives different combinations of different ideas', () => {
  const ideas = ideaList(8);
  const first = drawCombinations(ideas, 6, seeded(7));
  assert.deepEqual(first, drawCombinations(ideas, 6, seeded(7)));
  assert.notDeepEqual(first, drawCombinations(ideas, 6, seeded(8)));
  assert.equal(first.length, 6);
  for (const combination of first)
    assert.equal(new Set(combination).size, longShotLimits.size);
  assert.equal(new Set(first.map(combinationKey)).size, 6);
});

await test('a draw skips a combination of only tried ideas, and needs one idea that is new', () => {
  const tried = ideaList(5, true);
  assert.deepEqual(drawCombinations(tried, 6, seeded(1)), []);
  const one = [...tried, { ...ideaList(6)[5] } as Idea];
  const drawn = drawCombinations(one, 6, seeded(1));
  assert.ok(drawn.length);
  for (const combination of drawn)
    assert.ok(combination.some((idea) => !idea.tried));
});

await test('too few ideas draw nothing, few ideas draw what they hold, and earlier keys stay out', () => {
  assert.deepEqual(drawCombinations(ideaList(2), 6, seeded(1)), []);
  // Three ideas hold one combination, however often the draw tries.
  const once = drawCombinations(ideaList(3), 6, seeded(1));
  assert.equal(once.length, 1);
  assert.deepEqual(
    drawCombinations(
      ideaList(3),
      6,
      seeded(1),
      new Set(once.map(combinationKey)),
    ),
    [],
  );
});

await test('the order of a draw does not change its key', () => {
  const [a, b, c] = ideaList(3);
  assert.ok(a && b && c);
  assert.equal(combinationKey([c, a, b]), combinationKey([a, b, c]));
});

await test('ranking fuses both rankings with k = 60', () => {
  // Rank 5 on both beats rank 1 and rank 10 at k = 60. With a small k it would not.
  const priors = [9, 0, 1, 2, 4, 3, 5, 6, 7, 8];
  const candidates = priors.map((prior, index) => ({
    id: index,
    sense: 10 - index,
    prior,
  }));
  const ranked = rankCandidates(candidates).map((candidate) => candidate.id);
  assert.ok(ranked.indexOf(4) < ranked.indexOf(0));
  assert.equal(ranked[0], 1);
});

await test('a candidate must do well on both rankings, and ties keep their order', () => {
  const ranked = rankCandidates([
    { id: 'known', sense: 5, prior: 9 },
    { id: 'both', sense: 5, prior: 0 },
    { id: 'nonsense', sense: 1, prior: 0 },
  ]);
  assert.equal(ranked[0]?.id, 'both');
  // Equal values share a rank, so most candidates with no prior paper tie on it.
  assert.deepEqual(
    rankCandidates([
      { id: 'a', sense: 4, prior: 0 },
      { id: 'b', sense: 4, prior: 0 },
    ]).map((candidate) => candidate.id),
    ['a', 'b'],
  );
  assert.deepEqual(rankCandidates([]), []);
});

await test('the share of long shots becomes a number of directions', () => {
  assert.equal(shareOf(undefined), 'mixed');
  assert.equal(shareOf('far'), 'far');
  assert.equal(shareOf('wild'), null);
  assert.equal(longShotCount('close', 20), 0);
  assert.equal(longShotCount('mixed', 20), 5);
  assert.equal(longShotCount('mixed', 4), 1);
  // A small plan still gets one.
  assert.equal(longShotCount('mixed', 2), 1);
  assert.equal(longShotCount('far', 20), 10);
  assert.equal(longShotCount('far', 3), 2);
  assert.match(shareLine('mixed', 20), /about 5 of 20/);
  assert.match(shareLine('far', 8), /about 4 of 8/);
  assert.match(
    shareLine('close', 8),
    /no direction of your plan is a long shot/,
  );
});
