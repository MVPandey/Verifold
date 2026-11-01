import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Post } from '../src/core/board.ts';
import { longShotLimits, readingLimits } from '../src/core/lab-tools.ts';
import {
  isPaperLookup,
  labLookups,
  lookupOf,
  noLookups,
  noSearchYet,
  parseLookups,
  parseSource,
  withLookup,
  type LookupRecord,
} from '../src/core/lab/literature.ts';
import { LiteratureStore } from '../src/core/lab/literature-store.ts';
import {
  claudeUpdates,
  codexAppUpdates,
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
    const lookup = lookupOf(update);
    return lookup
      ? withLookup(record, `${launch}:${lookup.id}`, lookup.title, at)
      : record;
  }, noLookups);
}

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
  ])
    assert.equal(isPaperLookup(paper), true, paper);
  for (const other of [
    'https://huggingface.co/acme/some-model',
    'https://pypi.org/project/accelerate/',
    'https://github.com/acme/tool/blob/main/README.md',
    'https://raw.githubusercontent.com/acme/tool/main/x.py',
    'site.pypi.org/project/accelerate/ accelerate October 2026',
    'GPU prices today',
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
    ...claudeUpdates(
      claudeTool('WebSearch', { query: 'sparse coding papers' }),
    ),
    ...claudeUpdates(
      claudeTool('WebFetch', { url: 'https://arxiv.org/abs/2603.01092' }),
    ),
  ];
  const record = folded(updates);
  assert.equal(record.count, 2);
  assert.equal(record.papers, 2);
  assert.equal(record.last?.title, 'https://arxiv.org/abs/2603.01092');
});

await test('a result without a name, a tool result, is no second lookup', () => {
  const call = claudeUpdates(claudeTool('WebFetch', { url: 'https://a.io' }));
  const result = claudeUpdates({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'id-WebFetch', content: 'page' },
      ],
    },
  });
  assert.equal(folded([...call, ...result]).count, 1);
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
  // A start that reports its query logs the same call again at its end.
  assert.equal(folded([...completed, ...completed]).count, 1);
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
  assert.deepEqual(lookupOf(update), { id: 'exec-2', title: 'arxiv.org' });
  assert.equal(folded([update]).papers, 1);
});

await test('a harness can use an ID again in a new process, and that is a new lookup', () => {
  const call = claudeUpdates(claudeTool('WebSearch', { query: 'q' }));
  const first = folded(call, 'run-1');
  const lookup = lookupOf(call[0] ?? {});
  assert.ok(lookup);
  assert.equal(
    withLookup(first, `run-2:${lookup.id}`, lookup.title, at).count,
    2,
  );
});

await test('a record keeps a bounded list of calls, and a lookup keeps a bounded query', () => {
  const many = Array.from(
    { length: readingLimits.seen * 3 },
    (_, index) => index,
  ).reduce(
    (record, index) => withLookup(record, `call-${index}`, 'q', at),
    noLookups,
  );
  assert.equal(many.count, readingLimits.seen * 3);
  assert.equal(many.seen.length, readingLimits.seen);
  const long = withLookup(noLookups, 'x', 'q'.repeat(5000), at);
  assert.ok((long.last?.title.length ?? 0) <= readingLimits.lookup);
});

await test('the lab record adds up its agents, with the newest lookup and paper', () => {
  const one = withLookup(noLookups, 'a', 'https://arxiv.org/abs/1', at);
  const two = withLookup(noLookups, 'b', 'GPU prices', later);
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
      seen: ['x'],
    }),
    {
      count: 3,
      papers: 0,
      last: { at, title: 'q', paper: true },
      lastPaper: null,
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

await test('the store counts subagent lookups for their agent, and saves them without the call list', async (t) => {
  const path = join(await folder(t), 'literature.json');
  const store = new LiteratureStore(path, () => false);
  for (const update of claudeUpdates(
    claudeTool('WebFetch', { url: 'https://arxiv.org/abs/1' }, 'toolu-helper'),
  ))
    store.heard('a-1', 'agent-1', 'run-1', update, at);
  assert.deepEqual(store.reading(), {
    papers: 0,
    lookups: 1,
    lastPaperAt: at,
  });
  await until(async () =>
    (await readFile(path, 'utf8').catch(() => '')).includes('arxiv'),
  );
  await store.flush();
  assert.doesNotMatch(await readFile(path, 'utf8'), /"seen"/);
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
    store.heard(
      `a-${index}`,
      null,
      'run-1',
      { id: 'x', kind: 'tool', name: 'WebSearch', title: 'q' },
      at,
    );
  assert.equal(store.reading().lookups, readingLimits.agents);
  for (let index = 0; index < longShotLimits.draws + 5; index++)
    store.addDraw({ at, by: 'person', agent: `a-${index + 1}`, drawn: [] });
  assert.equal(store.draws().length, longShotLimits.draws);
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
      helpers: [{ agent: 'a-1', helpers: [{ id: 'x' }, 7] }],
      sources: [{ id: 'nope' }],
      ideas: 'none',
      draws: [{ at, by: 'nobody', agent: 'a-1', drawn: [] }],
    }),
  );
  const hostile = new LiteratureStore(path, () => false);
  await hostile.load(true);
  assert.equal(hostile.reading().lookups, 2);
  assert.deepEqual(hostile.helpersOf('a-1'), []);
  assert.deepEqual(hostile.ideas(), []);
  assert.deepEqual(hostile.draws(), []);
});

await test('a lab from before threads reads no records, and a suspended lab writes none', async (t) => {
  const path = join(await folder(t), 'literature.json');
  await writeFile(path, JSON.stringify({ sources: [] }));
  const store = new LiteratureStore(path, () => true);
  await store.load(false);
  store.heard(
    'a-1',
    null,
    'run-1',
    { id: 'x', kind: 'tool', name: 'WebSearch', title: 'q' },
    at,
  );
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
  store.heard(
    'a-1',
    null,
    'run-1',
    { id: 'x', kind: 'tool', name: 'WebSearch', title: 'q' },
    at,
  );
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
