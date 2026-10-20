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
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { childEnvironment } from './harness.ts';

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

/** A commit ID: SHA-1 or SHA-256. */
export const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A saved workspace record, or undefined when it is not valid. Tasks and the lab read the same shape. */
export function parseWorkspace(value: unknown): Workspace | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  const entry = value as Record<string, unknown>;
  return (entry.kind === 'git' || entry.kind === 'folder') &&
    typeof entry.path === 'string' &&
    /^\.verifold\/workspaces\/[a-z0-9][a-z0-9-]{0,80}$/.test(entry.path) &&
    (entry.branch === null ||
      (typeof entry.branch === 'string' &&
        /^verifold\/[a-z0-9][a-z0-9-]{0,80}$/.test(entry.branch))) &&
    typeof entry.start === 'string' &&
    commitPattern.test(entry.start)
    ? {
        kind: entry.kind,
        path: entry.path,
        branch: entry.branch,
        start: entry.start,
      }
    : undefined;
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
  /** A lab direction's folder leaves out larger files that are not committed. Its agent reads them in the project folder. */
  lightFileBytes: 1024 * 1024,
  /** A lab direction's folder copies at most this much that is not committed. */
  lightBytes: 50 * 1024 * 1024,
};

/**
 * The environment for Git. Variables such as GIT_DIR, GIT_INDEX_FILE, and
 * GIT_AUTHOR_NAME would point Git at another repository or another author, for
 * example when Verifold runs inside a Git hook. So none of them pass through.
 */
function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(childEnvironment()).filter(
        ([key]) => !key.startsWith('GIT_'),
      ),
    ),
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

/**
 * Run Git without a shell, for at most one minute. User hooks, signing, and
 * external diff tools do not run, and Verifold commits under its own name.
 * `input` goes to its standard input.
 */
