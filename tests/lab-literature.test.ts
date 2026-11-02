import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Post } from '../src/core/board.ts';
import { readingLimits } from '../src/core/lab-tools.ts';
import {
  afterRead,
  isPaperLookup,
  labLookups,
  noLookups,
  noSearchYet,
  parseLookups,
  parseSource,
  type LookupRecord,
} from '../src/core/lab/literature.ts';
import { LiteratureStore } from '../src/core/lab/literature-store.ts';
import {
  claudeUpdates,
  codexAppUpdates,
  webRead,
  type TranscriptUpdate,
} from '../src/core/transcript.ts';
import { until } from './wait.ts';

const at = '2026-11-01T10:00:00.000Z';
const later = '2026-11-01T11:00:00.000Z';

async function folder(t: TestContext): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'verifold-reading-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5 }));
  return base;
}

/** The record after a list of harness updates, as the store folds them. */
function folded(
  updates: readonly TranscriptUpdate[],
  launch = 'run-1',
): LookupRecord {
  return updates.reduce((record, update) => {
    const read = webRead(update);
    return read ? afterRead(record, `${launch}:${read.id}`, read, at) : record;
  }, noLookups);
}

/** One successful read, by its key. */
const counted = (
  record: LookupRecord,
  key: string,
  title: string,
  when = at,
): LookupRecord =>
  afterRead(record, key, { id: key, title, status: 'done', named: true }, when);

const claudeResult = (id: string, failed = false): unknown => ({
  type: 'user',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: 'text',
        is_error: failed,
      },
    ],
  },
});

const claudeTool = (
  name: string,
  input: unknown,
  parent?: string,
): unknown => ({
  type: 'assistant',
  parent_tool_use_id: parent ?? null,
  message: {
    content: [{ type: 'tool_use', id: `id-${name}`, name, input }],
  },
});

await test('a paper lookup is a paper site or a search for papers, and nothing else', () => {
  for (const paper of [
    'https://arxiv.org/abs/2603.01092',
    'https://www.nature.com/articles/s41586-024-00001-1',
    'https://openreview.net/forum?id=abc',
    'https://doi.org/10.1000/182',
    'https://huggingface.co/papers/2603.01092',
    'attention sparsity arXiv October 2026',
    'Rahimi et al. random features',
    'recent papers on sparse coding',
    '2603.01092',
    'arxiv.org',
    'openreview.net',
    'dl.acm.org',
    'www.nature.com',
    'arxiv.org/abs/2603.01092',
  ])
    assert.equal(isPaperLookup(paper), true, paper);
  for (const other of [
    'https://huggingface.co/acme/some-model',
    'https://pypi.org/project/accelerate/',
    'https://github.com/acme/tool/blob/main/README.md',
    'https://raw.githubusercontent.com/acme/tool/main/x.py',
    'site.pypi.org/project/accelerate/ accelerate October 2026',
    'GPU prices today',
    'pypi.org',
    'not-openreview.net',
    'Cyber',
    'https://not-arxiv.org/abs/1',
    'http://',
    '',
  ])
    assert.equal(isPaperLookup(other), false, other);
});

await test('lookups come from harness tool events, and text that an agent writes counts for nothing', () => {
  const updates = [
    ...claudeUpdates({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I searched arxiv.org and read 40 papers.' },
        ],
      },
    }),
    ...claudeUpdates(
      claudeTool('Bash', { command: 'curl https://arxiv.org/abs/1' }),
    ),
    ...claudeUpdates(claudeResult('id-Bash')),
    ...claudeUpdates(
      claudeTool('WebSearch', { query: 'sparse coding papers' }),
    ),
    ...claudeUpdates(claudeResult('id-WebSearch')),
    ...claudeUpdates(
      claudeTool('WebFetch', { url: 'https://arxiv.org/abs/2603.01092' }),
    ),
    ...claudeUpdates(claudeResult('id-WebFetch')),
  ];
  const record = folded(updates);
  assert.equal(record.count, 2);
  assert.equal(record.papers, 2);
  assert.equal(record.last?.title, 'https://arxiv.org/abs/2603.01092');
});

