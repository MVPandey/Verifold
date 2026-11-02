import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Board } from '../src/core/board.ts';
import { checkBlock } from '../src/core/lab/post-rules.ts';
import { reopenRefusal } from '../src/core/lab/reopen.ts';
import type { AgentRecord, Direction } from '../src/core/lab/schema.ts';
import type { SessionRecord } from '../src/core/session.ts';
import type { RunRecord } from '../src/core/runs.ts';
import type { TranscriptUpdate } from '../src/core/transcript.ts';
import { ApiFeed, ApiReader, answerApi } from '../src/server/api.ts';
import { reachQuery } from '../src/server/lab-team.ts';
import { until } from './wait.ts';
import { opened, planned, posted, type Built } from './lab-step-fixture.ts';

const agentOf = (built: Built, index: number): AgentRecord => {
  const agent = built.view().directions[index]?.agent;
  assert.ok(agent);
  return agent;
};

const directionOf = (built: Built, index: number): Direction => {
  const direction = built.view().directions[index]?.direction;
  assert.ok(direction);
  return direction;
};

const threadOf = (built: Built, id: string) =>
  built.view().threads?.find((thread) => thread.id === id);

/** The agents whose wake events carry a post. */
const woken = (built: Built, post: string): readonly string[] =>
  built
    .view()
    .directions.filter(({ agent }) =>
      agent.events.some((event) => event.post === post),
    )
    .map(({ agent }) => agent.id);

await test('each level of the box reaches who the server says it reaches', async (t) => {
  const built = await planned(t);
  const { thread } = await opened(built, 0, 'ask', {
    mentions: [agentOf(built, 1).handle],
  });
  const reader = built.reader();
  const one = agentOf(built, 2);
  const line = reader.reach({ thread, to: one.id });
  assert.deepEqual(
    line?.readers.map(({ handle }) => handle),
    [one.handle],
  );
  const toOne = await built.lab.post({ text: 'Look.', thread, to: one.id });
  assert.deepEqual(woken(built, toOne.id), [one.id]);
  assert.deepEqual(
    reader.reach({ thread, to: 'all' })?.readers.map(({ handle }) => handle),
    built.view().directions.map(({ agent }) => agent.handle),
  );
  const toAll = await built.lab.post({ text: 'All.', thread, to: 'all' });
  assert.equal(woken(built, toAll.id).length, 3);
  await assert.rejects(
    built.lab.post({ text: 'No.', to: 'a-99' }),
    /Choose an agent of the lab/,
  );
});

await test('a name in the text changes the reach as it changes the wake', async (t) => {
  const built = await planned(t);
  const { thread } = await opened(built, 0, 'ask', {
    mentions: [agentOf(built, 1).handle],
  });
  const one = agentOf(built, 2);
  const reach = built.reader().reach({ thread, named: `@${one.handle}` });
  assert.deepEqual(
    reach?.readers.map(({ handle }) => handle),
    [one.handle],
  );
  const sent = await built.lab.post({
    text: `@${one.handle} look`,
    thread,
  });
  assert.deepEqual(woken(built, sent.id), [one.id]);
});

await test('a post on the home narrows to a name in its text, as the reach says', async (t) => {
  const built = await planned(t);
  const one = agentOf(built, 2);
  assert.deepEqual(
    built
      .reader()
      .reach({ named: `@${one.handle}` })
      ?.readers.map(({ handle }) => handle),
    [one.handle],
  );
  const sent = await built.lab.post({ text: `@${one.handle} look` });
  assert.deepEqual(woken(built, sent.id), [one.id]);
});

await test('a reach counts the names that a post keeps', async (t) => {
  const built = await planned(t);
  const handles = built.view().directions.map(({ agent }) => agent.handle);
  const reach = built
    .reader()
    .reach({ named: handles.map((handle) => `@${handle}`).join(' ') });
  assert.equal(reach?.readers.length, 3);
  assert.deepEqual(reachQuery(new URLSearchParams('nothing=1')), null);
  assert.deepEqual(reachQuery(new URLSearchParams('thread=t-2&to=all')), {
    thread: 't-2',
    to: 'all',
  });
  assert.equal(
    reachQuery(new URLSearchParams({ named: 'x'.repeat(301) })),
    null,
  );
});

