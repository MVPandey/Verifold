import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { claudeModel, pickCodexModel } from '../src/cli/models.ts';

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

await test('Claude Code gets best only on a Max plan, and opus otherwise', async (t) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'verifold-model-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  /** A fake `claude` that records its arguments and environment, then prints `output` and exits with `code`. */
  const fake = async (name: string, output: string, code = 0) => {
    const path = join(base, name);
    await writeFile(
      path,
      `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(`${path}.seen.json`)}, JSON.stringify({ args: process.argv.slice(2), runpod: process.env.RUNPOD_API_KEY ?? null }));
process.stdout.write(${JSON.stringify(output)});
process.exit(${code});
`,
      { mode: 0o700 },
    );
    return path;
  };
  const status = (fields: Record<string, unknown>) =>
    JSON.stringify({ loggedIn: true, apiProvider: 'firstParty', ...fields });
  const before = process.env.RUNPOD_API_KEY;
  process.env.RUNPOD_API_KEY = 'secret-runpod-key';
  t.after(() => {
    if (before === undefined) delete process.env.RUNPOD_API_KEY;
    else process.env.RUNPOD_API_KEY = before;
  });

  const max = await fake(
    'max',
    status({ authMethod: 'claude.ai', subscriptionType: 'max' }),
  );
  assert.equal(await claudeModel(max), 'best');
  const seen = JSON.parse(await readFile(`${max}.seen.json`, 'utf8')) as {
    args: string[];
    runpod: string | null;
  };
  assert.deepEqual(seen.args, ['auth', 'status', '--json']);
  // The status command gets the same environment as a harness: no RunPod key.
  assert.equal(seen.runpod, null);

  for (const [name, output, code] of [
    ['pro', status({ authMethod: 'claude.ai', subscriptionType: 'pro' }), 0],
    // An API key bills at API rates, also for a person on a Max plan.
    ['api', status({ authMethod: 'apiKey', subscriptionType: 'max' }), 0],
    ['unknown', status({ authMethod: 'claude.ai' }), 0],
    ['signed-out', JSON.stringify({ loggedIn: false }), 1],
    ['garbled', 'not json', 0],
  ] as const)
    assert.equal(
      await claudeModel(await fake(name, output, code)),
      'opus',
      name,
    );
  assert.equal(await claudeModel(join(base, 'missing')), 'opus');
});
