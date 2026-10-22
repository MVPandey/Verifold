import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateModel } from '../src/core/harness.ts';
import {
  claudeModel,
  codexEffort,
  codexModelPages,
  labModel,
  listCodexModels,
  pickCodexModel,
  type CodexCall,
} from '../src/core/models.ts';

await test('Codex gets the most capable model that its list offers', () => {
  const sol = { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', isDefault: true };
  const astra = { id: 'gpt-6-astra', model: 'gpt-6-astra' };
  assert.equal(pickCodexModel([sol, astra]), 'gpt-6-astra');
  // A hidden model does not count, so the next one in Verifold's order wins.
  assert.equal(
    pickCodexModel([{ ...astra, hidden: true }, sol]),
    'gpt-6.1-sol',
  );
  // Without one of Verifold's models, the thread starts with the person's
  // own model, not with the one that Codex marks as its default.
  const others = [
    { id: 'other', model: 'gpt-7-nova' },
    { id: 'mini', model: 'gpt-7-mini', isDefault: true },
  ];
  assert.equal(pickCodexModel(others), undefined);
  // The ID stands in for a missing model name.
  assert.equal(pickCodexModel([{ id: 'gpt-6-astra' }]), 'gpt-6-astra');
  // Nothing fits: the thread starts with the person's own model.
  assert.equal(pickCodexModel([{ id: 'x', model: 'gpt-7-nova' }]), undefined);
  assert.equal(pickCodexModel(['gpt-6-astra', null, 7]), undefined);
  assert.equal(
    pickCodexModel([{ model: 'bad name; rm -rf /', isDefault: true }]),
    undefined,
  );
});

await test("a model that Verifold picks gets its default effort when the person's effort does not fit it", () => {
  const astra = {
    id: 'gpt-6-astra',
    model: 'gpt-6-astra',
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Balanced' },
      { reasoningEffort: 'high', description: 'Deeper' },
    ],
    defaultReasoningEffort: 'medium',
  };
  assert.equal(codexEffort([astra], 'gpt-6-astra', 'ultra'), 'medium');
  // An effort that fits, or none, stays the person's own.
  assert.equal(codexEffort([astra], 'gpt-6-astra', 'high'), undefined);
  assert.equal(codexEffort([astra], 'gpt-6-astra', undefined), undefined);
  // Without a list of efforts, or a default in it, nothing changes.
  const silent = { id: 'gpt-6-astra', defaultReasoningEffort: 'medium' };
  assert.equal(codexEffort([silent], 'gpt-6-astra', 'ultra'), undefined);
  assert.equal(
    codexEffort(
      [{ ...astra, defaultReasoningEffort: 'low' }],
      'gpt-6-astra',
      'ultra',
    ),
    undefined,
  );
  assert.equal(codexEffort([astra], 'gpt-6-sol', 'ultra'), undefined);
});

await test("Claude Code keeps the person's own Opus default, and gets opus otherwise", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'verifold-model-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  /** A Claude Code settings folder whose `settings.json` holds `text`. */
  const folder = async (name: string, text: string): Promise<string> => {
    const path = join(base, name);
    await mkdir(path);
    await writeFile(join(path, 'settings.json'), text);
    return path;
  };
  const model = (value: unknown) =>
    JSON.stringify({ model: value, theme: 'dark' });

  // An Opus default stays exactly as written, so the 1M context stays too.
  for (const kept of [
    'opus',
    'opus[1m]',
    'claude-opus-5-5',
    'claude-opus-5-5[1m]',
  ])
    assert.equal(await claudeModel(await folder(kept, model(kept))), kept);
  // Any other model, and any broken file, gives opus. Verifold never picks best or fable.
  for (const [name, text] of [
    ['sonnet', model('sonnet')],
    ['best', model('best')],
    ['fable', model('fable')],
    ['opus-2m', model('opus[2m]')],
    ['number', model(5)],
    ['none', JSON.stringify({ theme: 'dark' })],
    ['garbled', '{ "model": "opus[1m]"'],
    ['array', '["opus"]'],
  ] as const)
    assert.equal(await claudeModel(await folder(name, text)), 'opus', name);
  assert.equal(await claudeModel(join(base, 'missing')), 'opus');
  // A folder in place of the file is not read.
  await mkdir(join(base, 'odd', 'settings.json'), { recursive: true });
  assert.equal(await claudeModel(join(base, 'odd')), 'opus');

  // CLAUDE_CONFIG_DIR names the folder, as it does for Claude Code.
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = await folder('configured', model('opus[1m]'));
  t.after(() => {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before;
  });
  assert.equal(await claudeModel(), 'opus[1m]');

  // The project's model for its main harness wins over the person's default.
  assert.equal(
    await labModel('claude', { host: 'claude', model: 'sonnet' }),
    'sonnet',
  );
  assert.equal(
    await labModel('claude', { host: 'codex', model: 'gpt-x' }),
    'opus[1m]',
  );
  assert.equal(await labModel('claude', null), 'opus[1m]');
  // Codex picks on its own app-server, unless the project names its model.
  assert.equal(
    await labModel('codex', { host: 'codex', model: 'gpt-x' }),
    'gpt-x',
  );
  assert.equal(
    await labModel('codex', { host: 'claude', model: 'opus' }),
    null,
  );
  assert.equal(await labModel('codex', null), null);

  // The person's profile picks a model for each harness. A project model still wins.
  const profile = {
    host: 'claude' as const,
    model: 'fable',
    helper: 'codex' as const,
    helperModel: 'gpt-6.1-sol',
  };
  assert.equal(await labModel('claude', null, profile), 'fable');
  assert.equal(await labModel('codex', null, profile), 'gpt-6.1-sol');
  assert.equal(
    await labModel('claude', { host: 'claude', model: 'sonnet' }, profile),
    'sonnet',
  );
  // A harness that the profile leaves without a model keeps the defaults.
  assert.equal(
    await labModel('claude', null, { host: 'codex', model: 'gpt-6-astra' }),
    'opus[1m]',
  );
  assert.equal(await labModel('codex', null, { host: 'claude' }), null);
});