await test('the reach of a live lab follows a stop and a pause', async (t) => {
  const built = await planned(t);
  const reader = built.reader();
  await built.lab.stopDirection(directionOf(built, 0).id);
  assert.deepEqual(reader.reach({ to: 'all' })?.missed, [
    { handle: agentOf(built, 0).handle, why: 'stopped' },
  ]);
  await built.lab.pause();
  assert.deepEqual(
    reader.reach({ to: 'all' })?.readers.map(({ when }) => when),
    ['resume', 'resume'],
  );
});

await test("the person's objection takes the path of an agent's", async (t) => {
  const built = await planned(t);
  const { post, thread } = await opened(built, 0, 'proposal');
  await assert.rejects(
    built.lab.post({ text: 'No.', kind: 'objection' }),
    /names the post/,
  );
  const objection = await built.lab.post({
    text: 'This bar is too low.',
    kind: 'objection',
    replyTo: post,
  });
  assert.equal(objection.thread, thread);
  assert.ok(woken(built, objection.id).includes(agentOf(built, 0).id));
  const wire = built.reader().collab() ?? assert.fail('no page');
  assert.equal(wire.disagreements[0]?.post, post);
  assert.equal(wire.disagreements[0]?.objections[0]?.author, 'person');
  assert.deepEqual(wire.objections.by, [
    { author: 'person', handle: null, count: 1 },
  ]);
  assert.equal(wire.needs[0]?.waiter, 'person');
});

await test('Reopen brings a stopped agent back with its thread, its folder, and its record', async (t) => {
  const built = await planned(t);
  const { thread } = await opened(built, 1, 'proposal');
  const direction = directionOf(built, 0);
  const agent = agentOf(built, 0);
  await built.lab.stopDirection(direction.id);
  await until(() => built.view().directions[0]?.status === 'stopped');
  const starts = built.started.length;
  await built.lab.reopenDirection(direction.id, thread);
  const back = directionOf(built, 0);
  assert.equal(back.state, 'open');
  assert.equal(back.stoppedAt, null);
  assert.equal(back.workspace.path, direction.workspace.path);
  assert.equal(back.head, direction.head);
  assert.equal(back.verdict, direction.verdict);
  assert.equal(agentOf(built, 0).stoppedAt, null);
  assert.equal(agentOf(built, 0).id, agent.id);
  assert.ok(threadOf(built, thread)?.followers.includes(agent.id));
  assert.ok(
    built
      .view()
      .posts.some(
        (post) => post.thread === thread && /reopened "Alpha"/.test(post.text),
      ),
  );
  assert.equal(built.view().state.agentStarts.length, 1);
  await until(() => built.started.length > starts);
  assert.equal(built.started.at(-1)?.agent, agent.id);
});

await test('Reopen brings back an agent that closed its direction, once its last turn is saved', async (t) => {
  const built = await planned(t);
  const direction = directionOf(built, 0);
  await writeFile(
    join(built.root, direction.workspace.path, 'failed.txt'),
    '0.1\n',
  );
  const failed = await opened(built, 0, 'ruled-out', {
    artifacts: [{ type: 'file', path: 'failed.txt' }],
  });
  const verdict = await built.call(0, 'verifold_direction', {
    action: 'update',
    verdict: 'ruled-out',
    post: failed.post,
    evidence: 'It failed its bar.',
    why: 'It failed.',
  });
  assert.equal(verdict.ok, true, verdict.text);
  const closed = await built.call(0, 'verifold_direction', {
    action: 'close',
    why: 'Ruled out on 3 seeds.',
  });
  assert.equal(closed.ok, true, closed.text);
  await assert.rejects(
    built.lab.reopenDirection(direction.id),
    /still saves its last turn/,
  );
  const first = built.started[0];
  assert.ok(first);
  built.endTurn(first);
  await until(() => agentOf(built, 0).finished);
  await built.lab.reopenDirection(direction.id);
  assert.equal(directionOf(built, 0).state, 'open');
  assert.equal(directionOf(built, 0).verdict, 'ruled-out');
  assert.equal(agentOf(built, 0).stopReason, null);
  assert.equal(agentOf(built, 0).finished, false);
});

