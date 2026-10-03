import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative } from 'node:path';

/**
 * Task workspaces. Every workspace is Git-backed, so versions and diffs work the
 * same way for every project: a worktree of the project repository, or a task
 * folder with a separate Git directory under `.verifold/tasks/git/`. Verifold
 * makes all commits. The agent does not need Git.
 */

export interface Workspace {
  readonly kind: 'git' | 'folder';
  /** Relative to the project root. */
  readonly path: string;
  readonly branch: string | null;
  /** The start state: the commit that each version is compared with. */
  readonly start: string;
}

export interface ChangedFile {
  readonly path: string;
  readonly change: 'added' | 'modified' | 'deleted';
  /** A regular file, or a deleted one. Symbolic links and submodules are not. */
  readonly regular: boolean;
}

export class WorkspaceError extends Error {}

/** Limits on what one workspace copies and keeps. */
const limits = {
  files: 5000,
  bytes: 200 * 1024 * 1024,
  fileBytes: 50 * 1024 * 1024,
  diffBytes: 512 * 1024,
};

/**
 * The environment for Git. Variables such as GIT_DIR, GIT_INDEX_FILE, and
 * GIT_AUTHOR_NAME would point Git at another repository or another author, for
 * example when Verifold runs inside a Git hook. So none of them pass through.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    ),
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

/**
 * Run Git without a shell, for at most one minute. User hooks, signing, and
 * external diff tools do not run, and Verifold commits under its own name.
 */
function git(cwd: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Verifold',
        '-c',
        'user.email=verifold@localhost',
        '-c',
        'core.quotepath=off',
        ...args,
      ],
      {
        cwd,
        encoding: 'buffer',
        maxBuffer: 64 * 1024 * 1024,
        timeout: 60_000,
        env: gitEnvironment(),
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new WorkspaceError(
              `Git failed: ${stderr.toString('utf8').trim().split('\n')[0]?.slice(0, 300) || error.message}`,
              { cause: error },
            ),
          );
        else resolve(stdout);
      },
    );
  });
}

async function list(cwd: string, args: readonly string[]): Promise<string[]> {
  return (await git(cwd, args)).toString('utf8').split('\0').filter(Boolean);
}

async function head(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).toString('utf8').trim();
}

/** A clean relative path inside the project, or an error. Paths use forward slashes. `.` is the project. */
export function projectPath(value: unknown): string {
  if (typeof value !== 'string')
    throw new WorkspaceError('Each path must be text.');
  const trimmed = value.trim().replaceAll('\\', '/');
  const parts = trimmed.split('/').filter((part) => part && part !== '.');
  if (
    !trimmed ||
    trimmed.startsWith('/') ||
    trimmed.length > 300 ||
    parts.includes('..') ||
    /[\0\n\r*?[\]]/.test(trimmed)
  )
    throw new WorkspaceError(
      `Use a path inside the project, without wildcards: ${trimmed.slice(0, 80) || '(empty)'}.`,
    );
  const path = parts.join('/') || '.';
  if (['.git', '.verifold'].includes(parts[0] ?? ''))
    throw new WorkspaceError(`${path} holds Git or Verifold data.`);
  return path;
}

/** Whether `path` is inside one of the writable paths. */
export function inScope(path: string, writable: readonly string[]): boolean {
  return writable.some(
    (scope) => scope === '.' || path === scope || path.startsWith(`${scope}/`),
  );
}

/** Two scopes overlap when a path of one contains a path of the other. */
export function overlaps(
  first: readonly string[],
  second: readonly string[],
): boolean {
  return first.some((a) =>
    second.some((b) => inScope(a, [b]) || inScope(b, [a])),
  );
}

/** The project is the top level of a Git repository with at least one commit. */
async function gitProject(root: string): Promise<boolean> {
  try {
    const top = (await git(root, ['rev-parse', '--show-toplevel']))
      .toString('utf8')
      .trim();
    await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return (await realpath(top)) === (await realpath(root));
  } catch {
    return false;
  }
}

/** Fail when a path, or its nearest existing parent, resolves outside the project. */
async function contained(root: string, path: string): Promise<void> {
  const base = await realpath(root);
  for (let current = path; ; current = dirname(current)) {
    const real = await realpath(current).catch(() => null);
    if (real) {
      const rel = relative(base, real);
      if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
        throw new WorkspaceError(
          `${relative(root, path)} leads outside the project.`,
        );
      return;
    }
    if (dirname(current) === current) return;
  }
}

/** Regular files under `path` in a folder, within the limits. Symbolic links are skipped. */
async function walk(root: string, path: string): Promise<string[]> {
  const found: string[] = [];
  let bytes = 0;
  const visit = async (rel: string): Promise<void> => {
    const stats = await lstat(join(root, rel)).catch(() => null);
    if (!stats || stats.isSymbolicLink()) return;
    if (stats.isFile()) {
      bytes += stats.size;
      found.push(rel);
      if (found.length > limits.files || bytes > limits.bytes)
        throw new WorkspaceError(
          `The writable paths hold more than ${limits.files} files or ${limits.bytes / 1024 / 1024} MB.`,
        );
      return;
    }
    if (!stats.isDirectory()) return;
    for (const name of (await readdir(join(root, rel))).sort())
      if (rel !== '.' || !['.git', '.verifold'].includes(name))
        await visit(rel === '.' ? name : `${rel}/${name}`);
  };
  await visit(path);
  return found;
}

