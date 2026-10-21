import { readPrompt } from '../core/prompts.ts';

/** The prompts of setup, the profile and the CLI's research commands, in `src/cli/prompts/`. */
export const promptIds = [
  'profile-summary',
  'profile-history',
  'research-interview',
  'interview-scope',
  'project-interview-scope',
  'topic-interview-scope',
  'project-context',
  'project-intake',
  'project-direction',
  'interview-finish',
  'interview-followup',
  'interview-quick',
  'recommendation-request',
  'literature-request',
  'literature-memory',
  'pilot-request',
] as const;

export type PromptId = (typeof promptIds)[number];

/** Resolve bundled instructions independently of the user's project directory. */
export async function loadPrompt(id: PromptId): Promise<string> {
  return readPrompt(new URL('./prompts/', import.meta.url), promptIds, id);
}
