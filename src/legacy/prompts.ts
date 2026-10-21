import { readPrompt } from '../core/prompts.ts';

/** The old manager's prompts, in `src/legacy/prompts/`. */
export const promptIds = [
  'research-rules',
  'research-plan',
  'research-report',
  'task-worker',
  'coordinator',
] as const;

export type PromptId = (typeof promptIds)[number];

/** Resolve bundled instructions independently of the user's project directory. */
export async function loadPrompt(id: PromptId): Promise<string> {
  return readPrompt(new URL('./prompts/', import.meta.url), promptIds, id);
}