/**
 * The project files that the start state takes from the working folder. In a
 * Git project, the worktree already has the last commit, so only uncommitted
 * changes count: changed, new, and deleted files. Ignored files stay out.
 */
async function startFiles(
  root: string,
  kind: Workspace['kind'],
  writable: readonly string[],
): Promise<string[]> {
  if (kind === 'folder')
    return (await Promise.all(writable.map((path) => walk(root, path)))).flat();
  const changed = await list(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--no-renames',
    '--untracked-files=all',
    '--',
    ...writable,
  ]);
  if (changed.length > limits.files)
    throw new WorkspaceError(
      `The writable paths have more than ${limits.files} uncommitted changes.`,
    );
  return changed.map((entry) => entry.slice(3));
}

/**
 * Commit everything in the workspace. Inside writable paths, ignored files
 * count too, so output in an ignored folder is kept. Files above the size limit
 * stay out of the commit and are listed.
 */
async function commitAll(
  target: string,
  writable: readonly string[],
  message: string,
): Promise<{ readonly commit: string; readonly skipped: readonly string[] }> {
  // Git refuses a path that does not exist. A writable folder can be new.
  const forced: string[] = [];
  for (const path of writable)
    if (path !== '.' && (await lstat(join(target, path)).catch(() => null)))
      forced.push(path);
  const pending = new Set([
    ...(await list(target, [
      'status',
      '--porcelain=v1',
      '-z',
      '--no-renames',
      '--untracked-files=all',
    ])),
    ...(forced.length
      ? await list(target, [
          'status',
          '--porcelain=v1',
          '-z',
          '--no-renames',
          '--untracked-files=all',
          '--ignored=matching',
          '--',
          ...forced,
        ])
      : []),
  ]);
  if (pending.size > limits.files)
    throw new WorkspaceError(
      `The workspace changed more than ${limits.files} files, so Verifold did not save a version.`,
    );
  const skipped: string[] = [];
  for (const entry of pending) {
    const file = entry.slice(3);
    const stats = await lstat(join(target, file)).catch(() => null);
    if (stats?.isFile() && stats.size > limits.fileBytes) skipped.push(file);
  }
  const exclude = skipped.map((file) => `:(exclude,literal)${file}`);
  await git(target, ['add', '--all', '--', '.', ...exclude]);
  if (forced.length)
    await git(target, ['add', '--all', '--force', '--', ...forced, ...exclude]);
  await git(target, [
    'commit',
    '--quiet',
    '--no-verify',
    '--allow-empty',
    '-m',
    message,
  ]);
  return { commit: await head(target), skipped };
}

/**
 * Create the workspace of one attempt and commit its start state: the writable
 * paths as they are in the project now, plus the recorded input copies. So the
 * agent starts from uncommitted work too, and Accept can see whether the
 * project changed since the start.
 */
export async function allocate(
  root: string,
  options: {
    readonly name: string;
    readonly writable: readonly string[];
    /** Project path of each input and the file that holds its recorded copy. */
    readonly inputs: readonly {
      readonly path: string;
      readonly copy: string;
    }[];
  },
): Promise<Workspace> {
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(options.name))
    throw new WorkspaceError('Invalid workspace name.');
  const path = join('.verifold', 'workspaces', options.name);
  const target = join(root, path);
  await mkdir(join(root, '.verifold', 'workspaces'), {
    recursive: true,
    mode: 0o700,
  });
  if ((await lstat(target).catch(() => null)) !== null)
    throw new WorkspaceError(`The workspace ${options.name} already exists.`);
  const kind = (await gitProject(root)) ? 'git' : 'folder';
  for (const writable of options.writable)
    await contained(root, join(root, writable));
  const copies = await startFiles(root, kind, options.writable);
  let branch: string | null = null;
  if (kind === 'git') {
    branch = `verifold/${options.name}`;
    await git(root, [
      'worktree',
      'add',
      '--quiet',
      '-b',
      branch,
      target,
      'HEAD',
    ]);
  } else {
    const gitDir = join(root, '.verifold', 'tasks', 'git', options.name);
    await mkdir(dirname(gitDir), { recursive: true, mode: 0o700 });
    await mkdir(target, { mode: 0o700 });
    await git(target, ['init', '--quiet', `--separate-git-dir=${gitDir}`]);
  }
  for (const file of copies) {
    const stats = await lstat(join(root, file)).catch(() => null);
    if (stats?.isFile()) {
      await mkdir(dirname(join(target, file)), { recursive: true });
      await copyFile(join(root, file), join(target, file));
    } else if (!stats) await rm(join(target, file), { force: true });
  }
  for (const input of options.inputs) {
    await mkdir(dirname(join(target, input.path)), { recursive: true });
    await copyFile(input.copy, join(target, input.path));
  }
  const { commit } = await commitAll(
    target,
    options.writable,
    'Verifold: task start',
  );
  return { kind, path, branch, start: commit };
}

