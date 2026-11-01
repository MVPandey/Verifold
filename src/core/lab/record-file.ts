import { lstat, readFile } from 'node:fs/promises';
import { object } from '../board.ts';
import { writePrivateFile } from '../storage.ts';

/** A lab record: a JSON object of at most 4 MB, or null for anything else. */
export async function readObject(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.size > 4_000_000) return null;
    return object(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Saves of one record. Each save writes the newest value, and saves that come
 * while one writes join the next write, so an older value never lands last.
 * The write loop ends in the same step in which it finds nothing new, so a
 * save that comes after it starts a new write.
 */
export class RecordFile {
  private dirty = false;
  private writing: Promise<void> | null = null;
  private readonly path: string;
  private readonly value: () => unknown;

  constructor(path: string, value: () => unknown) {
    this.path = path;
    this.value = value;
  }

  save(): Promise<void> {
    this.dirty = true;
    this.writing ??= this.write();
    return this.writing;
  }

  private async write(): Promise<void> {
    // The caller keeps this promise before the loop can end.
    await Promise.resolve();
    try {
      while (this.dirty) {
        this.dirty = false;
        const value = this.value();
        // The record is gone, for example after Start over.
        if (value === null || value === undefined) continue;
        try {
          await writePrivateFile(
            this.path,
            `${JSON.stringify(value, null, 2)}\n`,
          );
        } catch (error) {
          // The newest value is not on disk: the next save or a flush writes it.
          this.dirty = true;
          throw error;
        }
      }
    } finally {
      this.writing = null;
    }
  }

  /** Wait until the newest value is on disk. A write that failed is tried once more. */
  async flush(): Promise<void> {
    await this.writing?.catch(() => {});
    if (this.dirty) await this.save().catch(() => {});
  }
}