await test('a lookup counts when its result succeeds, not when the call is reported', () => {
  const call = claudeUpdates(claudeTool('WebFetch', { url: 'https://a.io' }));
  const waiting = folded(call);
  assert.equal(waiting.count, 0);
  assert.equal(waiting.pending.length, 1);
  const done = folded([...call, ...claudeUpdates(claudeResult('id-WebFetch'))]);
  assert.equal(done.count, 1);
  assert.deepEqual(done.pending, []);
  assert.equal(done.last?.title, 'https://a.io');
});

await test('a denied or failed call read nothing, and its result of another tool changes nothing', () => {
  const failed = folded([
    ...claudeUpdates(claudeTool('WebFetch', { url: 'https://a.io' })),
    ...claudeUpdates(claudeResult('id-WebFetch', true)),
  ]);
  assert.equal(failed.count, 0);
  assert.deepEqual(failed.pending, []);
  // A tool result names no tool. Without a waiting call, it is about something else.
  assert.equal(folded(claudeUpdates(claudeResult('id-Read'))), noLookups);
});

await test('Codex logs one search twice under one ID, and it counts once', () => {
  const started = codexAppUpdates(
    'item/started',
    { type: 'webSearch', id: 'exec-1', query: '' },
    null,
  );
  const completed = codexAppUpdates(
    'item/completed',
    { type: 'webSearch', id: 'exec-1', query: 'sparse coding papers' },
    null,
  );
  // The start has no query yet, so the end says what it read.
  const record = folded([...started, ...completed]);
  assert.equal(record.count, 1);
  assert.equal(record.papers, 1);
  assert.equal(record.last?.title, 'sparse coding papers');
  assert.equal(folded([...started, ...completed, ...completed]).count, 1);
});

await test('a Codex item that failed read nothing', () => {
  const failed = codexAppUpdates(
    'item/completed',
    { type: 'webSearch', id: 'exec-1', query: 'q', status: 'failed' },
    null,
  );
  assert.equal(failed[0]?.status, 'failed');
  assert.equal(
    folded([
      ...codexAppUpdates(
        'item/started',
        { type: 'webSearch', id: 'exec-1', query: '' },
        null,
      ),
      ...failed,
    ]).count,
    0,
  );
});

await test('a Codex read with no query counts, with the site of its result', () => {
  const [update] = codexAppUpdates(
    'item/completed',
    {
      type: 'webSearch',
      id: 'exec-2',
      query: '',
      results: { type: 'text_result', domain: 'arxiv.org' },
    },
    null,
  );
  assert.ok(update);
  assert.equal(webRead(update)?.title, 'arxiv.org');
  assert.equal(folded([update]).papers, 1);
});

await test('a harness can use an ID again in a new process, and that is a new lookup', () => {
  const first = counted(noLookups, 'run-1:x', 'q');
  assert.equal(counted(first, 'run-2:x', 'q').count, 2);
  assert.equal(counted(first, 'run-1:x', 'q'), first);
});

await test('a record keeps bounded lists of calls, and a lookup keeps a bounded query', () => {
  const many = Array.from(
    { length: readingLimits.seen * 3 },
    (_, index) => index,
  ).reduce((record, index) => counted(record, `call-${index}`, 'q'), noLookups);
  assert.equal(many.count, readingLimits.seen * 3);
  assert.equal(many.seen.length, readingLimits.seen);
  const open = Array.from(
    { length: readingLimits.seen * 3 },
    (_, index) => index,
  ).reduce(
    (record, index) =>
      afterRead(
        record,
        `call-${index}`,
        { id: 'x', title: 'q', status: 'running', named: true },
        at,
      ),
    noLookups,
  );
  assert.equal(open.pending.length, readingLimits.seen);
  const long = counted(noLookups, 'x', 'q'.repeat(5000));
  assert.ok((long.last?.title.length ?? 0) <= readingLimits.lookup);
});

await test('the lab record adds up its agents, with the newest lookup and paper', () => {
  const one = counted(noLookups, 'a', 'https://arxiv.org/abs/1');
  const two = counted(noLookups, 'b', 'GPU prices', later);
  assert.deepEqual(
    (({ count, papers }) => ({ count, papers }))(labLookups([one, two])),
    { count: 2, papers: 1 },
  );
  assert.equal(labLookups([one, two]).last?.at, later);
  assert.equal(labLookups([one, two]).lastPaper?.at, at);
  assert.equal(labLookups([]).last, null);
});