/** Commit the workspace as one version. */
export function commitVersion(
  root: string,
  workspace: Workspace,
  writable: readonly string[],
  message: string,
): Promise<{ readonly commit: string; readonly skipped: readonly string[] }> {
  return commitAll(join(root, workspace.path), writable, message);
}

const changeNames: Record<string, ChangedFile['change']> = {
  A: 'added',
  M: 'modified',
  T: 'modified',
  D: 'deleted',
};

/** The files that differ between two commits of a workspace. */
export async function changes(
  root: string,
  workspace: Workspace,
  from: string,
  to: string,
): Promise<ChangedFile[]> {
  const fields = (
    await git(join(root, workspace.path), [
      'diff',
      '--raw',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      from,
      to,
    ])
  )
    .toString('utf8')
    .split('\0');
  const found: ChangedFile[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [, mode = '', status = ''] =
      /^:\d+ (\d+) [0-9a-f]+ [0-9a-f]+ ([A-Z])/.exec(fields[index] ?? '') ?? [];
    const path = fields[index + 1] ?? '';
    const change = changeNames[status];
    if (!change || !path) continue;
    found.push({
      path,
      change,
      regular: change === 'deleted' || mode === '100644' || mode === '100755',
    });
  }
  return found;
}

/** The text diff of one file, cut at the limit. Binary files say so. */
export async function diff(
  root: string,
  workspace: Workspace,
  from: string,
  to: string,
  path: string,
): Promise<{ readonly text: string; readonly cut: boolean }> {
  const output = await git(join(root, workspace.path), [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--no-renames',
    from,
    to,
    '--',
    `:(literal)${path}`,
  ]);
  return output.length > limits.diffBytes
    ? { text: output.subarray(0, limits.diffBytes).toString('utf8'), cut: true }
    : { text: output.toString('utf8'), cut: false };
}

/** The content of a file at a commit, or null when it does not exist there. */
async function fileAt(
  target: string,
  commit: string,
  path: string,
): Promise<Buffer | null> {
  try {
    await git(target, ['cat-file', '-e', `${commit}:${path}`]);
  } catch {
    return null;
  }
  return git(target, ['cat-file', 'blob', `${commit}:${path}`]);
}

/**
 * Copy the selected files of a version into the project. Each file in the
 * project must still match its start content, or nothing is copied. New
 * content goes to temporary files first, then each one is renamed.
 */
export async function integrate(
  root: string,
  workspace: Workspace,
  version: string,
  paths: readonly string[],
): Promise<
  | { readonly applied: readonly string[] }
  | { readonly conflicts: readonly string[] }
> {
  const target = join(root, workspace.path);
  const modes = new Map(
    (await list(target, ['ls-tree', '-r', '-z', version])).map((line) => {
      const [meta = '', path = ''] = line.split('\t');
      return [path, meta.split(' ')[0] ?? ''];
    }),
  );
  const conflicts: string[] = [];
  const plan: { path: string; content: Buffer | null }[] = [];
  for (const path of paths) {
    const destination = join(root, path);
    await contained(root, destination);
    const stats = await lstat(destination).catch(() => null);
    const current = !stats
      ? null
      : stats.isFile()
        ? await readFile(destination)
        : undefined;
    const start = await fileAt(target, workspace.start, path);
    const unchanged =
      current === null
        ? start === null
        : current !== undefined && start !== null && current.equals(start);
    if (!unchanged) conflicts.push(path);
    else plan.push({ path, content: await fileAt(target, version, path) });
  }
  if (conflicts.length) return { conflicts };
  const staged: { temporary: string; destination: string }[] = [];
  try {
    for (const { path, content } of plan) {
      if (content === null) continue;
      const destination = join(root, path);
      await mkdir(dirname(destination), { recursive: true });
      await contained(root, destination);
      const temporary = `${destination}.${randomBytes(4).toString('hex')}.verifold`;
      await writeFile(temporary, content, { flag: 'wx', mode: 0o644 });
      if (modes.get(path) === '100755') await chmod(temporary, 0o755);
      staged.push({ temporary, destination });
    }
  } catch (error) {
    for (const { temporary } of staged) await rm(temporary, { force: true });
    throw error;
  }
  for (const { temporary, destination } of staged)
    await rename(temporary, destination);
  for (const { path, content } of plan)
    if (content === null) await rm(join(root, path), { force: true });
  return { applied: plan.map(({ path }) => path) };
}

/**
 * Remove the workspace folder when all its changes are in a commit. The
 * branch, or the Git directory of a folder workspace, keeps every version.
 * Returns false when the folder stays.
 */
export async function release(
  root: string,
  workspace: Workspace,
): Promise<boolean> {
  const target = join(root, workspace.path);
  if ((await lstat(target).catch(() => null)) === null) return true;
  try {
    if ((await list(target, ['status', '--porcelain', '-z'])).length)
      return false;
    if (workspace.kind === 'git')
      await git(root, ['worktree', 'remove', target]);
    else await rm(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