await test("the person's Claude Code model follows Claude Code's order: the settings' env block, then ANTHROPIC_MODEL, then the model key", async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'verifold-model-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  t.after(() => {
    delete process.env.ANTHROPIC_MODEL;
  });
  const settings = (value: Record<string, unknown>) =>
    writeFile(join(base, 'settings.json'), JSON.stringify(value));
  await settings({ model: 'opus[1m]' });
  process.env.ANTHROPIC_MODEL = 'claude-opus-5-5';
  assert.equal(await claudeModel(base), 'claude-opus-5-5');
  // An ANTHROPIC_MODEL in the settings' env block replaces the one in the environment.
  await settings({
    model: 'opus[1m]',
    env: { ANTHROPIC_MODEL: 'claude-opus-5-1[1m]' },
  });
  assert.equal(await claudeModel(base), 'claude-opus-5-1[1m]');
  // An empty one there cancels the environment's, so the model key decides.
  await settings({ model: 'opus[1m]', env: { ANTHROPIC_MODEL: '' } });
  assert.equal(await claudeModel(base), 'opus[1m]');
  // A model named first wins even when it is not Opus. Verifold then asks for opus.
  await settings({ model: 'opus[1m]', env: { ANTHROPIC_MODEL: 'sonnet' } });
  assert.equal(await claudeModel(base), 'opus');
  process.env.ANTHROPIC_MODEL = 'sonnet';
  await settings({ model: 'opus[1m]' });
  assert.equal(await claudeModel(base), 'opus');
  delete process.env.ANTHROPIC_MODEL;
  assert.equal(await claudeModel(base), 'opus[1m]');
  // A model that no flag can carry is not kept.
  await settings({ model: `claude-opus-${'5'.repeat(200)}` });
  assert.equal(await claudeModel(base), 'opus');
});

await test("Codex's model list is read page by page, up to the same limit everywhere, and a refused first page gives none", () => {
  const asked: unknown[] = [];
  // A list that never ends still ends.
  const endless: CodexCall = (method, params, onResult) => {
    asked.push(params.cursor ?? null);
    onResult({ data: [{ id: `m-${asked.length}` }], nextCursor: 'more' });
  };
  const got: { models: unknown[] | null } = { models: [] };
  listCodexModels(endless, (found) => {
    got.models = found;
  });
  assert.equal(asked.length, codexModelPages);
  assert.equal(got.models?.length, codexModelPages);
  const refusing: CodexCall = (method, params, onResult, onError) =>
    onError?.();
  listCodexModels(refusing, (found) => {
    got.models = found;
  });
  assert.equal(got.models, null);
  // A refused later page keeps the models of the pages before it.
  let pages = 0;
  const halfway: CodexCall = (method, params, onResult, onError) => {
    pages += 1;
    if (pages === 1)
      onResult({ data: [{ id: 'gpt-6-astra' }], nextCursor: 'more' });
    else onError?.();
  };
  listCodexModels(halfway, (found) => {
    got.models = found;
  });
  assert.deepEqual(got.models, [{ id: 'gpt-6-astra' }]);
});

await test('a model ID may end in a short suffix in brackets, and has at most 200 characters either way', () => {
  validateModel('opus[1m]');
  validateModel('claude-opus-5-5[1m]');
  validateModel('m'.repeat(200));
  validateModel(`${'m'.repeat(196)}[1m]`);
  for (const bad of [
    'opus[1m',
    'opus[]',
    'opus[1M]',
    '[1m]',
    'opus[1m] x',
    'opus[1m][1m]',
    'm'.repeat(201),
    `${'m'.repeat(197)}[1m]`,
  ])
    assert.throws(() => validateModel(bad), /valid identifier/, bad);
});