await test('Reopen keeps to the limits and says why it refuses', async (t) => {
  const built = await planned(t, { limit: 3 });
  const { id } = directionOf(built, 0);
  await assert.rejects(built.lab.reopenDirection(id), /open already/);
  await assert.rejects(built.lab.reopenDirection('d-99'), /Choose a direction/);
  await built.lab.stopDirection(id);
  await assert.rejects(
    built.lab.reopenDirection(id, 't-99'),
    /This thread is gone/,
  );
  await built.lab.pause();
  await assert.rejects(built.lab.reopenDirection(id), /paused/);
  await built.lab.resume();
  for (let count = 0; count < 3; count++) {
    await built.lab.reopenDirection(id);
    await built.lab.stopDirection(id);
  }
  await assert.rejects(
    built.lab.reopenDirection(id),
    /in the last 24 hours.*Try again later/,
  );
});

await test('a pure refusal names a session that still ends', () => {
  const agent = {
    handle: 'agent-1',
    stopReason: 'person',
    finished: false,
  } as const;
  assert.match(
    reopenRefusal({ state: 'stopped' }, agent, true) ?? '',
    /still saves/,
  );
  assert.equal(reopenRefusal({ state: 'stopped' }, agent, false), null);
  assert.match(
    reopenRefusal({ state: 'closed' }, undefined, false) ?? '',
    /no agent/,
  );
});

