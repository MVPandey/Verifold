import { readFile } from 'node:fs/promises';

// Each prompt lives in the folder of the layer that uses it.
const promptFolders = {
  cli: [
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
  ],
  legacy: [
    'research-rules',
    'research-plan',
    'research-report',
    'recommendation-request',
    'literature-request',
    'literature-memory',
    'pilot-request',
    'task-worker',
    'coordinator',
  ],
  core: ['lab-peer', 'lab-opener', 'lab-runs', 'lab-pods', 'lab-check'],
} as const;

type PromptFolder = keyof typeof promptFolders;

export type PromptId = (typeof promptFolders)[PromptFolder][number];

const promptFolder = new Map<string, PromptFolder>();
for (const folder of ['cli', 'legacy', 'core'] as const)
  for (const id of promptFolders[folder]) promptFolder.set(id, folder);

/** Resolve bundled instructions independently of the user's project directory. */
export async function loadPrompt(id: PromptId): Promise<string> {
  const folder = promptFolder.get(id);
  if (!folder) throw new Error('Unknown prompt ID.');
  const content = await readFile(
    new URL(`../${folder}/prompts/${id}.md`, import.meta.url),
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
