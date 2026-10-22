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
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
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
  /**
   * For a worktree, the name of its administrative folder under the
   * project's `worktrees/`. Git picks it when the worktree is made, and it
   * can differ from the folder's own name. A record from before this field
   * leaves it out, and Verifold derives and checks it once.
   */
  readonly admin?: string;
}

/** A safe single path segment: a worktree's administrative folder name. */
const adminName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** What the person calls a workspace: its branch, or its folder when it has none. */
export function workspaceName(workspace: Workspace): string {
  return workspace.branch ?? workspace.path;
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
        ...(typeof entry.admin === 'string' && adminName.test(entry.admin)
          ? { admin: entry.admin }
          : {}),
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
export const limits = {
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
 * example when Verifold runs inside a Git hook. So none of them pass through,
 * in any case of letters: Windows does not tell names apart by case.
 *
 * GIT_NO_LAZY_FETCH stops a read of a missing object from fetching it, so a
 * command such as `ls-tree` or `cat-file` only ever reads the local store.
 */
export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(childEnvironment()).filter(
        ([key]) => !key.toUpperCase().startsWith('GIT_'),
      ),
    ),
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    LC_ALL: 'C',
  };
}

/** The one place the Git directory of a task or check folder is built, from the folder's name. */
function taskGitDir(root: string, name: string): string {
  return join(root, '.verifold', 'tasks', 'git', name);
}

/** A repository that a Git command names, with the folder it works in. */
interface Repo {
  readonly gitDir: string;
  readonly workTree: string;
}

/** The Git directory that every worktree of a project shares, asked of the project once per project. A failed answer is not kept. */
const commonGitDir = new Map<string, Promise<string>>();
function commonDir(root: string): Promise<string> {
  let pending = commonGitDir.get(root);
  if (!pending) {
    pending = git(root, ['rev-parse', '--git-common-dir'])
      // Older Git has no `--path-format=absolute`, so the path is resolved against the project.
      .then((out) => resolve(root, out.toString('utf8').trim()))
      .catch((error: unknown) => {
        commonGitDir.delete(root);
        throw error;
      });
    commonGitDir.set(root, pending);
  }
  return pending;
}

/**
 * The repository of a workspace: its Git directory and the folder it works
 * in. A folder workspace keeps its Git directory under `.verifold/tasks/git/`.
 * A worktree's comes from the project's own record of it, checked on each use
 * against the folder that record names.
 */
async function workspaceRepo(
  root: string,
  workspace: Pick<Workspace, 'kind' | 'path' | 'admin'>,
): Promise<Repo> {
  const workTree = join(root, workspace.path);
  if (workspace.kind === 'folder')
    return { gitDir: taskGitDir(root, basename(workspace.path)), workTree };
  return { gitDir: await worktreeGitDir(root, workspace, workTree), workTree };
}

/** The repository of a check folder: its fixed Git directory under `.verifold/tasks/git/`. */
function checkRepo(root: string, name: string): Repo {
  return {
    gitDir: taskGitDir(root, name),
    workTree: join(root, checkPath(name)),
  };
}

/**
 * A worktree's administrative folder in the project. The record names it.
 * When it does not, or the one it names does not point back, Verifold finds
 * the administrative folder whose `gitdir` names this worktree.
 */
async function worktreeGitDir(
  root: string,
  workspace: Pick<Workspace, 'path' | 'admin'>,
  workTree: string,
): Promise<string> {
  const base = join(await commonDir(root), 'worktrees');
  const named = workspace.admin ?? basename(workspace.path);
  if (adminName.test(named) && (await pointsBack(join(base, named), workTree)))
    return join(base, named);
  for (const entry of await readdir(base).catch((): string[] => []))
    if (
      adminName.test(entry) &&
      (await pointsBack(join(base, entry), workTree))
    )
      return join(base, entry);
  throw new WorkspaceError(
    'A worktree does not match the repository that Verifold set up for it.',
  );
}

/**
 * Whether an administrative folder's `gitdir` file names this worktree's
 * `.git`. The folder is the project's, not the agent's. Git can write the
 * path relative to the administrative folder.
 */
