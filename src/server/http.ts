import type { IncomingMessage } from 'node:http';
import { extname } from 'node:path';

/** The content types of the files that the desk serves, by extension. One table for the desk's assets and the app's build. */
const contentTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
};

/** The content type of a file the desk serves. Throws for an extension that the table does not name, so a new kind of file fails at startup, never later in a browser. */
export function contentType(name: string): string {
  const type = contentTypes[extname(name)];
  if (!type)
    throw new Error(
      `The desk has no content type for ${name}. Add its extension to the table in src/server/http.ts.`,
    );
  return type;
}

/** Read a JSON request body up to `limit` bytes. Returns null when it is too large or unreadable. */
export async function readJsonBody(
  request: IncomingMessage,
  limit: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
