import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LongShots, type LongShotHost } from '../src/core/lab/long-shots.ts';
import { until } from './wait.ts';
import { planned, type Built, type Started } from './lab-step-fixture.ts';

const isJudge = (started: Started): boolean =>
  /\/\.verifold\/checks\/l-\d+$/.test(started.cwd);

const judgeOf = (built: Built): Started | undefined =>
  built.started.findLast((entry) => isJudge(entry));

async function ideas(built: Built, count: number): Promise<void> {
  for (let index = 1; index <= count; index++) {
    const reply = await built.call(0, 'verifold_idea', {
      text: `Idea number ${index}`,
      tried: index === 1,
    });
    assert.equal(reply.ok, true, reply.text);
  }
}

const judgment = (
  id: string,
  sense: number,
  prior: number,
): Record<string, unknown> => ({
  id,
  question: `Does ${id} beat the control on seed 2?`,
  sense,
  test: 'Run it on one seed.',
  cost: 'About 2 hours of GPU',
  prior,
  closest: 'none found',
});

async function ruledOut(built: Built): Promise<void> {
  const direction = built.view().directions[0]?.direction;
  assert.ok(direction);
  await writeFile(
    join(built.root, direction.workspace.path, 'failed.txt'),
    '0.1\n',
  );
  const reply = await built.call(0, 'verifold_post', {
    kind: 'ruled-out',
    title: 'Why the first line of work failed',
    why: 'Others can reuse what passed.',
    text: 'The line failed its bar.',
    artifacts: [{ type: 'file', path: 'failed.txt' }],
  });
  assert.equal(reply.ok, true, reply.text);
}

await test('the page holds each candidate with its judge and its search, from the record', async (t) => {
  const built = await planned(t);
  await ideas(built, 5);
  await built.call(0, 'verifold_source', {
    title: 'A paper on circles',
    url: 'https://example.org/circles',
    date: 'Oct 12, 2026',
    ideas: ['Region mixtures'],
  });
  await built.lab.drawAgain();
  await until(() => judgeOf(built) !== undefined);
  const judge = judgeOf(built);
  assert.ok(judge);
  assert.equal(built.reader().ideas()?.drawing, 'running');
  // A draw of the person has no author, so the session uses the main harness.
  assert.equal(built.reader().ideas()?.judge, 'claude');
  // A draw on record with no judgment yet is no failed draw.
  assert.deepEqual(built.reader().ideas()?.draws, []);
  const reply = await judge.tools.call(
    'verifold_judge',
    { candidates: [judgment('c-1', 5, 0), judgment('c-2', 1, 0)] },
    'judge-1',
  );
  assert.equal(reply.ok, true, reply.text);
  const page = built.reader().ideas() ?? assert.fail('no page');
  assert.equal(page.ideaCount, 6);
  assert.equal(page.ideas.filter((idea) => idea.tried).length, 1);
  assert.deepEqual(page.sources[0], {
    id: 's-1',
    title: 'A paper on circles',
    url: 'https://example.org/circles',
    date: 'Oct 12, 2026',
  });
  const [draw] = page.draws;
  assert.equal(draw?.by, 'person');
  assert.equal(draw?.judged, true);
  assert.equal(draw?.shots.length, 1);
  const shot = draw?.shots[0];
  assert.equal(shot?.question, 'Does c-1 beat the control on seed 2?');
  assert.equal(shot?.ideas.length, 3);
  assert.equal(shot?.sense, 5);
  assert.equal(shot?.prior, 0);
  assert.equal(shot?.closest, 'none found');
  // A draw of the person has no author, so the session uses the main harness.
  assert.equal(shot?.harness, 'claude');
  assert.ok(built.view().posts.find((post) => post.id === shot?.post)?.alien);
});

await test('a judged candidate survives a new load', async (t) => {
  const built = await planned(t);
  await ideas(built, 4);
  await built.lab.drawAgain();
  await until(() => judgeOf(built) !== undefined);
  const judge = judgeOf(built);
  assert.ok(judge);
  await judge.tools.call(
    'verifold_judge',
    { candidates: [judgment('c-1', 5, 2)] },
    'judge-1',
  );
  await built.lab.stopLongShots();
  const again = new LongShots({
    root: built.root,
    paused: () => true,
  } as unknown as LongShotHost);
  await until(async () => {
    await again.load(true);
    return again.draws()[0]?.posted?.length === 1 && again.state().stopped;
  });
  assert.equal(again.draws()[0]?.posted?.[0]?.prior, 2);
});

await test('Stop long shots ends the session and the next draw, and no agent stops', async (t) => {
  const built = await planned(t, { share: 'mixed' });
  await ideas(built, 4);
  await built.lab.drawAgain();
  await until(() => judgeOf(built) !== undefined);
  const judge = judgeOf(built);
  assert.ok(judge);
  const working = built.view().directions.map(({ status }) => status);
  await built.lab.stopLongShots();
  assert.equal(built.live.has(judge.id), false);
  assert.deepEqual(
    built.view().directions.map(({ status }) => status),
    working,
  );
  const page = built.reader().ideas();
  assert.equal(page?.stopped, true);
  assert.equal(page?.drawing, null);
  const judges = built.started.filter(isJudge).length;
  await ruledOut(built);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(built.started.filter(isJudge).length, judges);
  assert.equal(built.reader().ideas()?.drawing, null);
});

await test('a stop gives back the combinations of a draw with no judgment', async (t) => {
  const built = await planned(t);
  // Four ideas hold four combinations, and one draw takes them all.
  await ideas(built, 4);
  await built.lab.drawAgain();
  await until(() => judgeOf(built) !== undefined);
  await built.lab.stopLongShots();
  await built.lab.drawAgain();
  assert.equal(built.reader().ideas()?.stopped, false);
});

await test('a judged draw keeps its combinations through a stop', async (t) => {
  const built = await planned(t);
  await ideas(built, 4);
  await built.lab.drawAgain();
  await until(() => judgeOf(built) !== undefined);
  const judge = judgeOf(built);
  assert.ok(judge);
  await judge.tools.call(
    'verifold_judge',
    { candidates: [judgment('c-1', 5, 0)] },
    'judge-1',
  );
  await built.lab.stopLongShots();
  await assert.rejects(built.lab.drawAgain(), /new combination/);
});

await test('Draw again turns long shots on again', async (t) => {
  const built = await planned(t, { share: 'mixed' });
  await ideas(built, 5);
  await built.lab.stopLongShots();
  await built.lab.drawAgain();
  assert.equal(built.reader().ideas()?.stopped, false);
});

await test('a draw that cannot run says why', async (t) => {
  const built = await planned(t);
  await ideas(built, 2);
  await assert.rejects(built.lab.drawAgain(), /needs 3 ideas/);
  await ideas(built, 3);
  await built.lab.pause();
  await assert.rejects(built.lab.drawAgain(), /paused/);
  await built.lab.resume();
  await built.lab.drawAgain();
  await assert.rejects(built.lab.drawAgain(), /A draw runs now/);
});

await test('a lab with no idea map has no page', async (t) => {
  const built = await planned(t);
  const page = built.reader().ideas();
  assert.equal(page?.ideaCount, 0);
  assert.deepEqual(page?.draws, []);
  assert.equal(page?.stopped, false);
});