await test('"No search yet" marks a proposal or a ruled-out post with no lookup since the last such post', () => {
  const lookup = { at, title: 'q', paper: false };
  // Only these two kinds carry the mark.
  assert.equal(noSearchYet('result', null, undefined), false);
  assert.equal(noSearchYet('proposal', null, undefined), true);
  assert.equal(noSearchYet('ruled-out', null, undefined), true);
  // The first such post needs one lookup at any time before it.
  assert.equal(noSearchYet('proposal', lookup, undefined), false);
  // A later one needs a lookup after the last such post.
  assert.equal(noSearchYet('proposal', lookup, later), true);
  assert.equal(noSearchYet('proposal', { ...lookup, at: later }, at), false);
  assert.equal(noSearchYet('proposal', lookup, at), true);
});

await test('saved records keep what is valid and drop what is not', () => {
  assert.equal(parseLookups(7), null);
  assert.deepEqual(
    parseLookups({
      count: 3,
      papers: -1,
      last: { at, title: 'q', paper: true },
      lastPaper: { at: 'never', title: 'q' },
      pending: ['x'],
      seen: ['x'],
    }),
    {
      count: 3,
      papers: 0,
      last: { at, title: 'q', paper: true },
      lastPaper: null,
      pending: [],
      seen: [],
    },
  );
  const source = {
    id: 's-1',
    title: 'A paper',
    url: 'https://arxiv.org/abs/1',
    date: 'Oct 12, 2026',
    by: 'a-1',
    at,
  };
  assert.deepEqual(parseSource(source), source);
  for (const bad of [
    null,
    { ...source, id: 'p-1' },
    { ...source, url: 'javascript:alert(1)' },
    { ...source, title: '' },
    { ...source, at: 'never' },
  ])
    assert.equal(parseSource(bad), null);
});

/** One web read that succeeded, as a harness reports it. */
const read: TranscriptUpdate = {
  id: 'x',
  kind: 'tool',
  name: 'WebSearch',
  title: 'q',
  status: 'done',
};

await test('the store counts subagent lookups for their agent, and saves them without the call lists', async (t) => {
  const path = join(await folder(t), 'literature.json');
  const store = new LiteratureStore(path, () => false);
  for (const update of [
    ...claudeUpdates(
      claudeTool(
        'WebFetch',
        { url: 'https://arxiv.org/abs/1' },
        'toolu-helper',
      ),
    ),
    ...claudeUpdates(claudeResult('id-WebFetch')),
  ])
    store.heard('a-1', 'run-1', update, at);
  assert.deepEqual(store.reading(), {
    papers: 0,
    lookups: 1,
    lastPaperAt: at,
  });
  await until(async () =>
    (await readFile(path, 'utf8').catch(() => '')).includes('arxiv'),
  );
  await store.flush();
  const saved = await readFile(path, 'utf8');
  assert.doesNotMatch(saved, /"seen"/);
  assert.doesNotMatch(saved, /"pending"/);
  const again = new LiteratureStore(path, () => false);
  await again.load(true);
  assert.equal(again.reading().lookups, 1);
  assert.equal(again.reading().lastPaperAt, at);
});

await test('the reading map takes a paper once by its address, with its ideas on the idea map', async (t) => {
  const path = join(await folder(t), 'literature.json');
  const store = new LiteratureStore(path, () => false);
  const paper = {
    title: 'A paper',
    url: 'https://arxiv.org/abs/1',
    date: 'Oct 12, 2026',
    ideas: ['Region mixtures', 'Output metric'],
  };
  assert.match(
    await store.addSource('a-1', paper),
    /^s-1 is on the reading map/,
  );
  assert.match(
    await store.addSource('a-2', { ...paper, ideas: ['Invertible map'] }),
    /^s-1 /,
  );
  assert.equal(store.reading().papers, 1);
  assert.deepEqual(
    store.ideas().map((idea) => [idea.text, idea.sources, idea.tried]),
    [
      ['Region mixtures', ['s-1'], false],
      ['Output metric', ['s-1'], false],
      ['Invertible map', ['s-1'], false],
    ],
  );
  await store.addIdea('a-2', { text: 'Region mixtures', tried: true });
  assert.equal(store.ideas()[0]?.tried, true);
  assert.match(store.sourceLines(10), /s-1 "A paper", "Oct 12, 2026"/);
  assert.match(store.ideaLines(10), /i-1 \[tried\] "Region mixtures" from s-1/);
  await store.flush();
  const again = new LiteratureStore(path, () => false);
  await again.load(true);
  assert.deepEqual(again.ideas(), store.ideas());
  assert.match(again.sourceLines(10), /s-1/);
});

