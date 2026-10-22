import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { parseResearchPlan } from '../src/core/research-contracts.ts';
import { parseReport } from '../src/legacy/research.ts';
import {
  loadPrompt as corePrompt,
  promptIds as corePromptIds,
  type PromptId as CorePromptId,
} from '../src/core/prompts.ts';
import {
  loadPrompt as legacyPrompt,
  type PromptId as LegacyPromptId,
} from '../src/legacy/prompts.ts';
import {
  loadPrompt as cliPrompt,
  type PromptId as CliPromptId,
} from '../src/cli/prompts.ts';

/** The prompt loader of one layer, `src/<layer>/prompts.ts`. */
interface PromptLayer {
  readonly promptIds: readonly string[];
  readonly loadPrompt: (id: string) => Promise<string>;
}

function isPromptLayer(value: unknown): value is PromptLayer {
  return (
    typeof value === 'object' &&
    value !== null &&
    'promptIds' in value &&
    Array.isArray(value.promptIds) &&
    value.promptIds.every((id) => typeof id === 'string') &&
    'loadPrompt' in value &&
    typeof value.loadPrompt === 'function'
  );
}

await test('each layer registers exactly the prompts in its folder, once across all layers', async () => {
  const src = new URL('../src/', import.meta.url);
  const owner = new Map<string, string>();
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = await readdir(new URL(`${entry.name}/prompts/`, src)).catch(
      (error: unknown) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return null;
        throw error;
      },
    );
    if (!files) continue;
    const layer: unknown = await import(
      new URL(`${entry.name}/prompts.ts`, src).href
    );
    assert.ok(
      isPromptLayer(layer),
      `src/${entry.name}/prompts.ts must export promptIds and loadPrompt`,
    );
    assert.deepEqual(
      files.filter((file) => !file.endsWith('.md')),
      [],
      `src/${entry.name}/prompts/ holds only Markdown prompts`,
    );
    assert.deepEqual(
      [...layer.promptIds].sort(),
      files.map((file) => file.slice(0, -'.md'.length)).sort(),
      `src/${entry.name}: each file is registered and each ID has a file`,
    );
    for (const id of layer.promptIds) {
      assert.equal(
        owner.get(id),
        undefined,
        `${id} is registered in ${owner.get(id) ?? ''} and in ${entry.name}`,
      );
      owner.set(id, entry.name);
      assert.ok((await layer.loadPrompt(id)).trim(), `${entry.name}: ${id}`);
    }
  }
  assert.ok(owner.size > 0, 'No prompt folder was found under src/.');
});

await test('research response examples satisfy the actual phase contracts', async () => {
  for (const [id, parse] of [
    ['research-plan', parseResearchPlan],
    ['research-report', parseReport],
  ] as const) {
    const example = (await legacyPrompt(id))
      .split('\n')
      .find((line) => line.startsWith('{'));
    assert.ok(example, `Missing JSON example in ${id}`);
    const value: unknown = JSON.parse(example);
    assert.doesNotThrow(() => parse(value));
  }
});

await test('prompt IDs cannot resolve paths outside the prompt directory', async () => {
  await assert.rejects(
    corePrompt('../agency' as CorePromptId),
    /Unknown prompt ID/,
  );
  await assert.rejects(
    legacyPrompt('../agency' as LegacyPromptId),
    /Unknown prompt ID/,
  );
  await assert.rejects(
    cliPrompt('../agency' as CliPromptId),
    /Unknown prompt ID/,
  );
});

await test('profile and research prompts preserve distinct tool permissions', async () => {
  assert.match(
    await cliPrompt('profile-summary'),
    /Do not browse, read other files/,
  );
  assert.match(
    await legacyPrompt('research-rules'),
    /Use your own tools, permissions, and native subagents/,
  );
});

await test("the lab's prompts send the person to the project's settings, which the old desk called Compute", async () => {
  for (const id of corePromptIds)
    assert.doesNotMatch(await corePrompt(id), /\bCompute\b/, id);
  assert.match(
    await corePrompt('lab-peer'),
    /a RunPod key, or a spend limit in the project's settings/,
  );
});

await test('lab agents write their evidence in plain words, with a metric code name only when it helps', async () => {
  const prompt = await corePrompt('lab-peer');
  assert.match(
    prompt,
    /plain words that the person can read without your code/,
  );
  assert.match(prompt, /Say in words what each metric measures/);
});
