import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPrompt, type PromptId } from '../src/cli/prompts.ts';
import { readdir } from 'node:fs/promises';
import { parseResearchPlan } from '../src/cli/research-contracts.ts';
import { parseReport } from '../src/cli/research.ts';

await test('every bundled Markdown prompt is registered and readable', async () => {
  const files = await readdir(new URL('../src/cli/prompts/', import.meta.url));
  for (const file of files.filter((file) => file.endsWith('.md'))) {
    const prompt = await loadPrompt(file.slice(0, -3) as PromptId);
    assert.ok(prompt.trim(), file);
  }
});

await test('research response examples satisfy the actual phase contracts', async () => {
  for (const [id, parse] of [
    ['research-plan', parseResearchPlan],
    ['research-report', parseReport],
  ] as const) {
    const example = (await loadPrompt(id))
      .split('\n')
      .find((line) => line.startsWith('{'));
    assert.ok(example, `Missing JSON example in ${id}`);
    const value: unknown = JSON.parse(example);
    assert.doesNotThrow(() => parse(value));
  }
});

await test('prompt IDs cannot resolve paths outside the prompt directory', async () => {
  await assert.rejects(
    loadPrompt('../agency' as PromptId),
    /Unknown prompt ID/,
  );
});

await test('profile and research prompts preserve distinct tool permissions', async () => {
  assert.match(
    await loadPrompt('profile-summary'),
    /Do not browse, read other files/,
  );
  assert.match(
    await loadPrompt('research-rules'),
    /Use your own tools, permissions, and native subagents/,
  );
});