await test('the store refuses what is not a paper or an idea, and says why', async (t) => {
  const store = new LiteratureStore(
    join(await folder(t), 'literature.json'),
    () => false,
  );
  const paper = {
    title: 'A paper',
    url: 'https://arxiv.org/abs/1',
    date: 'Oct 12, 2026',
    ideas: [],
  };
  await assert.rejects(
    store.addSource('a-1', { ...paper, url: 'ftp://arxiv.org/1' }),
    /http or https/,
  );
  await assert.rejects(
    store.addSource('a-1', { ...paper, title: 'x'.repeat(5000) }),
    /Write the title of a paper/,
  );
  await assert.rejects(
    store.addSource('a-1', { ...paper, ideas: [7] }),
    /Write each idea/,
  );
  await assert.rejects(store.addIdea('a-1', { text: 'x' }), /tried/);
  await assert.rejects(store.addIdea('a-1', { tried: true }), /Write the idea/);
  assert.equal(store.reading().papers, 0);
  assert.match(store.sourceLines(5), /no paper yet/);
  assert.match(store.ideaLines(5), /no idea yet/);
});

await test('the reading map and the agents stay bounded', async (t) => {
  const path = join(await folder(t), 'literature.json');
  const store = new LiteratureStore(path, () => false);
  for (let index = 0; index < readingLimits.sources; index++)
    await store.addSource('a-1', {
      title: `Paper ${index}`,
      url: `https://arxiv.org/abs/${index}`,
      date: '2026',
      ideas: [],
    });
  await assert.rejects(
    store.addSource('a-1', {
      title: 'One more',
      url: 'https://arxiv.org/abs/x',
      date: '2026',
      ideas: [],
    }),
    /holds 300 papers/,
  );
  for (let index = 1; index <= readingLimits.agents + 5; index++)
    store.heard(`a-${index}`, 'run-1', read, at);
  assert.equal(store.reading().lookups, readingLimits.agents);
});

await test('a broken or a hostile file leaves a store that works', async (t) => {
  const base = await folder(t);
  const path = join(base, 'literature.json');
  await writeFile(path, 'not json');
  const broken = new LiteratureStore(path, () => false);
  await broken.load(true);
  assert.equal(broken.reading().papers, 0);
  await writeFile(
    path,
    JSON.stringify({
      lookups: [
        { agent: '../evil', count: 9 },
        { agent: 'a-1', count: 2, papers: 1 },
        7,
      ],
      sources: [{ id: 'nope' }],
      ideas: 'none',
    }),
  );
  const hostile = new LiteratureStore(path, () => false);
  await hostile.load(true);
  assert.equal(hostile.reading().lookups, 2);
  assert.deepEqual(hostile.ideas(), []);
});

await test('a lab from before threads reads no records, and a suspended lab writes none', async (t) => {
  const path = join(await folder(t), 'literature.json');
  await writeFile(path, JSON.stringify({ sources: [] }));
  const store = new LiteratureStore(path, () => true);
  await store.load(false);
  store.heard('a-1', 'run-1', read, at);
  await store.flush();
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { sources: [] });
});

await test('the record of a post holds its marks, and the mark comes from the store', async (t) => {
  const store = new LiteratureStore(
    join(await folder(t), 'literature.json'),
    () => false,
  );
  const post = (kind: Post['kind'], when: string, author = 'a-1'): Post => ({
    schemaVersion: 1,
    id: 'p-1',
    at: when,
    author,
    kind,
    text: 'x',
    mentions: [],
    artifacts: [],
  });
  assert.equal(store.noSearch('a-1', 'proposal', []), true);
  store.heard('a-1', 'run-1', read, at);
  assert.equal(store.noSearch('a-1', 'proposal', []), false);
  // An agent's earlier result, or another agent's proposal, does not count as its last such post.
  assert.equal(
    store.noSearch('a-1', 'proposal', [
      post('result', later),
      post('proposal', later, 'a-2'),
    ]),
    false,
  );
  assert.equal(
    store.noSearch('a-1', 'ruled-out', [post('proposal', later)]),
    true,
  );
});
