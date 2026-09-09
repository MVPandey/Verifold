import { mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseWorkspace } from './contracts.ts';
import type { Workspace } from './contracts.ts';

export async function readJson(path: string): Promise<unknown> {
  const handle = await open(path, 'r');
  try {
    if ((await handle.stat()).size > 1_000_000)
      throw new Error('JSON input exceeds 1 MB.');
    const value: unknown = JSON.parse(await handle.readFile('utf8'));
    return value;
  } finally {
    await handle.close();
  }
}
export async function loadWorkspace(root: string): Promise<Workspace> {
  return parseWorkspace(
    await readJson(join(root, '.verifold', 'workspace.json')),
  );
}
/** Atomic private state writes under an exclusive mutation lock; no overwrite on initialization. */
export async function changeWorkspace(
  root: string,
  update: (current: Workspace | null) => Workspace,
): Promise<Workspace> {
  const directory = join(root, '.verifold');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error('.verifold must not be a symbolic link.');
  // Protect research data before creating it, including inside an existing Git repo.
  const ignore = join(root, '.gitignore');
  let rules = '';
  try {
    rules = await readFile(ignore, 'utf8');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  if (!rules.split('\n').includes('/.verifold/')) {
    const file = await open(ignore, 'a', 0o600);
    try {
      await file.write(
        `${rules.endsWith('\n') || !rules ? '' : '\n'}/.verifold/\n`,
      );
    } finally {
      await file.close();
    }
  }
  const lockPath = join(directory, 'write.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  const temporary = join(directory, `${randomUUID()}.tmp`);
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
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(next, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, 'workspace.json'));
    return next;
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
