import { mkdir, open, rename, rm, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseWorkspace } from './contracts.ts';
import type { Workspace } from './contracts.ts';

export async function readJson(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('JSON input must be a regular file.');
    if (stats.size > 1_000_000) throw new Error('JSON input exceeds 1 MB.');
    const value: unknown = JSON.parse(await handle.readFile('utf8'));
    return value;
  } finally {
    await handle.close();
  }
}
export async function loadWorkspace(root: string): Promise<Workspace> {
  if ((await lstat(join(root, '.verifold'))).isSymbolicLink())
    throw new Error('.verifold must not be a symbolic link.');
  return parseWorkspace(
    await readJson(join(root, '.verifold', 'workspace.json')),
  );
}
/** Atomic private state writes under an exclusive mutation lock; no overwrite on initialization. */
export async function changeWorkspace(
  root: string,
  update: (current: Workspace | null) => Workspace,
  preparation?: {
    readonly apply: () => Promise<void>;
    readonly rollback: () => Promise<void>;
  },
): Promise<Workspace> {
  const directory = join(root, '.verifold');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error('.verifold must not be a symbolic link.');
  // Protect research data before creating it, including inside an existing Git repo.
  const ignore = join(root, '.gitignore');
  const ignoreFile = await open(
    ignore,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_APPEND |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stats = await ignoreFile.stat();
    if (!stats.isFile()) throw new Error('.gitignore must be a regular file.');
    if (stats.size > 1_000_000) throw new Error('.gitignore exceeds 1 MB.');
    const rules = await ignoreFile.readFile('utf8');
    const missingRules = ['/.verifold/', '/.verifold.md'].filter(
      (rule) => !rules.split('\n').includes(rule),
    );
    if (missingRules.length) {
      await ignoreFile.write(
        `${rules.endsWith('\n') || !rules ? '' : '\n'}${missingRules.join('\n')}\n`,
      );
    }
  } finally {
    await ignoreFile.close();
  }
  const lockPath = join(directory, 'write.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  const temporary = join(directory, `${randomUUID()}.tmp`);
  let preparing = false;
  try {
    let current: Workspace | null = null;
    try {
      current = await loadWorkspace(root);
    } catch (error) {
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        throw error;
    }
    const next = parseWorkspace(update(current));
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > 1_000_000) {
      throw new Error(
        'Workspace exceeds the 1 MB storage limit. Reduce the imported research output.',
      );
    }
    preparing = preparation !== undefined;
    await preparation?.apply();
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(serialized);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, 'workspace.json'));
    return next;
  } catch (error) {
    if (preparing) await preparation?.rollback();
    throw error;
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
