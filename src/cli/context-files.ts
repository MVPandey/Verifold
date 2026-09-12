import { lstat, opendir } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { readMemory } from './agency.ts';

export function projectContextFile(name: string): boolean {
  return /^(README(?:\.[\w-]+)?|AGENTS\.md|CLAUDE\.md|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Makefile)$/i.test(
    name,
  );
}

/** Native JSONL imports keep user text, excluding tool results and model claims. */
function userMessages(content: string): string {
  const messages: string[] = [];
  for (const line of content.split('\n')) {
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object') continue;
      const message =
        'message' in value
          ? value.message
          : 'payload' in value
            ? value.payload
            : value;
      if (
        !message ||
        typeof message !== 'object' ||
        !('role' in message) ||
        message.role !== 'user' ||
        !('content' in message)
      )
        continue;
      if (typeof message.content === 'string') messages.push(message.content);
      else if (Array.isArray(message.content))
        for (const block of message.content as unknown[])
          if (
            block &&
            typeof block === 'object' &&
            'type' in block &&
            (block.type === 'text' || block.type === 'input_text') &&
            'text' in block &&
            typeof block.text === 'string'
          )
            messages.push(block.text);
    } catch {
      // Incomplete or unsupported transcript records are not profile evidence.
    }
  }
  return messages.join('\n\n');
}

/** Read a bounded selection after consent. Never traverse links or hidden directories. */
export async function contextFiles(
  root: string,
  kind: 'chats' | 'project',
  signal: AbortSignal,
): Promise<string> {
  const sources: { path: string; modified: number }[] = [];
  let inspected = 0;
  let skipped = 0;
  async function scan(path: string, depth: number): Promise<void> {
    signal.throwIfAborted();
    let entry;
    try {
      entry = await lstat(path);
    } catch {
      skipped++;
      return;
    }
    if (entry.isSymbolicLink()) {
      skipped++;
      return;
    }
    if (entry.isFile()) {
      const name = basename(path);
      const allowed =
        kind === 'chats'
          ? ['.md', '.txt', '.json', '.jsonl'].includes(extname(name))
          : projectContextFile(name);
      if (allowed && entry.size <= 256000)
        sources.push({ path, modified: entry.mtimeMs });
      else skipped++;
      return;
    }
    if (!entry.isDirectory() || depth > (kind === 'chats' ? 4 : 0)) return;
    let directory;
    try {
      directory = await opendir(path);
    } catch {
      skipped++;
      return;
    }
    for await (const child of directory) {
      if (inspected >= 200) break;
      inspected++;
      if (
        child.name.startsWith('.') ||
        ['node_modules', 'vendor', 'dist', 'subagents'].includes(child.name)
      )
        continue;
      await scan(join(path, child.name), depth + 1);
    }
  }
  await scan(root, 0);
  sources.sort((a, b) => b.modified - a.modified);
  const sections: string[] = [];
  let bytes = 0;
  for (const source of sources.slice(0, 10)) {
    signal.throwIfAborted();
    try {
      const raw = await readMemory(
        source.path,
        Math.min(256000, 512000 - bytes),
      );
      bytes += Buffer.byteLength(raw);
      const content =
        kind === 'chats' && extname(source.path) === '.jsonl'
          ? userMessages(raw)
          : raw;
      if (!content.trim()) {
        skipped++;
        continue;
      }
      sections.push(
        `Source: ${JSON.stringify(source.path)}\nText: ${JSON.stringify(content)}`,
      );
    } catch {
      skipped++;
    }
  }
  if (!sections.length)
    throw new Error(
      'No readable context files were found within the selected limits.',
    );
  return `Selected evidence only: ${sections.length} files, ${bytes} bytes. Scan limited to 200 entries and 10 files; ${skipped} files skipped. This is not a complete history or repository audit.\n\n${sections.join('\n\n')}`;
}
