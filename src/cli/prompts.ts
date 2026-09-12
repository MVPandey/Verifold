import { readFile } from 'node:fs/promises';

const promptIds = [
  'profile-summary',
  'research-interview',
  'interview-scope',
  'project-interview-scope',
  'project-context',
  'project-intake',
  'project-direction',
  'research-rules',
  'research-plan',
  'research-report',
  'recommendation-request',
  'literature-request',
  'literature-memory',
  'pilot-request',
  'interview-finish',
  'interview-followup',
] as const;

export type PromptId = (typeof promptIds)[number];

/** Resolve bundled instructions independently of the user's project directory. */
export async function loadPrompt(id: PromptId): Promise<string> {
  if (!promptIds.includes(id)) throw new Error('Unknown prompt ID.');
  const content = await readFile(
    new URL(`./prompts/${id}.md`, import.meta.url),
    'utf8',
  );
  if (
    !content.trim() ||
    Buffer.byteLength(content) > 65536 ||
    content.includes('\0')
  ) {
    throw new Error(
      `Prompt ${id} must contain 1 to 65536 bytes of plain text.`,
    );
  }
  return content.trimEnd();
}