async function pointsBack(
  adminDir: string,
  workTree: string,
): Promise<boolean> {
  const content = await readFile(join(adminDir, 'gitdir'), 'utf8').catch(
    () => null,
  );
  if (!content) return false;
  const named = await realpath(resolve(adminDir, content.trim())).catch(
    () => null,
  );
  const own = await realpath(join(workTree, '.git')).catch(() => null);
  return named !== null && named === own;
}

/**
 * The options of every `git diff` that Verifold runs: Verifold's own diffs
 * never run text-conversion or external diff programs, also not in a
 * submodule, whose diff Git would otherwise run as a child `git diff` that
 * gets none of these options.
 */
const plainDiff = ['--no-textconv', '--no-ext-diff', '--submodule=short'];

/**
 * Run Git without a shell, for at most one minute. Verifold commits under its
 * own name. User hooks, signing, text conversion, external diff programs, and
 * a file monitor never run. Filters (clean, smudge, process) do run, because
 * projects that use Git LFS need them. `input` goes to its standard input.
 * `repo` names the repository and its folder, so Git does not look for them
 * from `cwd`; the project root's own commands pass none.
 *
 * Only `diff` prints diffs here. A new Git command that prints diff or patch
 * output (show, log -p, format-patch, range-diff, blame, stash show) must get
 * the same options.
 */
