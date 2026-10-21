import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateModel } from '../src/core/harness.ts';
import {
  claudeModel,
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
  // Without a known model, the one that Codex marks as its default.
  assert.equal(
    pickCodexModel([
      { id: 'other', model: 'gpt-7-nova' },
      { id: 'mini', model: 'gpt-7-mini', isDefault: true },
    ]),
    'gpt-7-mini',
  );
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

await test("Codex's model list is read page by page, up to the same limit everywhere, and a refusal gives none", () => {
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
});

await test('a model ID may end in a short suffix in brackets', () => {
  validateModel('opus[1m]');
  validateModel('claude-opus-5-5[1m]');
  for (const bad of [
    'opus[1m',
    'opus[]',
    'opus[1M]',
    '[1m]',
    'opus[1m] x',
    'opus[1m][1m]',
  ])
    assert.throws(() => validateModel(bad), /valid identifier/, bad);
});
