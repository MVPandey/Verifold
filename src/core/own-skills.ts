import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { ownSkillName } from './agency.ts';
import { askCodexServer, runCommand } from './detect.ts';
import type { HarnessName } from './harness.ts';
import { frontmatter, safeRelativePath } from './skill-files.ts';

/**
 * The skills that the person's own Claude Code and Codex load, read from
 * their files and from Codex's app-server. Verifold makes no model call and
 * writes nothing here. Verifold's own copies of added skills load only in
 * its sessions, so they never show up.
 */
export interface OwnSkill {
  readonly harness: HarnessName;
  /** The name that the harness lists, such as `python` or `vercel:nextjs`. */
  readonly name: string;
  readonly description: string;
  /** The person's own skill folder, claude.ai, a Claude Code plugin, or the computer's admin folder for Codex. */
  readonly source: 'personal' | 'synced' | 'plugin' | 'admin';
}

/** The executables and Claude Code's settings folder. Tests use fakes. */
export interface OwnSkillsOptions {
  readonly claude?: string;
  readonly codex?: string;
  readonly claudeConfig?: string;
}

/** The most skills of one harness, the bytes of a SKILL.md that Verifold reads, and the characters of a description. */
const limits = { skills: 300, head: 16 * 1024, description: 1024 } as const;

/** The start of a regular file, or null. A final symlink is not followed, and a pipe does not block. */
async function head(path: string): Promise<string | null> {
  try {
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!(await file.stat()).isFile()) return null;
      const buffer = Buffer.alloc(limits.head);
      const { bytesRead } = await file.read(buffer, 0, limits.head, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

/** The skills in a folder of `<name>/SKILL.md` folders: the frontmatter's name, else the folder's. */
async function skillFolders(
  root: string,
): Promise<{ readonly name: string; readonly description: string }[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries) {
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
      values.name && ownSkillName.test(values.name) ? values.name : entry.name;
    if (!ownSkillName.test(name)) continue;
    found.push({
      name,
      description: (values.description ?? '').slice(0, limits.description),
    });
  }
  return found;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Claude Code's skills: the person's skill folder, the claude.ai skills that
 * it syncs there (listed as `anthropic-skills:<name>`), and the skills of
 * each plugin that is on for every folder. Without Claude Code, none.
 */
async function claudeSkills(options: OwnSkillsOptions): Promise<OwnSkill[]> {
  const listed = await runCommand(options.claude ?? 'claude', [
    'plugin',
    'list',
    '--json',
  ]);
  if (listed.missing) return [];
  const config =
    options.claudeConfig ??
    process.env.CLAUDE_CONFIG_DIR ??
    join(homedir(), '.claude');
  const skills = join(config, 'skills');
  const found: OwnSkill[] = (await skillFolders(skills)).map((skill) => ({
    harness: 'claude',
    ...skill,
    source: 'personal',
  }));
  for (const synced of await readdir(join(skills, 'synced')).catch(() => []))
    if (!synced.startsWith('.'))
      for (const skill of await skillFolders(join(skills, 'synced', synced)))
        found.push({
          harness: 'claude',
          name: `anthropic-skills:${skill.name}`,
          description: skill.description,
          source: 'synced',
        });
  let plugins: unknown = [];
  try {
    plugins = JSON.parse(listed.stdout);
  } catch {
    // An older Claude Code without `--json` lists no plugins here.
  }
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    // A plugin of one project loads only there, not in a lab's folder.
    if (
      !record(plugin) ||
      plugin.enabled !== true ||
      plugin.scope !== 'user' ||
      typeof plugin.installPath !== 'string' ||
      !isAbsolute(plugin.installPath) ||
      typeof plugin.id !== 'string'
    )
      continue;
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
    for (const folder of new Set(folders))
      for (const skill of await skillFolders(join(root, folder))) {
        const name = `${named}:${skill.name}`;
        if (ownSkillName.test(name))
          found.push({
            harness: 'claude',
            name,
            description: skill.description,
            source: 'plugin',
          });
      }
  }
  return found;
}

/**
 * Codex's skills, as its app-server lists them with plugins off, as in a
 * lab session: the person's own skills and the computer's admin skills.
 * Codex's bundled skills stay on, so they are not listed. Without an answer
 * in 10 seconds, none.
 */
async function codexSkills(options: OwnSkillsOptions): Promise<OwnSkill[]> {
  const data = await askCodexServer<unknown[]>(
    options.codex ?? 'codex',
    ['-c', 'features.plugins=false', '-c', 'features.apps=false'],
    (call, finish) =>
      // An empty folder outside any project, so no project's skills come in.
      call('skills/list', { cwds: [tmpdir()], forceReload: true }, (result) =>
        finish(Array.isArray(result.data) ? result.data : null),
      ),
  );
  const found: OwnSkill[] = [];
  for (const entry of data ?? [])
    for (const skill of record(entry) && Array.isArray(entry.skills)
      ? entry.skills
      : []) {
      // A skill that the person turned off in Codex does not load anyway.
      if (
        !record(skill) ||
        (skill.scope !== 'user' && skill.scope !== 'admin') ||
        skill.enabled === false ||
        typeof skill.name !== 'string' ||
        !ownSkillName.test(skill.name)
      )
        continue;
      found.push({
        harness: 'codex',
        name: skill.name,
        description:
          typeof skill.description === 'string'
            ? skill.description.slice(0, limits.description)
            : '',
        source:
          skill.scope === 'admin'
            ? 'admin'
            : typeof skill.path === 'string' &&
                skill.path.includes(`${sep}synced${sep}`)
              ? 'synced'
              : 'personal',
      });
    }
  return found;
}

/** The skills of both harnesses, each name once per harness, at most 300 each. */
export async function listOwnSkills(
  options: OwnSkillsOptions = {},
): Promise<OwnSkill[]> {
  const lists = await Promise.all([
    claudeSkills(options),
    codexSkills(options),
  ]);
  return lists.flatMap((list) => {
    const seen = new Set<string>();
    return list
      .filter((skill) => {
        if (seen.has(skill.name)) return false;
        seen.add(skill.name);
        return true;
      })
      .slice(0, limits.skills);
  });
}