await test('Overturn opens a decided thread, wakes its followers, and the proposal never decides again', async (t) => {
  const built = await planned(t, { objectionMs: 1 });
  const { post, thread } = await opened(built, 0, 'proposal');
  await built.call(1, 'verifold_follow', { thread });
  await until(() => threadOf(built, thread)?.state === 'decided');
  await built.lab.overturnDecision(thread);
  const record = threadOf(built, thread);
  assert.equal(record?.state, 'open');
  assert.equal(record?.overturned, post);
  assert.equal(record?.outcome, undefined);
  const note = built
    .view()
    .posts.find((entry) => /overturned/.test(entry.text));
  assert.ok(note);
  assert.deepEqual(
    [...woken(built, note.id)].sort(),
    [agentOf(built, 0).id, agentOf(built, 1).id].sort(),
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(threadOf(built, thread)?.state, 'open');
  await assert.rejects(built.lab.overturnDecision(thread), /no decision/);
  await assert.rejects(built.lab.overturnDecision('t-99'), /gone/);
});

const ended = {
  id: 'r-1',
  status: 'done',
} as RunRecord;

await test('a check needs a post that cites a run that ended, and says why it cannot start', () => {
  const cites = {
    id: 'p-1',
    kind: 'result',
    artifacts: [{ type: 'run', run: 'r-1' }],
  } as const;
  const run = (id: string): RunRecord | undefined =>
    id === 'r-1' ? ended : undefined;
  assert.equal(checkBlock(cites, run, []), null);
  assert.equal(checkBlock({ ...cites, kind: 'proposal' }, run, []), 'kind');
  assert.equal(checkBlock({ ...cites, artifacts: [] }, run, []), 'no-run');
  assert.equal(
    checkBlock(cites, () => ({ ...ended, status: 'running' }), []),
    'run-active',
  );
  const check = (
    state: 'queued' | 'running' | 'done' | 'failed' | 'dropped',
  ) => ({
    claim: 'p-1',
    state,
  });
  assert.equal(checkBlock(cites, run, [check('running')]), 'going');
  assert.equal(checkBlock(cites, run, [check('queued')]), 'going');
  assert.equal(checkBlock(cites, run, [check('done')]), null);
  assert.equal(checkBlock(cites, run, [check('dropped')]), null);
  assert.equal(
    checkBlock(cites, run, [check('done'), check('failed')]),
    'limit',
  );
});

await test('the person can ask for a check of a post with an ended run, and hears why not on any other', async (t) => {
  const built = await planned(t);
  const started = await built.call(0, 'verifold_run', {
    command: 'echo hello',
    why: 'A test.',
    minutes: 1,
  });
  assert.equal(started.ok, true, started.text);
  const run = /r-\d+/.exec(started.text)?.[0] ?? assert.fail(started.text);
  const own = built.view().directions[0]?.direction;
  assert.ok(own);
  await until(() => built.view().ledger.at(0)?.status !== 'running');
  await until(() => built.view().ledger.at(0)?.status !== 'queued');
  const reply = await built.call(0, 'verifold_post', {
    kind: 'result',
    title: 'Does the control beat chance on seed 2?',
    why: 'The bar rests on it.',
    text: 'Accuracy is 0.7.',
    artifacts: [{ type: 'run', run }],
  });
  assert.equal(reply.ok, true, reply.text);
  const post = posted(reply.text);
  await built.lab.askCheck(post);
  assert.equal(built.view().checks.at(-1)?.claim, post);
  assert.equal(built.view().checks.at(-1)?.holdsUp, false);
  const page =
    built
      .reader()
      .threadPage(
        built.view().posts.find((entry) => entry.id === post)?.thread ?? '',
      ) ?? assert.fail('no page');
  assert.equal(page.posts.find(({ id }) => id === post)?.noCheck, 'going');
  const { post: plain } = await opened(built, 1, 'proposal', {
    title: 'Which control should the lab use first?',
  });
  await assert.rejects(built.lab.askCheck(plain), /no result/);
  await assert.rejects(built.lab.askCheck('p-999'), /Name a post/);
});

const harness = (
  built: Built,
  index: number,
  update: TranscriptUpdate,
): void => {
  const started = built.started[index];
  assert.ok(started);
  built.lab.harnessUpdate(
    {
      agent: started.agent,
      launches: [{ id: 'launch-1' }],
    } as unknown as SessionRecord,
    update,
  );
};

const lookup = (built: Built, id: string, parent?: string): void => {
  const by = parent ? { parent } : {};
  harness(built, 0, {
    id,
    name: 'WebSearch',
    title: 'sparse coding papers',
    status: 'running',
    ...by,
  });
  harness(built, 0, { id, status: 'done', ...by });
};

await test('a proposal shows prior work from its author, and lookups from the record', async (t) => {
  const built = await planned(t);
  const prior = {
    closest: 'A paper on circles (Oct 2026).',
    notFound: 'A test on a late model.',
    newHere: 'A direct test.',
  };
  const bare = await opened(built, 0, 'proposal', {
    prior,
    title: 'Which control should the lab use first?',
  });
  const first = built.view().posts.find(({ id }) => id === bare.post);
  assert.deepEqual(first?.prior, prior);
  assert.equal(first?.noSearch, true);
  assert.equal(first?.search, undefined);
  harness(built, 0, {
    id: 'helper-1',
    name: 'Agent',
    title: 'Find prior work',
    status: 'running',
  });
  lookup(built, 'look-1');
  lookup(built, 'look-2', 'helper-1');
  const searched = await opened(built, 0, 'proposal', {
    title: 'Which seed should the lab use first?',
    // An agent's own count goes nowhere: the schema takes no such field.
    prior: { closest: 'One paper.', lookups: 99 },
  });
  const second = built.view().posts.find(({ id }) => id === searched.post);
  assert.deepEqual(second?.prior, { closest: 'One paper.' });
  assert.equal(second?.noSearch, undefined);
  assert.equal(second?.search?.lookups, 2);
  assert.equal(second?.search?.total, 2);
  assert.equal(second?.search?.helper, `${agentOf(built, 0).handle}.1`);
  lookup(built, 'look-3');
  const third = await opened(built, 0, 'proposal', {
    title: 'Which month should the lab use first?',
  });
  assert.equal(
    built.view().posts.find(({ id }) => id === third.post)?.search?.lookups,
    1,
  );
  const wire = built.reader().threadPage(searched.thread);
  assert.deepEqual(
    wire?.posts[0]?.search?.helper,
    `${agentOf(built, 0).handle}.1`,
  );
});

await test('only a proposal or a ruled-out post gives prior, and a post with none still goes out', async (t) => {
  const built = await planned(t);
  const refused = await built.call(0, 'verifold_post', {
    kind: 'ask',
    title: 'Does the control beat chance on seed 2?',
    why: 'The bar rests on it.',
    text: 'Which seed leaks?',
    mentions: ['person'],
    prior: { closest: 'One paper.' },
  });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /Only a proposal or a ruled-out post/);
  const { post } = await opened(built, 0, 'proposal');
  assert.equal(
    built.view().posts.find(({ id }) => id === post)?.noSearch,
    true,
  );
});

