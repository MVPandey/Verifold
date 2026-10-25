import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, realpath, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  agencyDirectory,
  loadSettings,
  prepareAgency,
  withProfileLock,
  writeSettings,
} from './agency.ts';
import { SessionActionError } from './session.ts';
import { copyTree, removeTree } from './skills.ts';
import { exists, isFolder, loadWorkspace } from './storage.ts';

/**
 * An isolated project's own profile. It holds the same files as the global
 * profile: the agents, the profile card, the skills, and the GPU limits
 * that the project starts with. The monthly GPU limit across projects and
 * its records stay in the global profile, so an isolated project counts
 * toward it.
 *
 * Before the project exists, its profile is a draft in the global profile
 * folder, under `drafts/`, which lab sessions cannot read. The draft starts
 * as a copy of the global profile. At the start, the project takes a copy of
 * it as `.verifold/agency/`, and its workspace records `ownProfile`.
 */

/** Files and folders that stay with the profile folder they are in: its marker, its lock, the drafts, and the month's GPU records. */
const ownedHere = new Set([
  '.verifold-agency',
  '.gitignore',
  'profile.lock',
  'drafts',
  'gpu',
]);

/** The profile folder of an isolated project. */
export function ownProfileFolder(root: string): string {
  return join(root, '.verifold', 'agency');
}

/**
 * The profile that a project uses: its own when its workspace says so,
 * else `global`, the global profile folder.
 */
export async function projectProfile(
  root: string,
  global: string,
): Promise<string> {
  const workspace = await loadWorkspace(root).catch(() => null);
  return workspace?.ownProfile ? ownProfileFolder(root) : global;
}

/**
 * The lab's `denyRead` for the profile folders of a project: each one but
 * the default global folder, which every session closes already.
 */
export function profileDenial(
  root: string,
  folders: readonly string[],
): { readonly denyRead?: readonly string[] } {
  const closed = [...new Set(folders)].filter(
    (folder) => folder !== agencyDirectory(root),
  );
  return closed.length ? { denyRead: closed } : {};
}

/** The draft of the profile of a project that starts in `root`. */
export async function draftFolder(
  global: string,
  root: string,
): Promise<string> {
  const path = await realpath(root);
  return join(
    global,
    'drafts',
    createHash('sha256').update(path).digest('hex').slice(0, 16),
  );
}

/** Copy a profile folder's files into `to`, which `prepareAgency` made. Links and other kinds of files are not copied. */
async function copyProfile(
  from: string,
  to: string,
  skip: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (ownedHere.has(entry.name) || skip.has(entry.name)) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target);
    else if (entry.isFile())
      await copyFile(source, target, constants.COPYFILE_EXCL);
  }
}

/**
 * Make the draft from the global profile: every step without a record, so
 * the person goes through each one, and no monthly limit, which only the
 * global profile holds. A draft that exists stays, unless `again`.
 */
export async function seedDraft(
  global: string,
  draft: string,
  again = false,
): Promise<void> {
  if (!again && (await isFolder(draft))) return;
  await prepareAgency(global);
  await mkdir(join(global, 'drafts'), { recursive: true, mode: 0o700 });
  const temporary = `${draft}.${randomUUID()}.tmp`;
  try {
    await prepareAgency(temporary);
    // Settings that do not read leave the draft empty: the project is set up on its own anyway.
    const settings = await loadSettings(global).catch(() => null);
    await writeSettings(temporary, () => ({
      agency: settings?.agency ?? null,
      money: settings?.money ? { ...settings.money, monthUsd: null } : null,
      unreadMoney: null,
      steps: {},
    }));
    await copyProfile(global, temporary, new Set(['settings.json']));
    if (!again) {
      try {
        await rename(temporary, draft);
      } catch (error) {
        // Another start made the draft first. That one stays.
        if (!(await isFolder(draft))) throw error;
        await removeTree(temporary);
      }
      return;
    }
    const old = `${draft}.${randomUUID()}.old`;
    const had = await isFolder(draft);
    if (had) await rename(draft, old);
    try {
      await rename(temporary, draft);
    } catch (error) {
      if (had) await rename(old, draft);
      throw error;
    }
    if (had) await removeTree(old).catch(() => {});
  } catch (error) {
    await removeTree(temporary).catch(() => {});
    throw error;
  }
}

/**
 * The draft of the project that starts in `root`, made from the global
 * profile when it is not there, or made again with `again`. A copy again
 * holds the draft's lock, so a save in it cannot run meanwhile. A failure
 * comes back as a reason for the person.
 */
export async function readyDraft(
  global: string,
  root: string,
  signal: AbortSignal,
  again = false,
): Promise<string> {
  try {
    const folder = await draftFolder(global, root);
    if (again && (await isFolder(folder)))
      await withProfileLock(folder, signal, () =>
        seedDraft(global, folder, true),
      );
    else await seedDraft(global, folder);
    return folder;
  } catch (error) {
    if (error instanceof SessionActionError) throw error;
    throw new SessionActionError(
      `Verifold could not copy your global settings for this project: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

/**
 * Copy the draft into the project as its own profile folder: a copy beside
 * the place first, then a rename, so the folder is whole or not there.
 * Returns the folder.
 */
export async function placeProfile(
  draft: string,
  root: string,
): Promise<string> {
  if (!(await isFolder(draft)))
    throw new Error(
      "This project's settings are not there any more. Choose Isolated project and set them up again.",
    );
  const target = ownProfileFolder(root);
  if (await exists(target))
    throw new Error(`${target} exists already; refusing to replace it.`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await prepareAgency(temporary);
    await copyProfile(draft, temporary);
    await rename(temporary, target);
  } catch (error) {
    await removeTree(temporary).catch(() => {});
    throw error;
  }
  return target;
}
