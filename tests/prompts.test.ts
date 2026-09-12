import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPrompt, type PromptId } from '../src/cli/prompts.ts';

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
