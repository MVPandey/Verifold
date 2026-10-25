import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
} from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  agencyDirectory,
  loadSettings,
  prepareAgency,
  withProfileLock,
  writeSettings,
} from './agency.ts';
import { SessionActionError } from './session.ts';
import { copyTree, removeTree } from './skills.ts';
import { loadWorkspace, missing } from './storage.ts';

/**
 * An isolated project's own profile, in `.verifold/agency/` of its folder.
 * It holds the same files as the global profile: the agents, the profile
 * card, the skills, and the GPU limits that the project starts with. The
 * monthly GPU limit across projects and its records stay in the global
 * profile, so an isolated project counts toward it.
 *
 * The folder comes when the person picks Isolated project, as a copy of
 * the global profile, before the project exists. The start only records
 * `ownProfile` in the workspace.
 */

/** Files and folders that stay with the profile folder they are in: its marker, its lock, and the month's GPU records. */
const ownedHere = new Set([
  '.verifold-agency',
  '.gitignore',
  'profile.lock',
  'gpu',
]);

/** The profile folder of an isolated project in `root`. */
export function ownProfileFolder(root: string): string {
  return join(root, '.verifold', 'agency');
}

/**
 * The profile that a project uses: its own when its workspace says so,
 * else `global`, the global profile folder. A workspace that exists but
 * does not read is refused, so a project never takes the wrong profile.
 */
export async function projectProfile(
  root: string,
  global: string,
): Promise<string> {
  let workspace;
  try {
    workspace = await loadWorkspace(root);
  } catch (error) {
    if (missing(error)) return global;
    throw new Error(
      `Verifold could not read ${join(root, '.verifold', 'workspace.json')}, so it cannot tell which settings this project uses: ${error instanceof Error ? error.message : 'unknown error'}`,
      { cause: error },
    );
  }
  return workspace.ownProfile ? ownProfileFolder(root) : global;
}

/**
 * The profile folders that no session in a project can read: an isolated
 * project's own, whether the project uses it yet or not, and a global one
 * outside the default folder, which every session closes already.
 */
export function profileDenial(root: string, global: string): string[] {
  return [ownProfileFolder(root), global].filter(
    (folder, index, all) =>
      folder !== agencyDirectory(root) && all.indexOf(folder) === index,
  );
}

/** When the global settings were last copied for an isolated project in `root`. Null: there is no copy. */
export async function ownProfileCopied(root: string): Promise<string | null> {
  try {
    return (
      await stat(join(ownProfileFolder(root), '.verifold-agency'))
    ).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * Why `root` cannot hold an isolated project's own settings: their folder
 * would be the global profile folder, inside it, or around it, as in the
 * home folder. Null: it can.
 */
export async function isolationProblem(
  global: string,
  root: string,
): Promise<string | null> {
  // The real path of the nearest folder that exists, with the rest of the path after it.
  const real = async (path: string): Promise<string> => {
    const full = resolve(path);
    try {
      return await realpath(full);
    } catch (error) {
      if (!missing(error) || dirname(full) === full) return full;
      return join(await real(dirname(full)), basename(full));
    }
  };
  const own = join(await real(root), '.verifold', 'agency');
  const shared = await real(global);
  const within = (inner: string, outer: string): boolean =>
    inner === outer || inner.startsWith(`${outer}${sep}`);
  return within(own, shared) || within(shared, own)
    ? 'This folder holds your global settings, so a project here can’t have settings of its own. To set up an isolated project, run verifold in another folder.'
    : null;
}

/**
 * Make an isolated project's profile in `root` a copy of the global one:
 * every step without a record, so the person goes through each one, and
 * no monthly limit, which only the global profile holds. A copy before
 * this one goes first, unread, so a broken copy can always start again.
 * The global profile's lock and the copy's own hold while it runs. The
 * month's records, the locks, the markers, and the catalogs as read are
 * not copied.
 */
export async function copyGlobalProfile(
  global: string,
  root: string,
  signal: AbortSignal,
  /** Runs the copy under the global profile's lock. A first run of the global profile in this process passes its own, so its writes go first. */
  holdGlobal: <T>(work: () => Promise<T>) => Promise<T> = (work) =>
    withProfileLock(global, signal, work, { check: false, waitMs: 2_000 }),
): Promise<void> {
  const problem = await isolationProblem(global, root);
  if (problem) throw new SessionActionError(problem);
  const state = join(root, '.verifold');
  const entry = await lstat(state).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  if (entry && !entry.isDirectory())
    throw new Error('.verifold must be a real folder, not a link or a file.');
  const own = ownProfileFolder(root);
  const copy = async (): Promise<void> => {
    for (const item of await readdir(own, { withFileTypes: true }))
      if (item.name !== 'profile.lock' && item.name !== '.verifold-agency')
        await (item.isDirectory()
          ? removeTree(join(own, item.name))
          : rm(join(own, item.name), { force: true }));
    await prepareAgency(own);
    // The marker's time is the time of this copy.
    const now = new Date();
    await utimes(join(own, '.verifold-agency'), now, now);
    for (const item of await readdir(global, { withFileTypes: true })) {
      if (ownedHere.has(item.name) || item.name === 'settings.json') continue;
      const source = join(global, item.name);
      const target = join(own, item.name);
      if (item.name === 'skills' && item.isDirectory()) {
        // The catalogs as read are a cache: a search here reads them again.
        await mkdir(target, { mode: 0o700 });
        for (const skill of await readdir(source, { withFileTypes: true }))
          if (skill.isDirectory() && skill.name !== '.catalogs')
            await copyTree(join(source, skill.name), join(target, skill.name));
      } else if (item.isDirectory()) await copyTree(source, target);
      else if (item.isFile())
        await copyFile(source, target, constants.COPYFILE_EXCL);
    }
    // Settings that do not read leave the copy without agents or limits: the person sets them up here.
    const settings = await loadSettings(global).catch(() => null);
    await writeSettings(own, () => ({
      agency: settings?.agency ?? null,
      money: settings?.money ? { ...settings.money, monthUsd: null } : null,
      unreadMoney: null,
      steps: {},
    }));
  };
  await holdGlobal(() => withProfileLock(own, signal, copy, { check: false }));
}