await test('prior work and lookups survive a reload of the board, cut to their limits', async (t) => {
  const built = await planned(t);
  lookup(built, 'look-1');
  const { post } = await opened(built, 0, 'proposal', {
    prior: { closest: 'One paper.' },
  });
  const board = new Board(built.root);
  await board.load();
  assert.deepEqual(board.get(post)?.prior, { closest: 'One paper.' });
  assert.equal(board.get(post)?.search?.lookups, 1);
});

/** The API's own routes on a local port. `act` hears each action. */
async function routes(
  t: TestContext,
  reader: ApiReader,
  authorized = true,
): Promise<{
  readonly get: (path: string, body?: unknown) => Promise<Response>;
  readonly acted: unknown[];
}> {
  const acted: unknown[] = [];
  const feed = new ApiFeed(reader, { pollMs: 60_000, heartbeatMs: 60_000 });
  const server = createServer((request, response) => {
    void answerApi(
      request,
      response,
      new URL(request.url ?? '/', 'http://localhost'),
      authorized,
      feed,
      reader,
      (body) => {
        acted.push(body.action);
        return Promise.resolve(200);
      },
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    feed.close();
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    acted,
    get: (path, body) =>
      fetch(
        `http://127.0.0.1:${address.port}/api/v1/${path}`,
        body === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            },
      ),
  };
}

await test('the three reads answer on their routes, and each new action reaches the desk', async (t) => {
  const built = await planned(t);
  const { get, acted } = await routes(t, built.reader());
  const reach = await get('reach?to=all');
  assert.equal(reach.status, 200);
  const body = (await reach.json()) as { readers: unknown[] };
  assert.equal(body.readers.length, 3);
  assert.equal((await get('reach?nothing=1')).status, 400);
  for (const page of ['collab', 'ideas'])
    assert.equal((await get(page)).status, 200, page);
  for (const name of [
    'lab-direction-reopen',
    'lab-check',
    'lab-overturn',
    'lab-long-shots-stop',
  ])
    assert.equal((await get(`actions/${name}`, {})).status, 200, name);
  assert.deepEqual(acted, [
    'lab-direction-reopen',
    'lab-check',
    'lab-overturn',
    'lab-long-shots-stop',
  ]);
});

await test('the three reads need the token, and a lab from before threads has no such page', async (t) => {
  const built = await planned(t);
  const closed = await routes(t, built.reader(), false);
  for (const page of ['reach', 'collab', 'ideas'])
    assert.equal((await closed.get(page)).status, 401, page);
  const old = await routes(
    t,
    new ApiReader(() => ({
      root: built.root,
      lab: { view: () => ({ ...built.view(), threads: [] }) },
      compute: undefined,
      session: () => null,
      away: () => Promise.resolve(null),
      works: [],
    })),
  );
  for (const page of ['collab', 'ideas'])
    assert.equal((await old.get(page)).status, 404, page);
});
