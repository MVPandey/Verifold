import { opendir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { offTarget, ownSkillName } from './agency.ts';
import { askCodexServer, runCommand } from './detect.ts';
import type { HarnessName } from './harness.ts';
import { frontmatter, safeRelativePath } from './skill-files.ts';
import { readBounded } from './storage.ts';

/**
 * The skills that the person's own Claude Code and Codex load, read from
 * their files and from Codex's app-server. Verifold makes no model call and
 * writes nothing here. Verifold's own copies of added skills load only in
 * its sessions, so they never show up.
 */
export interface OwnSkill {
  readonly harness: HarnessName;
  /**
   * The skill's ID in the person's choices: its name for Claude Code, whose
   * rules cover every skill of a name, and its SKILL.md path for Codex,
   * where two skills of one name can each be turned off.
   */
  readonly id: string;
  /** The name that the harness lists, such as `python` or `vercel:nextjs`. */
  readonly name: string;
  readonly description: string;
  /** The person's own skill folder, claude.ai, a Claude Code plugin, or the computer's admin folder for Codex. */
  readonly source: 'personal' | 'synced' | 'plugin' | 'admin';
  /**
   * What turns the skill off in its harness. Claude Code: each name that
   * invokes it, the listed one and its folder's. Codex: its SKILL.md path,
   * so a bundled or project skill with the same name stays on.
   */
  readonly off: readonly string[];
}

/** The skills, and a line for each part that Verifold could not list. */
export interface OwnSkills {
  readonly skills: readonly OwnSkill[];
  readonly problems: readonly string[];
}

/** The executables, Claude Code's settings folder, and the signal that stops the listing. Tests use fakes. */
export interface OwnSkillsOptions {
  readonly claude?: string;
  readonly codex?: string;
  readonly claudeConfig?: string;
  readonly signal?: AbortSignal;
}

const limits = {
  /** Skills of one harness. */
  skills: 300,
  /** Bytes of a SKILL.md that Verifold reads for its frontmatter. */
  head: 64 * 1024,
  /** Characters of a description. */
  description: 1024,
  /** Entries that Verifold looks at in one folder of skills. */
  entries: 1000,
  /** Plugins of Claude Code, and folders of skills in one plugin. */
  plugins: 50,
  pluginFolders: 5,
  /** Bytes of Claude Code's plugin list. */
  pluginList: 1024 * 1024,
} as const;

/** The start of a regular file, or null. A final symlink is not followed, and a pipe does not block. */
function head(path: string): Promise<string | null> {
  return readBounded(path, limits.head, true).catch(() => null);
}

/** A skill folder as Verifold reads it: the frontmatter's name, the folder's name, and the description. */
interface Folder {
  readonly name: string;
  readonly folder: string;
  readonly description: string;
}

/**
 * The skills in a folder of `<name>/SKILL.md` folders, at most `room`. The
 * frontmatter's name is the one that the harness lists. Claude Code also
 * takes the folder's name.
 */
async function skillFolders(
  root: string,
  room: number,
  signal: AbortSignal | undefined,
): Promise<Folder[]> {
  const found: Folder[] = [];
  if (room <= 0) return found;
  let dir;
  try {
    dir = await opendir(root);
  } catch {
    return found;
  }
  let seen = 0;
  try {
    for await (const entry of dir) {
      signal?.throwIfAborted();
      if (++seen > limits.entries || found.length >= room) break;
      // A linked skill folder counts: people link one folder into several harnesses.
      if (
        entry.name.startsWith('.') ||
        !(entry.isDirectory() || entry.isSymbolicLink())
      )
        continue;
      const text = await head(join(root, entry.name, 'SKILL.md'));
      const values = text === null ? null : frontmatter(text)?.values;
      if (!values) continue;
      const name =
        values.name && ownSkillName.test(values.name)
          ? values.name
          : entry.name;
      found.push({
        name,
        folder: entry.name,
        description: (values.description ?? '').slice(0, limits.description),
      });
    }
  } finally {
    // A loop that ends early leaves the folder open.
    await dir.close().catch(() => {});
  }
  return found;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The names that turn a Claude Code skill off: the listed one, and the one with its folder's name. Null: one of them cannot go into a rule. */
function claudeOff(prefix: string, skill: Folder): string[] | null {
  const names = [...new Set([skill.name, skill.folder])].map(
    (name) => `${prefix}${name}`,
  );
  return names.every((name) => offTarget('claude', name)) ? names : null;
}

/**
 * Claude Code's skills: the person's skill folder, the claude.ai skills that
 * it syncs there (listed as `anthropic-skills:<name>`), and the skills of
 * each plugin that is on for every folder. Without Claude Code, none.
 */
async function claudeSkills(
  options: OwnSkillsOptions,
  problems: string[],
): Promise<OwnSkill[]> {
  const { signal } = options;
  // The plugin list runs while Verifold reads the skill folders.
  const listing = runCommand(
    options.claude ?? 'claude',
    ['plugin', 'list', '--json'],
    { maxBuffer: limits.pluginList, ...(signal ? { signal } : {}) },
  );
  const config =
    options.claudeConfig ??
    process.env.CLAUDE_CONFIG_DIR ??
    join(homedir(), '.claude');
  const skills = join(config, 'skills');
  const found: OwnSkill[] = [];
  const room = (): number => limits.skills - found.length;
  const add = (
    folders: readonly Folder[],
    source: OwnSkill['source'],
    prefix: string,
  ): void => {
    for (const skill of folders) {
      const off = claudeOff(prefix, skill);
      if (off?.[0] && found.length < limits.skills)
        found.push({
          harness: 'claude',
          id: off[0],
          name: off[0],
          description: skill.description,
          source,
          off,
        });
    }
  };
  // A personal skill with `:` in its name could stand for a plugin's skill, so it stays out.
  const personal = await skillFolders(skills, room(), signal);
  const clashing = personal.filter(
    (skill) => skill.name.includes(':') || skill.folder.includes(':'),
  );
  add(
    personal.filter((skill) => !clashing.includes(skill)),
    'personal',
    '',
  );
  for (const org of await syncedFolders(skills, signal))
    add(
      await skillFolders(join(skills, 'synced', org), room(), signal),
      'synced',
      'anthropic-skills:',
    );
  const listed = await listing;
  if (listed.missing) return [];
  if (clashing.length)
    problems.push(
      `Verifold leaves out ${clashing.length} ${clashing.length === 1 ? 'skill' : 'skills'} of your Claude Code skill folder whose names hold “:”, the mark of a plugin's skill.`,
    );
  let plugins: unknown = [];
  if (listed.overflow)
    problems.push(
      `Claude Code's plugin list is longer than ${limits.pluginList / 1024 / 1024} MB, so Verifold lists none of its plugin skills.`,
    );
  else
    try {
      plugins = JSON.parse(listed.stdout);
    } catch {
      problems.push(
        "Verifold could not read Claude Code's plugin list, so it lists none of its plugin skills.",
      );
    }
  const on = (Array.isArray(plugins) ? plugins : [])
    // A plugin of one project loads only there, not in a lab's folder.
    .filter(
      (
        plugin,
      ): plugin is Record<string, unknown> & {
        installPath: string;
        id: string;
      } =>
        record(plugin) &&
        plugin.enabled === true &&
        plugin.scope === 'user' &&
        typeof plugin.installPath === 'string' &&
        isAbsolute(plugin.installPath) &&
        typeof plugin.id === 'string',
    )
    .slice(0, limits.plugins);
  for (const plugin of on) {
    if (room() <= 0) break;
    const root = plugin.installPath;
    let manifest: unknown = null;
    try {
      manifest = JSON.parse(
        (await head(join(root, '.claude-plugin', 'plugin.json'))) ?? 'null',
      );
    } catch {
      // A plugin without a readable manifest takes its name from its ID.
    }
    const named =
      record(manifest) && typeof manifest.name === 'string'
        ? manifest.name
        : plugin.id.split('@')[0];
    const extra = record(manifest) ? manifest.skills : undefined;
    const folders = [
      'skills',
      ...(typeof extra === 'string'
        ? [extra]
        : Array.isArray(extra)
          ? extra
          : []
      )
        .filter((path): path is string => typeof path === 'string')
        .map((path) => path.replace(/^\.\//, '').replace(/\/$/, ''))
        .filter(safeRelativePath),
    ];
    for (const folder of [...new Set(folders)].slice(0, limits.pluginFolders))
      add(
        await skillFolders(join(root, folder), room(), signal),
        'plugin',
        `${named}:`,
      );
  }
  return found;
}

/** The folders of claude.ai organizations under `skills/synced/`. */
async function syncedFolders(
  skills: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const found: string[] = [];
  let dir;
  try {
    dir = await opendir(join(skills, 'synced'));
  } catch {
    return found;
  }
  try {
    for await (const entry of dir) {
      signal?.throwIfAborted();
      if (found.length >= 10) break;
      if (!entry.name.startsWith('.') && entry.isDirectory())
        found.push(entry.name);
    }
  } finally {
    await dir.close().catch(() => {});
  }
  return found;
}

/**
 * Codex's skills, as its app-server lists them with plugins off, as in a
 * lab session: the person's own skills and the computer's admin skills.
 * Codex's bundled skills stay on, so they are not listed. Without Codex,
 * none.
 */
async function codexSkills(
  options: OwnSkillsOptions,
  problems: string[],
): Promise<OwnSkill[]> {
  const executable = options.codex ?? 'codex';
  const { signal } = options;
  const data = await askCodexServer<unknown[]>(
    executable,
    ['-c', 'features.plugins=false', '-c', 'features.apps=false'],
    (call, finish) =>
      // A folder outside any project, so no project's skills come in.
      call('skills/list', { cwds: [tmpdir()], forceReload: true }, (result) =>
        finish(Array.isArray(result.data) ? result.data : null),
      ),
    signal,
  );
  if (!data) {
    if (
      !signal?.aborted &&
      !(await runCommand(executable, ['--version'], signal ? { signal } : {}))
        .missing
    )
      problems.push('Codex did not list its skills. Read the list again.');
    return [];
  }
  const found: OwnSkill[] = [];
  for (const entry of data)
    for (const skill of record(entry) && Array.isArray(entry.skills)
      ? entry.skills
      : []) {
      // A skill that the person turned off in Codex does not load anyway.
      if (
        found.length >= limits.skills ||
        !record(skill) ||
        (skill.scope !== 'user' && skill.scope !== 'admin') ||
        skill.enabled === false ||
        typeof skill.name !== 'string' ||
        !ownSkillName.test(skill.name) ||
        !offTarget('codex', skill.path)
      )
        continue;
      found.push({
        harness: 'codex',
        id: skill.path,
        name: skill.name,
        description:
          typeof skill.description === 'string'
            ? skill.description.slice(0, limits.description)
            : '',
        source:
          skill.scope === 'admin'
            ? 'admin'
            : skill.path.includes(`${sep}synced${sep}`)
              ? 'synced'
              : 'personal',
        off: [skill.path],
      });
    }
  return found;
}

/** The skills of both harnesses, each ID once per harness, at most 300 each. */
export async function listOwnSkills(
  options: OwnSkillsOptions = {},
): Promise<OwnSkills> {
  const problems: string[] = [];
  const lists = await Promise.all([
    claudeSkills(options, problems),
    codexSkills(options, problems),
  ]);
  options.signal?.throwIfAborted();
  const skills = lists.flatMap((list) => {
    const seen = new Set<string>();
    return list.filter((skill) => {
      if (seen.has(skill.id)) return false;
      seen.add(skill.id);
      return true;
    });
  });
  for (const harness of ['claude', 'codex'] as const)
    if (
      skills.filter((skill) => skill.harness === harness).length >=
      limits.skills
    )
      problems.push(
        `${harness === 'claude' ? 'Claude Code' : 'Codex'} loads more skills than Verifold lists. These are the first ${limits.skills}.`,
      );
  return { skills, problems };
}