function git(
  cwd: string,
  args: readonly string[],
  input?: string,
  env: NodeJS.ProcessEnv = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        // Several agents commit in worktrees of one repository. An automatic gc in one would race the others.
        '-c',
        'gc.auto=0',
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
        env: { ...gitEnvironment(), ...env },
      },
      (error, stdout, stderr) => {
        // check-ignore exits with 1 when no path matches.
        if (error && !(args[0] === 'check-ignore' && error.code === 1))
          reject(
            new WorkspaceError(
              `Git failed: ${stderr.toString('utf8').trim().split('\n')[0]?.slice(0, 300) || error.message}`,
              { cause: error },
            ),
          );
        else resolve(stdout);
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

function tooMany(lab = false): WorkspaceError {
  return new WorkspaceError(
    lab
      ? `Your direction's folder changed more than ${limits.files} files, so Verifold could not commit it. Move generated files out of the folder, or list them in a .gitignore there. Until then, other agents read your previous commit.`
      : `The task folder changed more than ${limits.files} files, so Verifold saved no version. Move generated files out of the writable paths, or list them in a .gitignore there.`,
  );
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

/**
 * Regular files under `path` in a folder, within the limits. Symbolic links
 * are skipped. A `light` walk leaves out tool folders, files above
 * `lightFileBytes`, and every file after `lightBytes` or after `files`
 * files, instead of failing. What it leaves out stays in the project folder.
 */
async function walk(
  root: string,
  path: string,
  light = false,
): Promise<string[]> {
  const found: string[] = [];
  let bytes = 0;
  const visit = async (rel: string): Promise<void> => {
    if (light && found.length >= limits.files) return;
    const stats = await lstat(join(root, rel)).catch(() => null);
    if (!stats || stats.isSymbolicLink()) return;
    if (stats.isFile()) {
      if (
        light &&
        (stats.size > limits.lightFileBytes ||
          bytes + stats.size > limits.lightBytes)
      )
        return;
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
      if (
        (rel !== '.' || !['.git', '.verifold'].includes(name)) &&
        !(light && toolFolders.includes(name))
      )
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
  light: boolean,
): Promise<string[]> {
  if (kind === 'folder')
    return (
      await Promise.all(writable.map((path) => walk(root, path, light)))
    ).flat();
  const changed = await list(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--no-renames',
    '--untracked-files=all',
    '--',
    ...writable,
  ]);
  if (changed.length > limits.files && !light)
    throw new WorkspaceError(
      `The writable paths have more than ${limits.files} uncommitted changes.`,
    );
  const paths = changed.map((entry) => entry.slice(3));
  if (!light) return paths;
  // New files above the size limit stay in the project folder. A deletion or a changed tracked file is copied. After `files` files, the rest stays too.
  const kept: string[] = [];
  let bytes = 0;
  for (const [index, path] of paths.entries()) {
    if (kept.length >= limits.files) break;
    const stats = await lstat(join(root, path)).catch(() => null);
    const size = stats?.isFile() ? stats.size : 0;
    const tracked = !changed[index]?.startsWith('??');
    if (
      !tracked &&
      (leftOut(path) ||
        size > limits.lightFileBytes ||
        bytes + size > limits.lightBytes)
    )
      continue;
    bytes += size;
    kept.push(path);
  }
  return kept;
}

/** Environments and caches that tools make as a side effect. A version leaves them out, even inside writable paths. */
const toolFolders = [
  '.venv',
  'node_modules',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.ipynb_checkpoints',
];
const caches = [
  ...toolFolders.map((name) => `**/${name}/**`),
  '**/*.py[co]',
  '**/.DS_Store',
].map((pattern) => `:(exclude,glob)${pattern}`);

/** Whether a version leaves this path out: it is in an environment or a cache that a tool made. */
export function leftOut(path: string): boolean {
  const parts = path.split('/');
  const name = parts.pop() ?? '';
  return (
    parts.some((part) => toolFolders.includes(part)) ||
    name === '.DS_Store' ||
    /\.py[co]$/.test(name)
  );
}

/** Folders of temporary output, such as the files of a test run. */
const scratchFolders = ['tmp', 'temp', '.tmp', '.temp', '.cache'];

/**
 * Whether a version file is scratch: temporary output that the project does
 * not need, such as `tests/tmp/run-1/model.pt`. A version keeps it, but Accept
 * leaves it out unless someone selects it.
 */
export function scratch(path: string): boolean {
  const parts = path.split('/');
  const name = parts.pop() ?? '';
  return (
    parts.some(
      (part) =>
        scratchFolders.includes(part.toLowerCase()) ||
        part.startsWith('pytest-of-'),
    ) || /(\.tmp|~)$/i.test(name)
  );
}

/**
 * Paths that a version leaves out among the pending entries: Python
 * environments under any name (they hold `pyvenv.cfg`), and ignored paths
 * whose rule comes from a `.gitignore` in a folder inside a writable path.
 * That file belongs to the task, so its rules count. Other rules, such as those
 * of the project's top `.gitignore`, do not: output in an ignored folder is kept.
 */
async function ownExclusions(
  target: string,
  writable: readonly string[],
  entries: readonly string[],
): Promise<{
  /** Environments that Git does not ignore. */
  readonly seen: readonly string[];
  /** Ignored paths. Only a forced add excludes them: Git refuses to name an ignored path otherwise. */
  readonly ignored: readonly string[];
}> {
  const seen = new Set<string>();
  const found = new Set<string>();
  const ignored: string[] = [];
  for (const entry of entries) {
    const path = entry.slice(3).replace(/\/$/, '');
    if (!entry.startsWith('!! ')) {
      if (path.endsWith('/pyvenv.cfg')) seen.add(dirname(path));
      continue;
    }
    ignored.push(entry.slice(3));
    if (
      entry.endsWith('/') &&
      (await lstat(join(target, path, 'pyvenv.cfg')).catch(() => null))
    )
      found.add(path);
  }
  if (ignored.length) {
    // Each match is four fields: the rule's file, its line, the pattern, and the path.
    const fields = (
      await git(
        target,
        ['check-ignore', '--verbose', '-z', '--stdin'],
        ignored.join('\0'),
      )
    )
      .toString('utf8')
      .split('\0');
    for (let index = 0; index + 3 < fields.length; index += 4) {
      const source = fields[index] ?? '';
      const path = fields[index + 3] ?? '';
      if (
        source.endsWith('/.gitignore') &&
        !isAbsolute(source) &&
        inScope(dirname(source), writable)
      )
        found.add(path.replace(/\/$/, ''));
    }
  }
  return { seen: [...seen], ignored: [...found] };
}

/**
 * Commit everything in the workspace. Inside writable paths, ignored files
 * count too, so output in an ignored folder is kept. Environments, caches, and
 * the files that the task's own `.gitignore` ignores stay out. Files above the
 * size limit stay out of the commit and are listed. `named` files count even
 * when a `.gitignore` ignores them. With `empty: false`, a workspace without
 * changes keeps its commit. A lab folder (`lab`) also leaves out files with
 * more than one hard link: Git reads files outside any sandbox, so a link to
 * a file outside the folder must not reach a commit that agents read.
 */
async function commitAll(
  target: string,
  writable: readonly string[],
  message: string,
  options: {
    readonly named?: readonly string[];
    readonly empty?: boolean;
    readonly lab?: boolean;
  } = {},
): Promise<{
  readonly commit: string;
  readonly skipped: readonly string[];
  readonly linked: readonly string[];
}> {
  const lab = options.lab ?? false;
  // Git refuses a path that does not exist. A writable folder can be new.
  const forced: string[] = [];
  for (const path of writable)
    if (path !== '.' && (await lstat(join(target, path)).catch(() => null)))
      forced.push(path);
  const all = [
    ...(await list(target, [
      'status',
      '--porcelain=v1',
      '-z',
      '--no-renames',
      '--untracked-files=all',
      '--',
      '.',
      ...caches,
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
          ...caches,
        ])
      : []),
  ];
  const own = await ownExclusions(target, writable, all);
  const folders = [...own.seen, ...own.ignored];
  const pending = new Set(
    all.filter((entry) => !inScope(entry.slice(3).replace(/\/$/, ''), folders)),
  );
  if (pending.size > limits.files) throw tooMany(lab);
  const skipped: string[] = [];
  const linked: string[] = [];
  for (const entry of pending) {
    const file = entry.slice(3);
    const stats = await lstat(join(target, file)).catch(() => null);
    if (lab && stats?.isFile() && stats.nlink > 1) linked.push(file);
    else if (stats?.isFile() && stats.size > limits.fileBytes)
      skipped.push(file);
  }
  const exclude = [
    ...[...skipped, ...linked, ...own.seen].map(
      (file) => `:(exclude,literal)${file}`,
    ),
    ...caches,
  ];
  await git(target, ['add', '--all', '--', '.', ...exclude]);
  if (forced.length)
    await git(target, [
      'add',
      '--all',
      '--force',
      '--',
      ...forced,
      ...exclude,
      ...own.ignored.map((file) => `:(exclude,literal)${file}`),
    ]);
  const named: string[] = [];
  for (const path of options.named ?? []) {
    const stats = await lstat(join(target, path)).catch(() => null);
    if (lab && stats?.isFile() && stats.nlink > 1) {
      if (!linked.includes(path)) linked.push(path);
    } else if (stats?.isFile() && stats.size <= limits.fileBytes)
      named.push(path);
  }
  if (named.length)
    await git(target, [
      'add',
      '--force',
      '--',
      ...named.map((path) => `:(literal)${path}`),
    ]);
  // An ignored folder is one pending entry, so count again what Git holds now.
  const staged = await list(target, ['diff', '--cached', '--name-only', '-z']);
  if (staged.length > limits.files) {
    await git(target, ['reset', '--quiet']);
    throw tooMany(lab);
  }
  if (!staged.length && options.empty === false)
    return { commit: await head(target), skipped, linked };
  await git(target, [
    'commit',
    '--quiet',
    '--no-verify',
    '--allow-empty',
    '-m',
    message,
  ]);
  return { commit: await head(target), skipped, linked };
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
    /**
     * A lab direction's folder: new files above 1 MB, tool folders, and
     * anything after 50 MB stay in the project folder instead of being copied.
     */
    readonly light?: boolean;
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
  const copies = await startFiles(
    root,
    kind,
    options.writable,
    options.light ?? false,
  );
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

/**
 * Commit everything in a lab direction's folder, so other agents can read its
 * files at this commit. The `named` files, such as the proof of a post, count
 * even when the project ignores them. A folder without changes keeps its
 * commit. Files with more than one hard link stay out. Returns the commit and
 * the files that stayed out for that reason.
 */
export async function snapshot(
  root: string,
  workspace: Workspace,
  message: string,
  named: readonly string[] = [],
): Promise<{ readonly commit: string; readonly linked: readonly string[] }> {
  const { commit, linked } = await commitAll(
    join(root, workspace.path),
    ['.'],
    message,
    { named, empty: false, lab: true },
  );
  return { commit, linked };
}

/**
 * The workspace names in use: the folders under `.verifold/workspaces`, the
 * Git folders of folder projects, and Verifold's branches. A new workspace
 * must take another name. Start over keeps them all.
 */
export async function workspaceNames(root: string): Promise<string[]> {
  const names = async (folder: string): Promise<string[]> => {
    try {
      return await readdir(join(root, '.verifold', folder));
    } catch {
      return [];
    }
  };
  const branches = (await gitProject(root))
    ? (
        await git(root, [
          'for-each-ref',
          '--format=%(refname:lstrip=3)',
          'refs/heads/verifold/',
        ])
      )
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
    : [];
  return [
    ...(await names('workspaces')),
    ...(await names(join('tasks', 'git'))),
    ...branches,
  ];
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

/** The content of a file in a version, or null when it or its task folder is gone. */
export function readAt(
  root: string,
  workspace: Workspace,
  commit: string,
  path: string,
): Promise<Buffer | null> {
  return fileAt(join(root, workspace.path), commit, path);
}

/**
 * A fingerprint of a lab direction's folder: its commit, plus the path, size,
 * and change time of each file that is not committed, ignored files too. A
 * turn that writes only ignored output still changes it.
 */
export async function folderState(
  root: string,
  workspace: Workspace,
): Promise<string> {
  const target = join(root, workspace.path);
  const hash = createHash('sha256').update(await head(target));
  const entries = (
    await list(target, [
      'status',
      '--porcelain=v1',
      '-z',
      '--no-renames',
      '--untracked-files=all',
      '--ignored=traditional',
      '--',
      '.',
      ...caches,
    ])
  ).slice(0, limits.files);
  for (const entry of entries) {
    const stats = await lstat(join(target, entry.slice(3))).catch(() => null);
    hash.update(`${entry}\0${stats?.size ?? -1}\0${stats?.mtimeMs ?? -1}\0`);
  }
  return hash.digest('hex');
}

/**
 * A lab direction's file as it is now, ignored files too, read through Git:
 * Verifold never opens the path itself. Git adds it to a private index that
 * is not the folder's own. Git does not follow a symbolic link: a link is
 * stored as a link, and a path through a linked folder is refused. So an
 * agent cannot make Verifold read a file outside its folder by a link. A
 * hard link is not a link to Git, so a file with more than one hard link is
 * refused. Null when the path is not a regular file in the folder, or it is
 * larger than Verifold commits.
 */
export async function readCurrent(
  root: string,
  workspace: Workspace,
  path: string,
): Promise<Buffer | null> {
  const target = join(root, workspace.path);
  // A size and link check only: the content comes from Git, never from this path.
  const stats = await lstat(join(target, path)).catch(() => null);
  if (!stats?.isFile() || stats.size > limits.fileBytes) return null;
  if (stats.nlink > 1)
    throw new WorkspaceError(
      `${path} has more than one hard link, so Verifold does not read it. Write a separate copy of the file instead.`,
    );
  const index = join(
    tmpdir(),
    `verifold-index-${randomBytes(8).toString('hex')}`,
  );
  try {
    const env = { GIT_INDEX_FILE: index };
    await git(
      target,
      ['add', '--force', '--', `:(literal)${path}`],
      undefined,
      env,
    );
    const entry = (
      await git(
        target,
        ['ls-files', '--stage', '-z', '--', `:(literal)${path}`],
        undefined,
        env,
      )
    )
      .toString('utf8')
      .split('\0')
      .find((line) => line.endsWith(`\t${path}`));
    // An index entry is `<mode> <id> <stage>\t<path>`. A link has mode 120000.
    const [mode, id] = entry?.split('\t')[0]?.split(' ') ?? [];
    return (mode === '100644' || mode === '100755') && id
      ? await git(target, ['cat-file', 'blob', id])
      : null;
  } catch {
    return null;
  } finally {
    await rm(index, { force: true });
  }
}

/**
 * The content of a file at a commit when it is a regular file there, or
 * null. A symbolic link at that path reads as null, not as its target.
 */
export async function readFileAt(
  root: string,
  workspace: Workspace,
  commit: string,
  path: string,
): Promise<Buffer | null> {
  const target = join(root, workspace.path);
  try {
    const entry = (await git(target, ['ls-tree', '-z', commit, '--', path]))
      .toString('utf8')
      .split('\0')
      .find((line) => line.endsWith(`\t${path}`));
    // A tree entry is `<mode> <type> <id>\t<path>`.
    const [mode, , id] = entry?.split('\t')[0]?.split(' ') ?? [];
    return (mode === '100644' || mode === '100755') && id
      ? await git(target, ['cat-file', 'blob', id])
      : null;
  } catch {
    return null;
  }
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
 * Copy files of a commit into an empty record folder. A file that the commit
 * deletes is skipped. Returns each copied file with its size and SHA-256.
 */
export async function copyAt(
  root: string,
  workspace: Workspace,
  commit: string,
  paths: readonly string[],
  folder: string,
): Promise<{ path: string; bytes: number; sha256: string }[]> {
  const target = join(root, workspace.path);
  const copied = [];
  for (const path of paths) {
    const content = await fileAt(target, commit, path);
    if (content === null) continue;
    await mkdir(dirname(join(folder, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(folder, path), content, { flag: 'wx', mode: 0o600 });
    copied.push({
      path,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return copied;
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
    if (
      (
        await list(target, [
          'status',
          '--porcelain',
          '-z',
          '--',
          '.',
          ...caches,
        ])
      ).length
    )
      return false;
    if (workspace.kind === 'git')
      await git(root, ['worktree', 'remove', target]);
    else await rm(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