function git(
  cwd: string,
  args: readonly string[],
  options: {
    readonly input?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly repo?: Repo;
  } = {},
): Promise<Buffer> {
  const { input, env = {}, repo } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [
        // Verifold never reaches a remote, so no command may use a transport. This also stops a read of a missing object from fetching it, on the Git that ignores GIT_NO_LAZY_FETCH.
        '-c',
        'protocol.allow=never',
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
        '-c',
        'core.fsmonitor=false',
        // A nested repository is never entered: no recursion, and no summary of its state.
        '-c',
        'submodule.recurse=false',
        '-c',
        'status.submoduleSummary=false',
        ...(repo
          ? ['--git-dir', repo.gitDir, '--work-tree', repo.workTree]
          : []),
        ...(args[0] === 'diff'
          ? ['diff', ...plainDiff, ...args.slice(1)]
          : args),
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
        if (error && !(args[0] === 'check-ignore' && error.code === 1)) {
          const first =
            stderr.toString('utf8').trim().split('\n')[0]?.slice(0, 300) ||
            error.message;
          // Git's own message when a read needs data that only a remote holds. Verifold reads the local store and does not fetch.
          const remote =
            /^(?:fatal|error): (?:transport '[a-z0-9+.-]+' not allowed|lazy fetching disabled|could not fetch [0-9a-f]+ from promisor remote)/i.test(
              first,
            );
          reject(
            new WorkspaceError(
              remote
                ? 'Verifold reads only the Git data in the project folder and does not reach a remote. A file that lives only in a remote is not available here.'
                : `Git failed: ${first}`,
              { cause: error },
            ),
          );
        } else resolve(stdout);
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

async function list(
  cwd: string,
  args: readonly string[],
  repo?: Repo,
): Promise<string[]> {
  return (await git(cwd, args, repo ? { repo } : {}))
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

async function head(cwd: string, repo?: Repo): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'], repo ? { repo } : {}))
    .toString('utf8')
    .trim();
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
  // A Mac's folders compare in lowercase.
  if (['.git', '.verifold'].includes((parts[0] ?? '').toLowerCase()))
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

/**
 * Fail when a path, or its nearest existing parent, resolves outside the
 * project, or into Verifold's own folder or a Git folder. The names compare
 * in lowercase, because a Mac's folders do.
 */
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
      // The rest of the path does not exist yet: it comes under `real`.
      const parts = join(rel, relative(current, path)).toLowerCase().split(sep);
      if (parts[0] === '.verifold' || parts.includes('.git'))
        throw new WorkspaceError(
          `${relative(root, path)} leads into Verifold's own folder or a Git folder.`,
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
    '--ignore-submodules=all',
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
  repo: Repo,
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
      await git(target, ['check-ignore', '--verbose', '-z', '--stdin'], {
        input: ignored.join('\0'),
        repo,
      })
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
  repo: Repo,
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
  readonly nested: readonly string[];
}> {
  const lab = options.lab ?? false;
  // Git refuses a path that does not exist. A writable folder can be new.
  const forced: string[] = [];
  for (const path of writable)
    if (path !== '.' && (await lstat(join(target, path)).catch(() => null)))
      forced.push(path);
  const all = [
    ...(await list(
      target,
      [
        'status',
        '--ignore-submodules=all',
        '--porcelain=v1',
        '-z',
        '--no-renames',
        '--untracked-files=all',
        '--',
        '.',
        ...caches,
      ],
      repo,
    )),
    ...(forced.length
      ? await list(
          target,
          [
            'status',
            '--ignore-submodules=all',
            '--porcelain=v1',
            '-z',
            '--no-renames',
            '--untracked-files=all',
            '--ignored=matching',
            '--',
            ...forced,
            ...caches,
          ],
          repo,
        )
      : []),
  ];
  const own = await ownExclusions(target, repo, writable, all);
  const folders = [...own.seen, ...own.ignored];
  const pending = new Set(
    all.filter((entry) => !inScope(entry.slice(3).replace(/\/$/, ''), folders)),
  );
  if (pending.size > limits.files) throw tooMany(lab);
  // A folder with its own Git data, at any depth in what is added, stays out of every add, so Git never enters it.
  const nested = await nestedRepos(target, [
    ...new Set(
      all
        .filter((entry) => entry.endsWith('/'))
        .map((entry) => entry.slice(3).replace(/\/$/, '')),
    ),
  ]);
  const skipped: string[] = [];
  const linked: string[] = [];
  for (const entry of pending) {
    const file = entry.slice(3).replace(/\/$/, '');
    if (inScope(file, nested)) continue;
    const stats = await lstat(join(target, file)).catch(() => null);
    if (lab && stats?.isFile() && stats.nlink > 1) linked.push(file);
    else if (stats?.isFile() && stats.size > limits.fileBytes)
      skipped.push(file);
  }
  const exclude = [
    ...[...skipped, ...linked, ...own.seen, ...nested].map(
      (file) => `:(exclude,literal)${file}`,
    ),
    ...caches,
  ];
  await git(target, ['add', '--all', '--', '.', ...exclude], { repo });
  if (forced.length)
    await git(
      target,
      [
        'add',
        '--all',
        '--force',
        '--',
        ...forced,
        ...exclude,
        ...own.ignored.map((file) => `:(exclude,literal)${file}`),
      ],
      { repo },
    );
  const named: string[] = [];
  for (const path of options.named ?? []) {
    if (inScope(path, nested)) continue;
    const stats = await lstat(join(target, path)).catch(() => null);
    if (lab && stats?.isFile() && stats.nlink > 1) {
      if (!linked.includes(path)) linked.push(path);
    } else if (stats?.isFile() && stats.size <= limits.fileBytes)
      named.push(path);
  }
  if (named.length)
    await git(
      target,
      ['add', '--force', '--', ...named.map((path) => `:(literal)${path}`)],
      { repo },
    );
  await dropNewGitlinks(target, repo);
  // An ignored folder is one pending entry, so count again what Git holds now.
  const staged = await list(
    target,
    ['diff', '--cached', '--name-only', '-z'],
    repo,
  );
  if (staged.length > limits.files) {
    await git(target, ['reset', '--quiet'], { repo });
    throw tooMany(lab);
  }
  if (!staged.length && options.empty === false)
    return { commit: await head(target, repo), skipped, linked, nested };
  await git(
    target,
    ['commit', '--quiet', '--no-verify', '--allow-empty', '-m', message],
    { repo },
  );
  return { commit: await head(target, repo), skipped, linked, nested };
}

/**
 * The folders inside `dirs` that hold their own Git data, at any depth. An
 * add leaves each of them out, so Git never enters it. The walk skips tool
 * folders and stops at the file limit, like a version does.
 */
async function nestedRepos(
  target: string,
  dirs: readonly string[],
): Promise<string[]> {
  const found: string[] = [];
  let visited = 0;
  const visit = async (rel: string): Promise<void> => {
    if (++visited > limits.files) return;
    const entries = await readdir(join(target, rel), {
      withFileTypes: true,
    }).catch(() => []);
    if (entries.some((entry) => entry.name === '.git')) {
      found.push(rel);
      return;
    }
    for (const entry of entries)
      if (entry.isDirectory() && !toolFolders.includes(entry.name))
        await visit(`${rel}/${entry.name}`);
  };
  for (const dir of dirs) await visit(dir);
  return found;
}

/**
 * Take out of the index any link to another repository that this commit
 * staged and that the last commit does not hold. The project's own
 * submodules, which the last commit holds, stay.
 */
async function dropNewGitlinks(target: string, repo: Repo): Promise<void> {
  // Each change is a header field and a path field: `:<old> <new> <ids> <status>`, then the path.
  const fields = await list(
    target,
    ['diff', '--cached', '--raw', '-z', '--no-renames'],
    repo,
  );
  const added: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2)
    if (/^:000000 160000 /.test(fields[index] ?? ''))
      added.push(fields[index + 1] ?? '');
  if (added.length)
    await git(
      target,
      [
        'rm',
        '--cached',
        '--quiet',
        '--force',
        '--',
        ...added.map((path) => `:(literal)${path}`),
      ],
      { repo },
    );
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
  const branch = kind === 'git' ? `verifold/${options.name}` : null;
  try {
    let admin: string | undefined;
    if (branch) {
      // Absolute paths in both links, so the project's record of the worktree reads the same on every Git.
      await git(root, [
        '-c',
        'worktree.useRelativePaths=false',
        'worktree',
        'add',
        '--quiet',
        '-b',
        branch,
        target,
        'HEAD',
      ]);
      // The worktree is new, so its `.git` link is the one Git wrote. It names the folder that the project keeps for the worktree.
      const link = await readFile(join(target, '.git'), 'utf8');
      admin = basename(resolve(target, link.replace(/^gitdir:\s*/, '').trim()));
    } else {
      await mkdir(dirname(taskGitDir(root, options.name)), {
        recursive: true,
        mode: 0o700,
      });
      await mkdir(target, { mode: 0o700 });
      await git(target, [
        'init',
        '--quiet',
        `--separate-git-dir=${taskGitDir(root, options.name)}`,
      ]);
    }
    const repo = await workspaceRepo(root, {
      kind,
      path,
      ...(admin ? { admin } : {}),
    });
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
      repo,
      options.writable,
      'Verifold: task start',
    );
    return { kind, path, branch, start: commit, ...(admin ? { admin } : {}) };
  } catch (error) {
    await undoAllocate(root, target, options.name, branch);
    throw error;
  }
}

/**
 * Remove what a workspace that did not start left behind: its folder, and
 * for a worktree its branch and the project's record of it, or for a folder
 * workspace its Git directory. Each step runs even when an earlier one fails.
 */
async function undoAllocate(
  root: string,
  target: string,
  name: string,
  branch: string | null,
): Promise<void> {
  await rm(target, { recursive: true, force: true });
  if (branch) {
    // With its folder gone, the project's record of the worktree is stale, and prune removes it.
    await git(root, ['worktree', 'prune']).catch(() => {});
    await git(root, ['branch', '-D', branch]).catch(() => {});
  } else await rm(taskGitDir(root, name), { recursive: true, force: true });
}

/** The folder of a lab check under the project, from its ID. */
export function checkPath(id: string): string {
  return join('.verifold', 'checks', id);
}

/**
 * The folder of a lab check, `.verifold/checks/<name>`: the files of
 * `commit` from the folder of another workspace, and nothing else, with a Git
 * directory of its own under `.verifold/tasks/git/`. Its start commit holds
 * every file of that commit, ignored, large, and many files too, so the
 * checker's runs have what the claim's run had. It holds no other commit of
 * the project, so the checker cannot read another direction's work through
 * Git. Returns its start commit.
 */
export async function checkFolder(
  root: string,
  options: {
    readonly name: string;
    readonly from: Workspace;
    readonly commit: string;
  },
): Promise<string> {
  if (!/^k-[1-9]\d{0,5}$/.test(options.name))
    throw new WorkspaceError('Invalid check name.');
  const target = join(root, checkPath(options.name));
  const gitDir = taskGitDir(root, options.name);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  if (
    (await lstat(target).catch(() => null)) !== null ||
    (await lstat(gitDir).catch(() => null)) !== null
  )
    throw new WorkspaceError(
      `The check folder ${options.name} already exists.`,
    );
  await mkdir(dirname(gitDir), { recursive: true, mode: 0o700 });
  await mkdir(target, { mode: 0o700 });
  try {
    await checkoutAt(root, options.from, options.commit, target);
    await git(target, ['init', '--quiet', `--separate-git-dir=${gitDir}`]);
    const repo = checkRepo(root, options.name);
    // Git wrote each file new, so none has a second hard link.
    await git(target, ['add', '--all', '--force', '--', '.'], { repo });
    await dropNewGitlinks(target, repo);
    await git(
      target,
      [
        'commit',
        '--quiet',
        '--no-verify',
        '--allow-empty',
        '-m',
        'Verifold: the start of a check',
      ],
      { repo },
    );
    return await head(target, repo);
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    await rm(gitDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The real paths of a project's Git data: its Git directory and, in a
 * worktree, the common one with every branch. None for a project without Git.
 */
export async function gitDirs(root: string): Promise<string[]> {
  try {
    // Older Git has no `--path-format=absolute`, so each path is resolved against the project.
    const lines = (
      await git(root, ['rev-parse', '--git-dir', '--git-common-dir'])
    )
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => resolve(root, line));
    const real = await Promise.all(
      lines.map((line) => realpath(line).catch(() => line)),
    );
    return [...new Set(real)];
  } catch {
    return [];
  }
}

/** Commit the workspace as one version. */
export async function commitVersion(
  root: string,
  workspace: Workspace,
  writable: readonly string[],
  message: string,
): Promise<{
  readonly commit: string;
  readonly skipped: readonly string[];
  readonly nested: readonly string[];
}> {
  const repo = await workspaceRepo(root, workspace);
  const { commit, skipped, nested } = await commitAll(
    repo.workTree,
    repo,
    writable,
    message,
  );
  return { commit, skipped, nested };
}

/**
 * Commit everything in a lab direction's folder, so other agents can read its
 * files at this commit. The `named` files, such as the proof of a post, count
 * even when the project ignores them. A folder without changes keeps its
 * commit. Files with more than one hard link stay out, and so do folders with
 * their own Git data. Returns the commit and each list of what stayed out.
 */
export async function snapshot(
  root: string,
  workspace: Workspace,
  message: string,
  named: readonly string[] = [],
): Promise<{
  readonly commit: string;
  readonly linked: readonly string[];
  readonly skipped: readonly string[];
  readonly nested: readonly string[];
}> {
  const repo = await workspaceRepo(root, workspace);
  const { commit, linked, skipped, nested } = await commitAll(
    repo.workTree,
    repo,
    ['.'],
    message,
    { named, empty: false, lab: true },
  );
  return { commit, linked, skipped, nested };
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
  const repo = await workspaceRepo(root, workspace);
  const fields = (
    await git(
      repo.workTree,
      ['diff', '--raw', '-z', '--no-renames', from, to],
      { repo },
    )
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
  const repo = await workspaceRepo(root, workspace);
  const output = await git(
    repo.workTree,
    ['diff', '--no-color', '--no-renames', from, to, '--', `:(literal)${path}`],
    { repo },
  );
  return output.length > limits.diffBytes
    ? { text: output.subarray(0, limits.diffBytes).toString('utf8'), cut: true }
    : { text: output.toString('utf8'), cut: false };
}

/**
 * The text diff of one file between two commits, with no workspace: in the
 * project repository, or with `gitDir`, a task folder's own Git directory,
 * such as one in an archived run. Cut at the same limit as `diff`.
 */
export async function diffIn(
  root: string,
  gitDir: string | null,
  from: string,
  to: string,
  path: string,
): Promise<{ readonly text: string; readonly cut: boolean }> {
  const output = await git(
    root,
    ['diff', '--no-color', '--no-renames', from, to, '--', `:(literal)${path}`],
    gitDir ? { env: { GIT_DIR: gitDir } } : {},
  );
  return output.length > limits.diffBytes
    ? { text: output.subarray(0, limits.diffBytes).toString('utf8'), cut: true }
    : { text: output.toString('utf8'), cut: false };
}

/** The content of a file in a version, or null when it or its task folder is gone, or Verifold cannot name its repository. */
export async function readAt(
  root: string,
  workspace: Workspace,
  commit: string,
  path: string,
): Promise<Buffer | null> {
  const repo = await workspaceRepo(root, workspace).catch(() => null);
  return repo ? fileAt(repo, commit, path) : null;
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
  const repo = await workspaceRepo(root, workspace);
  const target = repo.workTree;
  const hash = createHash('sha256').update(await head(target, repo));
  const entries = (
    await list(
      target,
      [
        'status',
        '--ignore-submodules=all',
        '--porcelain=v1',
        '-z',
        '--no-renames',
        '--untracked-files=all',
        '--ignored=traditional',
        '--',
        '.',
        ...caches,
      ],
      repo,
    )
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
  const repo = await workspaceRepo(root, workspace).catch(() => null);
  if (!repo) return null;
  const index = join(
    tmpdir(),
    `verifold-index-${randomBytes(8).toString('hex')}`,
  );
  try {
    const env = { GIT_INDEX_FILE: index };
    await git(target, ['add', '--force', '--', `:(literal)${path}`], {
      env,
      repo,
    });
    const entry = (
      await git(
        target,
        ['ls-files', '--stage', '-z', '--', `:(literal)${path}`],
        { env, repo },
      )
    )
      .toString('utf8')
      .split('\0')
      .find((line) => line.endsWith(`\t${path}`));
    // An index entry is `<mode> <id> <stage>\t<path>`. A link has mode 120000.
    const [mode, id] = entry?.split('\t')[0]?.split(' ') ?? [];
    return (mode === '100644' || mode === '100755') && id
      ? await git(target, ['cat-file', 'blob', id], { repo })
      : null;
  } catch {
    return null;
  } finally {
    await rm(index, { force: true });
  }
}

/**
 * The content of a file at a commit when it is a regular file there, or
 * null. A symbolic link at that path reads as null, not as its target. A
 * file larger than `maxBytes` reads as null, and Git does not read it.
 */
export async function readFileAt(
  root: string,
  workspace: Workspace,
  commit: string,
  path: string,
  maxBytes = Infinity,
): Promise<Buffer | null> {
  try {
    const repo = await workspaceRepo(root, workspace);
    const entry = (
      await git(repo.workTree, ['ls-tree', '-l', '-z', commit, '--', path], {
        repo,
      })
    )
      .toString('utf8')
      .split('\0')
      .find((line) => line.endsWith(`\t${path}`));
    // A tree entry is `<mode> <type> <id> <size>\t<path>`, with spaces before the size.
    const [, mode, id, size] =
      /^(\d{6}) blob ([0-9a-f]+) +(\d+)\t/.exec(entry ?? '') ?? [];
    return (mode === '100644' || mode === '100755') &&
      id &&
      Number(size) <= maxBytes
      ? await git(repo.workTree, ['cat-file', 'blob', id], { repo })
      : null;
  } catch {
    return null;
  }
}

/** The content of a file at a commit, or null when the commit has no file there, such as a folder. */
async function fileAt(
  repo: Repo,
  commit: string,
  path: string,
): Promise<Buffer | null> {
  try {
    const type = (
      await git(repo.workTree, ['cat-file', '-t', `${commit}:${path}`], {
        repo,
      })
    )
      .toString('utf8')
      .trim();
    if (type !== 'blob') return null;
  } catch {
    return null;
  }
  return git(repo.workTree, ['cat-file', 'blob', `${commit}:${path}`], {
    repo,
  });
}

/**
 * Write the files of a commit into the empty folder `target`, with a
 * temporary index, so the workspace's own index and folder stay as they are.
 * Git writes each file itself and never through a symbolic link in the
 * folder. The folder gets no Git data.
 */
export async function checkoutAt(
  root: string,
  workspace: Workspace,
  commit: string,
  target: string,
): Promise<void> {
  const repo = await workspaceRepo(root, workspace);
  const index = join(
    tmpdir(),
    `verifold-index-${randomBytes(8).toString('hex')}`,
  );
  try {
    const env = { GIT_INDEX_FILE: index };
    await git(repo.workTree, ['read-tree', commit], { env, repo });
    await git(
      repo.workTree,
      ['checkout-index', '--all', '--force', `--prefix=${target}/`],
      { env, repo },
    );
  } finally {
    await rm(index, { force: true });
  }
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
  const repo = await workspaceRepo(root, workspace);
  const copied = [];
  for (const path of paths) {
    const content = await fileAt(repo, commit, path);
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
 * project must still match its start content, or nothing is copied. A
 * folder that the version replaces with a file counts as missing when the
 * copy deletes every file in it, and a folder of the version counts as no
 * file. New content goes to temporary files in `.verifold/staging` first,
 * one file at a time. Then the deletions come, so a file can take the place
 * of a folder and a folder the place of a file, and each new file is renamed
 * into place. `bases` names another commit whose content a file must match
 * instead of the start, such as the version that came in before. `versions`
 * names another commit whose content a file gets instead of `version`, and
 * `modes` another mode than its commit's, such as its content and the
 * person's mode before a bring-in, for an undo. `staged` runs after every
 * check passed and every temporary file is written, before the first change
 * in the project. When it throws, nothing is copied.
 */
export async function integrate(
  root: string,
  workspace: Workspace,
  version: string,
  paths: readonly string[],
  options: {
    readonly bases?: ReadonlyMap<string, string>;
    readonly versions?: ReadonlyMap<string, string>;
    readonly modes?: ReadonlyMap<string, string>;
    readonly staged?: () => Promise<void>;
  } = {},
): Promise<
  | { readonly applied: readonly string[] }
  | { readonly conflicts: readonly string[] }
> {
  const repo = await workspaceRepo(root, workspace);
  const versionOf = (path: string): string =>
    options.versions?.get(path) ?? version;
  const tree = new Map<
    string,
    { readonly mode: string; readonly id: string; readonly bytes: number }
  >();
  // A folder of the version is no file: its own files come in under it.
  for (const commit of new Set(paths.map(versionOf)))
    for (const [path, entry] of await treeAt(
      root,
      workspace,
      commit,
      paths.filter((path) => versionOf(path) === commit),
    ))
      if (entry.mode !== '040000') tree.set(path, entry);
  const deleted = new Set(paths.filter((path) => !tree.has(path)));
  const conflicts: string[] = [];
  for (const path of paths) {
    const destination = join(root, path);
    await contained(root, destination);
    const stats = await lstat(destination).catch(() => null);
    const current = !stats
      ? null
      : stats.isFile()
        ? await readFile(destination)
        : stats.isDirectory() && (await emptied(root, path, deleted))
          ? null
          : undefined;
    const start = await fileAt(
      repo,
      options.bases?.get(path) ?? workspace.start,
      path,
    );
    const unchanged =
      current === null
        ? start === null
        : current !== undefined && start !== null && current.equals(start);
    if (!unchanged) conflicts.push(path);
  }
  if (conflicts.length) return { conflicts };
  const staging = join(
    root,
    '.verifold',
    'staging',
    randomBytes(8).toString('hex'),
  );
  const written: { temporary: string; destination: string }[] = [];
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    for (const [index, path] of paths.entries()) {
      const entry = tree.get(path);
      if (!entry) continue;
      const temporary = join(staging, String(index));
      // One file at a time: the copy never holds every file in memory.
      await writeFile(
        temporary,
        await git(repo.workTree, ['cat-file', 'blob', entry.id], { repo }),
        { flag: 'wx', mode: 0o644 },
      );
      if ((options.modes?.get(path) ?? entry.mode) === '100755')
        await chmod(temporary, 0o755);
      written.push({ temporary, destination: join(root, path) });
    }
    await options.staged?.();
    for (const path of paths)
      if (deleted.has(path)) {
        await rm(join(root, path), { force: true });
        await removeEmpty(root, dirname(join(root, path)));
      }
    for (const { temporary, destination } of written) {
      await mkdir(dirname(destination), { recursive: true });
      await contained(root, destination);
      await rename(temporary, destination);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { applied: [...paths] };
}

/**
 * The folder at `path` holds only files that this copy deletes, so a file
 * can take its place.
 */
export async function emptied(
  root: string,
  path: string,
  deleted: ReadonlySet<string>,
): Promise<boolean> {
  const entries = await readdir(join(root, path), {
    recursive: true,
    withFileTypes: true,
  }).catch(() => null);
  return (
    entries !== null &&
    entries.length <= limits.files &&
    entries.every(
      (entry) =>
        entry.isDirectory() ||
        deleted.has(
          relative(root, join(entry.parentPath, entry.name))
            .split(sep)
            .join('/'),
        ),
    )
  );
}

/** Remove the empty folders from `folder` up to the project folder, as Git does after a deletion. */
async function removeEmpty(root: string, folder: string): Promise<void> {
  for (
    let at = folder;
    at !== root && at.startsWith(`${root}${sep}`);
    at = dirname(at)
  )
    try {
      await rmdir(at);
    } catch {
      return;
    }
}

/**
 * Remove the temporary files that `integrate` wrote and did not move into
 * place, for example when Verifold stopped during a copy. Only while no
 * copy runs, such as at a start.
 */
export async function clearStaged(root: string): Promise<void> {
  await rm(join(root, '.verifold', 'staging'), {
    recursive: true,
    force: true,
  });
}

/**
 * The mode, blob ID, and size of these files at a commit, by path. A path
 * that the commit does not have is not in the map. A submodule has no size.
 */
export async function treeAt(
  root: string,
  workspace: Workspace,
  commit: string,
  paths: readonly string[],
): Promise<
  Map<
    string,
    { readonly mode: string; readonly id: string; readonly bytes: number }
  >
> {
  const found = new Map<
    string,
    { readonly mode: string; readonly id: string; readonly bytes: number }
  >();
  const repo = await workspaceRepo(root, workspace);
  // A few hundred paths at a time keep the command line short.
  for (let at = 0; at < paths.length; at += 200)
    for (const line of await list(
      repo.workTree,
      [
        '--literal-pathspecs',
        'ls-tree',
        '-l',
        '-z',
        commit,
        '--',
        ...paths.slice(at, at + 200),
      ],
      repo,
    )) {
      // An entry is `<mode> <type> <id> <size>\t<path>`, and the path can hold a tab itself.
      const tab = line.indexOf('\t');
      const [mode = '', , id = '', size = ''] = line.slice(0, tab).split(/ +/);
      found.set(line.slice(tab + 1), {
        mode,
        id,
        bytes: /^\d+$/.test(size) ? Number(size) : 0,
      });
    }
  return found;
}

/** Two commits of a workspace have the same files. */
export async function sameTree(
  root: string,
  workspace: Workspace,
  a: string,
  b: string,
): Promise<boolean> {
  if (a === b) return true;
  const repo = await workspaceRepo(root, workspace);
  const [left, right] = (
    await git(repo.workTree, ['rev-parse', `${a}^{tree}`, `${b}^{tree}`], {
      repo,
    })
  )
    .toString('utf8')
    .trim()
    .split('\n');
  return left !== undefined && left === right;
}

/**
 * Remove the workspace folder when all its changes are in a commit. The
 * branch, or the Git directory of a folder workspace, keeps every version.
 * Returns false when the folder stays, or when Verifold cannot name its
 * repository.
 *
 * A folder workspace goes when no change stays, as before: environments and
 * caches go with it. A worktree stays when a plain removal would have kept it:
 * a tracked or staged change, or a new file that the project's ignore rules do
 * not ignore (an environment or a cache that is not ignored counts). It also
 * stays when it holds a folder with its own Git data. Ignored files do not
 * keep it, as they would not keep a plain removal. Then the forced removal
 * deletes nothing that a plain removal would have kept.
 */
export async function release(
  root: string,
  workspace: Workspace,
): Promise<boolean> {
  const target = join(root, workspace.path);
  if ((await lstat(target).catch(() => null)) === null) return true;
  try {
    const repo = await workspaceRepo(root, workspace);
    if (workspace.kind === 'folder') {
      const changed = await list(
        target,
        [
          'status',
          '--ignore-submodules=all',
          '--porcelain',
          '-z',
          '--',
          '.',
          ...caches,
        ],
        repo,
      );
      if (changed.length) return false;
      await rm(target, { recursive: true, force: true });
      return true;
    }
    // A change, or a new file that the project's own ignore rules do not ignore, with none of Verifold's cache rules.
    const changed = await list(
      target,
      [
        'status',
        '--ignore-submodules=all',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--',
        '.',
      ],
      repo,
    );
    const staged = await list(
      target,
      ['diff', '--cached', '--name-only', '-z'],
      repo,
    );
    // A folder with its own Git data, found without entering it. The worktree's own `.git` is not one.
    const top = (await readdir(target, { withFileTypes: true }).catch(() => []))
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== '.git' &&
          !toolFolders.includes(entry.name),
      )
      .map((entry) => entry.name);
    const nested = await nestedRepos(target, top);
    if (changed.length || staged.length || nested.length) return false;
    // Nothing above stays in the worktree, so the removal does not need to read its own Git data again.
    await git(root, ['worktree', 'remove', '--force', target]);
    return true;
  } catch {
    return false;
  }
}
