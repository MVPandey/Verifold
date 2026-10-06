import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResultsStore } from '../src/cli/results.ts';

const checks = ['Distances match.', 'Settled nodes fall by 30 percent.'];
const accepted = new Set(['results/summary.json', 'docs/report.md']);

await test('results take checks with accepted evidence, and the person rules and signs off', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'verifold-results-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ResultsStore(root);
  await store.load();
  assert.equal(store.read('bidir'), null);
  const report = (input: Record<string, unknown>): Promise<unknown> =>
    store.report('bidir', checks, accepted, {
      check: 1,
      result: 'passed',
      value: '0 mismatches in 1,800 queries',
      evidence: ['results/summary.json'],
      reason: 'The summary lists every query.',
      ...input,
    });
  // Evidence must be files that someone accepted. A check must exist.
  await assert.rejects(
    report({ evidence: ['results/draft.json'] }),
    /Name 1 to 10 accepted files as evidence/,
  );
  await assert.rejects(report({ evidence: [] }), /accepted files/);
  await assert.rejects(report({ check: 3 }), /Name a check from 1 to 2/);
  await assert.rejects(
    report({ result: 'maybe' }),
    /passed, failed, partial, or judgement/,
  );
  // A judgement asks the person one question.
  await assert.rejects(
    report({ check: 2, result: 'judgement' }),
    /question for the person/,
  );
  await report({});
  await report({
    check: 2,
    result: 'judgement',
    value: '7 of 9 groups gain 30 percent',
    question: 'Does a gain in 7 of 9 groups count as a pass?',
  });
  const saved = store.read('bidir');
  assert.deepEqual(
    saved?.checks.map((entry) => [entry.check, entry.result]),
    [
      [1, 'passed'],
      [2, 'judgement'],
    ],
  );
  // The file is private to the person.
  assert.equal(
    (await stat(join(root, '.verifold', 'results.json'))).mode & 0o777,
    0o600,
  );
  // Results of another direction do not count.
  assert.equal(store.read('alt'), null);

  // The answer waits for the person. Open judgements come first.
  await assert.rejects(
    store.propose('bidir', accepted, { statement: 'It works.', claims: [] }),
    /Give 1 to 12 claims/,
  );
  await assert.rejects(
    store.propose('bidir', accepted, {
      statement: 'It works.',
      claims: [{ text: 'Faster.', evidence: ['results/unaccepted.csv'] }],
    }),
    /accepted files or web addresses/,
  );
  await store.propose('bidir', accepted, {
    statement: 'Bidirectional search settles fewer nodes on small road graphs.',
    claims: [
      { text: 'Distances match.', evidence: ['results/summary.json'] },
      {
        text: 'Prior work agrees.',
        evidence: ['https://arxiv.org/abs/1504.05140'],
      },
    ],
  });
  await assert.rejects(
    store.decide('bidir', 'accepted', ''),
    /Settle the open judgements first/,
  );
  await assert.rejects(
    store.rule('bidir', 1, 'passed', 'Yes.'),
    /does not wait for your judgement/,
  );
  await assert.rejects(
    store.rule('bidir', 2, 'judgement', 'Yes.'),
    /Choose passed, partly passed, or failed/,
  );
  await store.rule('bidir', 2, 'partial', '7 of 9 is not all groups.');
  // A ruling is final: the coordinator cannot report the check again.
  await assert.rejects(report({ check: 2 }), /The person ruled on check 2/);
  await assert.rejects(
    store.decide('bidir', 'more', ' '),
    /note for the coordinator/,
  );
  const answer = await store.decide('bidir', 'accepted', '');
  assert.equal(answer.decision?.kind, 'accepted');
  // An accepted answer stays until the person asks for more work.
  await assert.rejects(
    store.propose('bidir', accepted, {
      statement: 'Again.',
      claims: [{ text: 'X.', evidence: [] }],
    }),
    /The person accepted the answer/,
  );
  await assert.rejects(
    store.decide('bidir', 'accepted', ''),
    /No answer waits/,
  );

  // A new store reads the same results.
  const again = new ResultsStore(root);
  await again.load();
  assert.equal(again.read('bidir')?.answer?.decision?.kind, 'accepted');
  assert.equal(again.read('bidir')?.checks[1]?.ruling?.result, 'partial');
  assert.match(
    await readFile(join(root, '.verifold', 'results.json'), 'utf8'),
    /"direction": "bidir"/,
  );
});
