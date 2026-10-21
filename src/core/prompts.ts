import { readFile } from 'node:fs/promises';

/**
 * Read one bundled prompt. Each layer keeps its own prompt IDs and its own
 * `prompts/` folder and passes both here, so removing a layer never touches
 * this reader. An ID outside the layer's list never becomes a path.
 */
export async function readPrompt(
  folder: URL,
  ids: readonly string[],
  id: string,
): Promise<string> {
  if (!ids.includes(id)) throw new Error('Unknown prompt ID.');
  const content = await readFile(new URL(`${id}.md`, folder), 'utf8');
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

/** The lab's prompts, in `src/core/prompts/`. */
export const promptIds = [
  'lab-peer',
  'lab-opener',
  'lab-runs',
  'lab-pods',
  'lab-check',
] as const;

export type PromptId = (typeof promptIds)[number];

/** Resolve bundled instructions independently of the user's project directory. */
export async function loadPrompt(id: PromptId): Promise<string> {
  return readPrompt(new URL('./prompts/', import.meta.url), promptIds, id);
}
