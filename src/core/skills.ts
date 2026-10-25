import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import {
  loadOwnChoices,
  ownChoicesFile,
  prepareAgency,
  readMemory,
  saveAgencyFile,
  skillsOff,
} from './agency.ts';
import { runHarness, type HarnessName } from './harness.ts';
import { loadPrompt } from './prompts.ts';
import { parseHostJson } from './research-contracts.ts';
import { SessionActionError, type SessionSkills } from './session.ts';
import { inEmptyFolder, isFolder } from './storage.ts';
import {
  blobSha,
  contentRefusal,
  frontmatter,
  licenseName,
  safeRelativePath,
  treeRefusal,
  validSkillName,
  whatItRuns,
  withoutAllowedTools,
  type SkillFile,
  type SkillRuns,
} from './skill-files.ts';

/**
 * Agent skills for Verifold's agents. Verifold reads a fixed list of public
 * catalogs on GitHub, offers the skills that fit the person's profile, and
 * keeps the skills that the person adds, pinned to a commit, in the
 * profile folder:
 * - `skills.json`: what the person added;
 * - `skills/<owner>/<repo>/<commit>/<path>/`: each added skill, read-only;
 * - `skills/.catalogs/`: the catalogs as read, by commit.
 * Lab agents and checkers never read the profile folder for skills. They
 * load a read-only copy of the added skills from `~/.verifold/plugins/<hash>/`,
 * a plugin that Claude Code loads with `--plugin-dir` and Codex as an extra
 * skill root. Their sandboxes write only in their own folders and in
 * temporary folders, so they cannot change it. Nothing goes into the
 * person's own Claude Code or Codex folders.
 */

/** A public catalog of skills. `root`: the folder under which its skills sit. */
export interface Catalog {
  readonly owner: string;
  readonly repo: string;
  readonly root: string;
}

/** The catalogs, those for ML and research first. */
export const catalogs: readonly Catalog[] = [
  { owner: 'Orchestra-Research', repo: 'AI-Research-SKILLs', root: '' },
  { owner: 'huggingface', repo: 'skills', root: 'skills/' },
  { owner: 'K-Dense-AI', repo: 'scientific-agent-skills', root: 'skills/' },
  { owner: 'anthropics', repo: 'skills', root: 'skills/' },
  { owner: 'anthropics', repo: 'life-sciences', root: '' },
  { owner: 'openai', repo: 'skills', root: 'skills/.curated/' },
];

/** Where Verifold reads GitHub. Tests use a fake server. */
export interface GitHubHosts {
  readonly api: string;
  readonly raw: string;
}

const githubHosts: GitHubHosts = {
  api: 'https://api.github.com',
  raw: 'https://raw.githubusercontent.com',
};

const limits = {
  /** Skills whose SKILL.md Verifold reads in one search, the best matches by their folders first. */
  reads: 40,
  /** Skills that the person's harness picks from. */
  pool: 20,
  cards: 3,
  /** The most skills that one search downloads to check for cards. */
  downloads: 8,
  /** Concurrent reads from GitHub. */
  parallel: 4,
  tree: 16 * 1024 * 1024,
  head: 8192,
} as const;

/** A skill of a catalog at one commit. */
export interface CatalogSkill {
  /** The same for each commit of the skill: a hash of its repository and folder. */
  readonly id: string;
  readonly owner: string;
  readonly repo: string;
  readonly commit: string;
  /** The skill's folder in the repository. */
  readonly path: string;
  /** The folder's name. */
  readonly name: string;
  /** The folder's git tree SHA at the commit. A new one means the skill changed. */
  readonly tree: string;
  readonly files: readonly SkillFile[];
}

/** What the catalog's SKILL.md says about a skill. */
interface SkillMeta {
  readonly name: string | null;
  readonly description: string;
  readonly license: string | null;
}

/** A catalog as read at one commit, with what Verifold read of it since. */
interface CatalogRead {
  readonly schemaVersion: 1;
  readonly commit: string;
  readonly skills: readonly CatalogSkill[];
  /** The repository's own license file, if it has one. */
  readonly licenseFile: { readonly path: string; readonly sha: string } | null;
  /** The license that file names. Undefined: not read yet. */
  licenseName?: string | null;
  readonly meta: Record<string, SkillMeta>;
  /** When each skill's folder last changed, by skill ID. */
  readonly updated: Record<string, string | null>;
}

/** A skill that the search offers. */
export interface SkillCard {
  readonly skill: CatalogSkill;
  /** One plain line on what it does. */
  readonly what: string;
  readonly license: string | null;
  /** When its folder last changed. */
  readonly updated: string | null;
  readonly runs: SkillRuns;
}

export interface SkillSearch {
  readonly at: string;
  readonly catalogs: readonly {
    readonly repo: string;
    readonly commit: string | null;
    readonly problem: string | null;
  }[];
  /** The harness that picked the cards. Null: they are Verifold's best matches. */
  readonly picker: HarnessName | null;
  readonly cards: readonly SkillCard[];
}

/** A skill that the person added. */
export interface AddedSkill {
  readonly id: string;
  readonly name: string;
  /** `owner/repo`. */
  readonly repo: string;
  readonly commit: string;
  readonly path: string;
  readonly tree: string;
  readonly license: string | null;
  readonly addedAt: string;
}

function fail(message: string): never {
  throw new SessionActionError(message);
}

/** GitHub's limit of reads without an account is used up. Every read after it fails too. */
class GitHubLimitError extends SessionActionError {}

const hex40 = /^[0-9a-f]{40}$/;
const hex16 = /^[0-9a-f]{16}$/;
const fileModes = new Set(['100644', '100755', '120000', '160000']);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The ID of a skill: the same for each of its commits. */
function skillId(owner: string, repo: string, path: string): string {
  return createHash('sha256')
    .update(`${owner}/${repo}/${path}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Read a GitHub URL with a time limit and a size limit. A used-up limit of
 * reads without an account becomes a reason that the person can act on.
 */
async function get(
  url: string,
  signal: AbortSignal,
  limit: number,
  headers: Record<string, string> = {},
): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'verifold', ...headers },
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (
      (response.status === 403 || response.status === 429) &&
      response.headers.get('x-ratelimit-remaining') === '0'
    ) {
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const when =
        Number.isFinite(reset) && reset > 0
          ? new Date(reset * 1000).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })
          : 'later';
      throw new GitHubLimitError(
        `GitHub allows a limited number of reads without an account, and they are used up until ${when}. Try again then.`,
      );
    }
    throw new Error(`GitHub answered ${response.status}.`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  for (;;) {
    const part = await reader?.read();
    if (!part || part.done) break;
    size += part.value.length;
    if (size > limit) {
      await reader?.cancel().catch(() => {});
      throw new Error('GitHub sent more than Verifold reads.');
    }
    chunks.push(Buffer.from(part.value));
  }
  return Buffer.concat(chunks);
}

/** A repository path as a URL path: each part encoded. */
function urlPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Run `work` for each item, at most `parallel` at a time. The first failure stops the rest. */
async function each<T>(
  items: readonly T[],
  parallel: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  await Promise.all(
    Array.from({ length: Math.min(parallel, items.length) }, async () => {
      while (!failed && next < items.length) {
        const item = items[next++] as T;
        try {
          await work(item);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
}

/** The profile's skills folder, created private and checked not to be a link. */
async function skillsRoot(directory: string): Promise<string> {
  await prepareAgency(directory);
  const root = join(directory, 'skills');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory())
    throw new Error('The skills folder must be a folder, not a link.');
  return root;
}

/** Each folder above a path, the nearest first: `a/b/c` gives `a/b`, then `a`. */
function parents(path: string): string[] {
  const parts = path.split('/');
  return parts
    .slice(1)
    .map((_, at) => parts.slice(0, parts.length - 1 - at).join('/'));
}

/**
 * The skills of one catalog's tree, in one pass: each file belongs to the
 * nearest folder above it that has a SKILL.md. A skill whose folder holds
 * another skill, or that sits inside another skill's folder, is left out:
 * its files would mix with the other's.
 */
function skillsOf(
  catalog: Catalog,
  commit: string,
  tree: readonly Record<string, unknown>[],
): CatalogSkill[] {
  const trees = new Map<string, string>();
  const folders = new Set<string>();
  for (const entry of tree) {
    const path = typeof entry.path === 'string' ? entry.path : '';
    if (entry.type === 'tree') trees.set(path, String(entry.sha));
    else if (entry.type === 'blob' && path.endsWith('/SKILL.md'))
      folders.add(path.slice(0, -'/SKILL.md'.length));
  }
  // A folder inside another skill's folder, and that other folder: neither is offered.
  const nested = new Set<string>();
  for (const folder of folders)
    for (const parent of parents(folder))
      if (folders.has(parent)) {
        nested.add(folder);
        nested.add(parent);
      }
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const entry of tree) {
    const path = typeof entry.path === 'string' ? entry.path : '';
    if (entry.type === 'tree') continue;
    const owner = parents(path).find((folder) => folders.has(folder));
    if (owner) grouped.set(owner, [...(grouped.get(owner) ?? []), entry]);
  }
  const skills: CatalogSkill[] = [];
  for (const folder of folders) {
    const inside = folder.slice(catalog.root.length);
    // Hidden folders and the templates of a catalog are not skills.
    if (
      !folder.startsWith(catalog.root) ||
      !inside ||
      nested.has(folder) ||
      inside.split('/').some((part) => part.startsWith('.')) ||
      /(^|\/)template$/.test(inside) ||
      !safeRelativePath(folder)
    )
      continue;
    const sha = trees.get(folder);
    if (!sha || !hex40.test(sha)) continue;
    const files: SkillFile[] = [];
    let valid = true;
    for (const file of grouped.get(folder) ?? []) {
      const relative = String(file.path).slice(folder.length + 1);
      const mode = String(file.mode);
      const blob = String(file.sha);
      if (
        !safeRelativePath(relative) ||
        !fileModes.has(mode) ||
        !hex40.test(blob)
      ) {
        valid = false;
        break;
      }
      files.push({
        path: relative,
        mode,
        size: typeof file.size === 'number' ? file.size : 0,
        sha: blob,
      });
    }
    if (!valid) continue;
    skills.push({
      id: skillId(catalog.owner, catalog.repo, folder),
      owner: catalog.owner,
      repo: catalog.repo,
      commit,
      path: folder,
      name: folder.split('/').at(-1) ?? '',
      tree: sha,
      files,
    });
  }
  return skills;
}

/** A cached catalog, checked, or null when it cannot be used. */
function parseRead(value: unknown, catalog: Catalog): CatalogRead | null {
  if (!record(value) || value.schemaVersion !== 1) return null;
  const { commit, skills, meta, updated } = value;
  if (typeof commit !== 'string' || !hex40.test(commit)) return null;
  if (!Array.isArray(skills) || !record(meta) || !record(updated)) return null;
  const valid = skills.every(
    (skill: unknown) =>
      record(skill) &&
      typeof skill.id === 'string' &&
      hex16.test(skill.id) &&
      skill.owner === catalog.owner &&
      skill.repo === catalog.repo &&
      skill.commit === commit &&
      safeRelativePath(skill.path) &&
      typeof skill.name === 'string' &&
      typeof skill.tree === 'string' &&
      hex40.test(skill.tree) &&
      Array.isArray(skill.files) &&
      skill.files.every(
        (file: unknown) =>
          record(file) &&
          safeRelativePath(file.path) &&
          typeof file.mode === 'string' &&
          fileModes.has(file.mode) &&
          typeof file.size === 'number' &&
          typeof file.sha === 'string' &&
          hex40.test(file.sha),
      ),
  );
  if (!valid) return null;
  const licenseFile = record(value.licenseFile) ? value.licenseFile : null;
  return {
    schemaVersion: 1,
    commit,
    skills: skills as CatalogSkill[],
    licenseFile:
      licenseFile &&
      safeRelativePath(licenseFile.path) &&
      typeof licenseFile.sha === 'string' &&
      hex40.test(licenseFile.sha)
        ? { path: licenseFile.path, sha: licenseFile.sha }
        : null,
    ...(typeof value.licenseName === 'string' || value.licenseName === null
      ? { licenseName: value.licenseName }
      : {}),
    meta: Object.fromEntries(
      Object.entries(meta).flatMap(([id, entry]): [string, SkillMeta][] =>
        hex16.test(id) &&
        record(entry) &&
        (entry.name === null || typeof entry.name === 'string') &&
        typeof entry.description === 'string' &&
        entry.description.length <= 1024 &&
        (entry.license === null ||
          (typeof entry.license === 'string' && entry.license.length <= 80))
          ? [
              [
                id,
                {
                  name:
                    entry.name === null
                      ? null
                      : String(entry.name).slice(0, 200),
                  description: entry.description,
                  license: entry.license,
                },
              ],
            ]
          : [],
      ),
    ),
    updated: Object.fromEntries(
      Object.entries(updated).filter(
        ([id, date]) =>
          hex16.test(id) &&
          (date === null ||
            (typeof date === 'string' && Number.isFinite(Date.parse(date)))),
      ) as [string, string | null][],
    ),
  };
}

function cachePath(root: string, catalog: Catalog): string {
  return join(root, '.catalogs', `${catalog.owner}--${catalog.repo}.json`);
}

async function saveRead(
  root: string,
  catalog: Catalog,
  read: CatalogRead,
): Promise<void> {
  const path = cachePath(root, catalog);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(read), {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * One catalog at its newest commit: one REST call for the commit, and one
 * more for its tree when the commit is new to Verifold.
 */
async function readCatalog(
  catalog: Catalog,
  root: string,
  hosts: GitHubHosts,
  signal: AbortSignal,
): Promise<CatalogRead> {
  const base = `${hosts.api}/repos/${catalog.owner}/${catalog.repo}`;
  const commit = (
    await get(`${base}/commits/HEAD`, signal, 100, {
      Accept: 'application/vnd.github.sha',
    })
  )
    .toString('utf8')
    .trim();
  if (!hex40.test(commit)) throw new Error('GitHub sent no commit.');
  try {
    const cached = parseRead(
      JSON.parse(await readFile(cachePath(root, catalog), 'utf8')),
      catalog,
    );
    if (cached?.commit === commit) return cached;
  } catch {
    /* No usable copy: read the tree. */
  }
  const body = JSON.parse(
    (
      await get(
        `${base}/git/trees/${commit}?recursive=1`,
        signal,
        limits.tree,
        {
          Accept: 'application/vnd.github+json',
        },
      )
    ).toString('utf8'),
  ) as unknown;
  // A partial list could split a skill's files, so it makes no skills.
  if (record(body) && body.truncated === true)
    throw new Error('GitHub sent only part of its file list.');
  const tree =
    record(body) && Array.isArray(body.tree)
      ? body.tree.filter(record)
      : fail('GitHub sent no file list for a catalog.');
  const license = tree.find(
    (entry) =>
      entry.type === 'blob' &&
      typeof entry.path === 'string' &&
      /^(LICENSE|LICENCE|COPYING)(\.(md|txt))?$/i.test(entry.path) &&
      typeof entry.sha === 'string' &&
      hex40.test(entry.sha),
  );
  const read: CatalogRead = {
    schemaVersion: 1,
    commit,
    skills: skillsOf(catalog, commit, tree),
    licenseFile: license
      ? { path: String(license.path), sha: String(license.sha) }
      : null,
    meta: {},
    updated: {},
  };
  await saveRead(root, catalog, read);
  return read;
}

const stopWords = new Set(
  (
    'about also and are can could does doing for from has have into just lately like ' +
    'made make more most new not only other over should skill skills some such than ' +
    'that the their them then they this try under use used using very want was well ' +
    'were what when which while will with work works would you your agent agents ' +
    'explore research model models cheap scale help helps'
  ).split(' '),
);

/** The words of a text that can match: lowercase, 3 letters or more, without common words. */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(
        (word) =>
          word.length >= 3 && !stopWords.has(word) && !/^\d+$/.test(word),
      ),
  );
}

/** How many words of `text` match the profile: the same word, or a shared start of 6 letters or more. */
function matches(profile: ReadonlySet<string>, text: string): number {
  let count = 0;
  for (const word of words(text))
    if (
      profile.has(word) ||
      [...profile].some((want) => {
        let shared = 0;
        while (shared < want.length && want[shared] === word[shared]) shared++;
        return shared >= 6;
      })
    )
      count++;
  return count;
}

/** The start of each SKILL.md: enough for its frontmatter. Reads from raw.githubusercontent.com cost no REST call. */
async function readMeta(
  items: readonly {
    readonly skill: CatalogSkill;
    readonly read: CatalogRead;
  }[],
  hosts: GitHubHosts,
  signal: AbortSignal,
): Promise<void> {
  const missing = items.filter(({ skill, read }) => !read.meta[skill.id]);
  await each(missing, limits.parallel, async ({ skill, read }) => {
    let text: string;
    try {
      text = (
        await get(
          `${hosts.raw}/${skill.owner}/${skill.repo}/${skill.commit}/${urlPath(`${skill.path}/SKILL.md`)}`,
          signal,
          // A server that ignores the range sends the whole file, up to its size in the tree.
          Math.max(
            limits.head,
            ...skill.files
              .filter((file) => file.path === 'SKILL.md')
              .map((file) => file.size),
          ),
          { Range: `bytes=0-${limits.head - 1}` },
        )
      )
        .subarray(0, limits.head)
        .toString('utf8');
    } catch {
      // A read that failed, GitHub's limit too, leaves the skill without a description.
      return;
    }
    const front = frontmatter(text);
    read.meta[skill.id] = {
      name: front?.values.name ?? null,
      description: (front?.values.description ?? '').slice(0, 1024),
      license: front?.values.license?.slice(0, 80) ?? null,
    };
  });
}

/** Verifold's own line on what a skill does: its description, cut at a word. */
function cut(text: string, limit = 200): string {
  if (text.length <= limit) return text;
  const short = text.slice(0, limit);
  return `${short.slice(0, short.lastIndexOf(' ') > 80 ? short.lastIndexOf(' ') : limit).trimEnd()}…`;
}

/** The person's harness picks up to three skills, with a line on each. Null: it gave no answer that Verifold can use. */
async function pick(
  picker: { readonly host: HarnessName; readonly model?: string },
  profile: string,
  pool: readonly { readonly skill: CatalogSkill; readonly meta: SkillMeta }[],
  signal: AbortSignal,
  run: typeof runHarness,
): Promise<{ readonly id: string; readonly what: string }[] | null> {
  return inEmptyFolder('skills', async (folder) => {
    try {
      const result = await run({
        host: picker.host,
        ...(picker.model ? { model: picker.model } : {}),
        cwd: folder,
        signal,
        timeoutMs: 180_000,
        idleMs: 120_000,
        // The catalogs' descriptions come from outside, so the picker can neither search nor fetch, and without every MCP server off it does not run.
        textOnly: true,
        outsideText: true,
        prompt: `${await loadPrompt('skills-pick')}

The input, as JSON:
${JSON.stringify({
  profile,
  skills: pool.map(({ skill, meta }) => ({
    id: skill.id,
    name: meta.name ?? skill.name,
    description: meta.description.slice(0, 400),
    catalog: `${skill.owner}/${skill.repo}`,
  })),
})}`,
      });
      const value = parseHostJson(result.text);
      if (!record(value) || !Array.isArray(value.picks)) return null;
      const ids = new Set(pool.map(({ skill }) => skill.id));
      const picks: { id: string; what: string }[] = [];
      for (const entry of value.picks) {
        if (!record(entry) || typeof entry.id !== 'string') continue;
        if (!ids.has(entry.id) || picks.some((item) => item.id === entry.id))
          continue;
        const what = typeof entry.what === 'string' ? entry.what.trim() : '';
        picks.push({ id: entry.id, what: cut(what) });
        if (picks.length === limits.cards) break;
      }
      return picks;
    } catch {
      signal.throwIfAborted();
      return null;
    }
  });
}

/**
 * Every file of a skill at its commit, each checked against the commit's
 * tree: its size and its git blob SHA. A file that differs stops the read.
 */
async function downloadSkill(
  skill: CatalogSkill,
  hosts: GitHubHosts,
  signal: AbortSignal,
): Promise<Map<string, Buffer>> {
  const contents = new Map<string, Buffer>();
  const stop = new AbortController();
  const both = AbortSignal.any([signal, stop.signal]);
  try {
    await each(skill.files, limits.parallel, async (file) => {
      if (file.mode === '120000' || file.mode === '160000')
        fail(
          `${skill.name} has a link or a submodule, so Verifold does not add it.`,
        );
      const body = await get(
        `${hosts.raw}/${skill.owner}/${skill.repo}/${skill.commit}/${urlPath(`${skill.path}/${file.path}`)}`,
        both,
        file.size,
      );
      if (body.length !== file.size || blobSha(body) !== file.sha)
        fail(
          `A file of ${skill.name} does not match its commit, so Verifold did not add the skill.`,
        );
      contents.set(file.path, body);
    });
  } catch (error) {
    stop.abort();
    throw error;
  }
  return contents;
}

/** The license of a skill: its frontmatter's, its own license file's, or its catalog's. */
async function licenseOf(
  skill: CatalogSkill,
  meta: SkillMeta | undefined,
  contents: ReadonlyMap<string, Buffer>,
  read: CatalogRead,
  hosts: GitHubHosts,
  signal: AbortSignal,
): Promise<string | null> {
  if (meta?.license) return meta.license;
  for (const [path, content] of contents)
    if (/^(LICENSE|LICENCE|COPYING)(\.(md|txt))?$/i.test(path))
      return licenseName(content.toString('utf8')) ?? 'See its LICENSE file';
  if (read.licenseName === undefined && read.licenseFile) {
    const file = read.licenseFile;
    read.licenseName = await get(
      `${hosts.raw}/${skill.owner}/${skill.repo}/${read.commit}/${urlPath(file.path)}`,
      signal,
      256 * 1024,
    )
      .then((body) =>
        blobSha(body) === file.sha ? licenseName(body.toString('utf8')) : null,
      )
      .catch(() => null);
  }
  return read.licenseName ? `${read.licenseName}, from its catalog` : null;
}

/** When the skill's folder last changed: one REST call, kept with the catalog. */
async function folderDate(
  skill: CatalogSkill,
  read: CatalogRead,
  hosts: GitHubHosts,
  signal: AbortSignal,
): Promise<string | null> {
  if (skill.id in read.updated) return read.updated[skill.id] ?? null;
  let date: string | null = null;
  try {
    const body = JSON.parse(
      (
        await get(
          `${hosts.api}/repos/${skill.owner}/${skill.repo}/commits?sha=${skill.commit}&path=${encodeURIComponent(skill.path)}&per_page=1`,
          signal,
          512 * 1024,
          { Accept: 'application/vnd.github+json' },
        )
      ).toString('utf8'),
    ) as unknown;
    const first = Array.isArray(body) ? (body[0] as unknown) : null;
    const commit = record(first) && record(first.commit) ? first.commit : null;
    const committer =
      commit && record(commit.committer) ? commit.committer : null;
    const value = committer?.date;
    date =
      typeof value === 'string' && Number.isFinite(Date.parse(value))
        ? value
        : null;
  } catch (error) {
    // GitHub's limit: the card shows no date, and a later search reads it.
    if (error instanceof GitHubLimitError) return null;
  }
  read.updated[skill.id] = date;
  return date;
}

/**
 * Search the catalogs for skills that fit the profile: score the skill
 * folders' paths, read the SKILL.md of the best ones, score them again, let
 * the person's harness pick up to three of the best 20, and check each pick's
 * files before it becomes a card. Without a harness, or when it gives no
 * usable answer, the three best matches become the cards.
 */
export async function searchSkills(input: {
  readonly directory: string;
  /** What the person works on and wants to explore. */
  readonly profile: string;
  readonly picker: {
    readonly host: HarnessName;
    readonly model?: string;
  } | null;
  /** The skills that the person added. A newer version of one comes first, as a card of its own. */
  readonly added?: readonly AddedSkill[];
  readonly signal: AbortSignal;
  readonly run?: typeof runHarness;
  readonly hosts?: GitHubHosts;
}): Promise<SkillSearch> {
  const { signal } = input;
  const hosts = input.hosts ?? githubHosts;
  const root = await skillsRoot(input.directory);
  const reads: {
    readonly catalog: Catalog;
    readonly read: CatalogRead;
    /** The copy as read, to tell whether this search changed it. */
    readonly before: string;
  }[] = [];
  const shown: SkillSearch['catalogs'][number][] = [];
  let stopped: string | null = null;
  for (const catalog of catalogs) {
    const repo = `${catalog.owner}/${catalog.repo}`;
    if (stopped) {
      shown.push({ repo, commit: null, problem: stopped });
      continue;
    }
    try {
      const read = await readCatalog(catalog, root, hosts, signal);
      reads.push({ catalog, read, before: JSON.stringify(read) });
      shown.push({ repo, commit: read.commit, problem: null });
    } catch (error) {
      signal.throwIfAborted();
      const reason =
        error instanceof Error ? error.message : 'Verifold could not read it.';
      if (error instanceof GitHubLimitError) stopped = reason;
      shown.push({ repo, commit: null, problem: reason });
    }
  }
  const at = new Date().toISOString();
  const empty = (picker: HarnessName | null = null): SkillSearch => ({
    at,
    catalogs: shown,
    picker,
    cards: [],
  });
  // An added skill whose folder changed since.
  const updates = (input.added ?? []).flatMap((entry) => {
    for (const { read } of reads) {
      const latest = read.skills.find((skill) => skill.id === entry.id);
      if (latest)
        return latest.tree === entry.tree ? [] : [{ skill: latest, read }];
    }
    return [];
  });
  const profile = words(input.profile);
  if ((!profile.size && !updates.length) || !reads.length) return empty();
  const order = (skill: CatalogSkill): number =>
    catalogs.findIndex(
      (catalog) => catalog.owner === skill.owner && catalog.repo === skill.repo,
    );
  const offered = reads.flatMap(({ catalog, read }) =>
    read.skills
      .filter((skill) => treeRefusal(skill.name, skill.files) === null)
      .map((skill) => ({
        skill,
        read,
        score: 2 * matches(profile, skill.path.slice(catalog.root.length)),
      })),
  );
  const byScore = (
    a: { readonly skill: CatalogSkill; readonly score: number },
    b: { readonly skill: CatalogSkill; readonly score: number },
  ): number => b.score - a.score || order(a.skill) - order(b.skill);
  const reading = profile.size
    ? offered.sort(byScore).slice(0, limits.reads)
    : [];
  await readMeta([...updates, ...reading], hosts, signal);
  const scored = reading
    .map((item) => {
      const meta = item.read.meta[item.skill.id];
      return {
        ...item,
        meta,
        score:
          item.score +
          (meta
            ? 2 * matches(profile, meta.name ?? '') +
              matches(profile, meta.description)
            : 0),
      };
    })
    .filter(
      (item): item is typeof item & { meta: SkillMeta } =>
        item.meta !== undefined &&
        Boolean(item.meta.description) &&
        item.score > 0,
    )
    .sort(byScore)
    .slice(0, limits.pool);
  const picks =
    input.picker && scored.length
      ? await pick(
          input.picker,
          input.profile,
          scored,
          signal,
          input.run ?? runHarness,
        )
      : null;
  // The harness's picks, or else the best matches, until three pass the check of their files.
  const chosen = picks
    ? picks.flatMap((entry) => {
        const item = scored.find(({ skill }) => skill.id === entry.id);
        return item
          ? [{ ...item, what: entry.what || cut(item.meta.description) }]
          : [];
      })
    : scored.map((item) => ({ ...item, what: cut(item.meta.description) }));
  const cards: SkillCard[] = [];
  const shownIds = new Set<string>();
  let downloads = 0;
  let fresh = 0;
  for (const item of [
    ...updates.map(({ skill, read }) => {
      const meta = read.meta[skill.id];
      return { skill, read, meta, what: cut(meta?.description || skill.name) };
    }),
    ...chosen,
  ]) {
    signal.throwIfAborted();
    if (shownIds.has(item.skill.id)) continue;
    // Updates always show. New skills stop at three cards, or after eight downloads.
    const update = updates.some(({ skill }) => skill.id === item.skill.id);
    if (!update && (fresh >= limits.cards || downloads >= limits.downloads))
      break;
    if (!update) downloads++;
    let contents: Map<string, Buffer>;
    try {
      contents = await downloadSkill(item.skill, hosts, signal);
    } catch {
      signal.throwIfAborted();
      continue;
    }
    if (
      treeRefusal(item.skill.name, item.skill.files) !== null ||
      contentRefusal(item.skill.files, contents) !== null
    )
      continue;
    shownIds.add(item.skill.id);
    if (!update) fresh++;
    cards.push({
      skill: item.skill,
      what: item.what,
      license: await licenseOf(
        item.skill,
        item.meta,
        contents,
        item.read,
        hosts,
        signal,
      ),
      updated: await folderDate(item.skill, item.read, hosts, signal),
      runs: whatItRuns(item.skill.files, contents),
    });
  }
  // What Verifold read stays with each catalog's commit. Only a copy that changed is written.
  for (const { catalog, read, before } of reads)
    if (JSON.stringify(read) !== before)
      await saveRead(root, catalog, read).catch(() => {});
  return { ...empty(picks ? (input.picker?.host ?? null) : null), cards };
}

/** The skills that the person added, from `skills.json`. */
export async function loadSkills(directory: string): Promise<AddedSkill[]> {
  let text: string;
  try {
    text = await readMemory(join(directory, 'skills.json'), 256 * 1024);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return [];
    throw error;
  }
  const value = JSON.parse(text) as unknown;
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.added)
  )
    throw new Error('The list of added skills is not valid.');
  return value.added.map((entry: unknown): AddedSkill => {
    if (
      !record(entry) ||
      typeof entry.id !== 'string' ||
      !hex16.test(entry.id) ||
      !validSkillName(entry.name) ||
      typeof entry.repo !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.repo) ||
      typeof entry.commit !== 'string' ||
      !hex40.test(entry.commit) ||
      !safeRelativePath(entry.path) ||
      typeof entry.tree !== 'string' ||
      !hex40.test(entry.tree) ||
      typeof entry.addedAt !== 'string'
    )
      throw new Error('The list of added skills is not valid.');
    return {
      id: entry.id,
      name: entry.name,
      repo: entry.repo,
      commit: entry.commit,
      path: entry.path,
      tree: entry.tree,
      license: typeof entry.license === 'string' ? entry.license : null,
      addedAt: entry.addedAt,
    };
  });
}

/**
 * Where an added skill's files are. The skill's ID names the folder, so no
 * stored skill sits inside another, whatever their folders in the catalog.
 */
function storePath(root: string, skill: AddedSkill): string {
  return join(root, ...skill.repo.split('/'), skill.commit, skill.id);
}

/** Make a folder read-only: its files 0444, or 0555 when they run, and its folders 0555. */
async function lockDown(folder: string): Promise<void> {
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries)
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      const mode = (await lstat(path)).mode & 0o111 ? 0o555 : 0o444;
      await chmod(path, mode);
    }
  // The deepest folders first, so each parent can still be read meanwhile.
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort((a, b) => b.length - a.length);
  for (const path of [...folders, folder]) await chmod(path, 0o555);
}

/** Remove a read-only folder that Verifold made. A missing folder is fine. */
async function removeTree(folder: string): Promise<void> {
  if (!(await isFolder(folder))) return;
  await chmod(folder, 0o700);
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  });
  for (const entry of entries)
    if (entry.isDirectory())
      await chmod(join(entry.parentPath, entry.name), 0o700);
  await rm(folder, { recursive: true, force: true });
}

/** Write a skill's files into a new folder. Links are never written. */
async function writeSkill(
  folder: string,
  skill: CatalogSkill,
  contents: ReadonlyMap<string, Buffer>,
): Promise<void> {
  for (const file of skill.files) {
    const target = join(folder, ...file.path.split('/'));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const content =
      contents.get(file.path) ?? fail('A file of the skill is missing.');
    await writeFile(
      target,
      // Every SKILL.md, a nested one too, loses its allowed-tools in the copy.
      posix.basename(file.path) === 'SKILL.md'
        ? withoutAllowedTools(content.toString('utf8'))
        : content,
      { mode: file.mode === '100755' ? 0o755 : 0o644, flag: 'wx' },
    );
  }
}

/**
 * Move a finished folder into place, then make it read-only: a read-only
 * folder cannot move to another parent. When another Verifold put the same
 * folder there first, that one stays.
 */
async function settle(temporary: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await rename(temporary, target);
  } catch (error) {
    if (!(await isFolder(target))) throw error;
  }
  await lockDown(target);
}

/**
 * Add a skill of the last search: download its files at the commit, check
 * each one, keep them read-only in the profile folder, and record the skill.
 * `locked` runs the change of `skills.json` under the profile's lock. A
 * newer version replaces the older one.
 */
export async function addSkill(input: {
  readonly directory: string;
  readonly skill: CatalogSkill;
  readonly license: string | null;
  readonly signal: AbortSignal;
  readonly hosts?: GitHubHosts;
  readonly locked: <T>(work: () => Promise<T>) => Promise<T>;
}): Promise<AddedSkill> {
  const { skill, signal } = input;
  const hosts = input.hosts ?? githubHosts;
  const before = await loadSkills(input.directory);
  if (
    before.some((entry) => entry.name === skill.name && entry.id !== skill.id)
  )
    fail(`You added another skill named ${skill.name}. Remove it first.`);
  const refused = treeRefusal(skill.name, skill.files);
  if (refused) fail(`Verifold does not add ${skill.name}. ${refused}`);
  const contents = await downloadSkill(skill, hosts, signal);
  const reason = contentRefusal(skill.files, contents);
  if (reason) fail(`Verifold does not add ${skill.name}. ${reason}`);
  const root = await skillsRoot(input.directory);
  const added: AddedSkill = {
    id: skill.id,
    name: skill.name,
    repo: `${skill.owner}/${skill.repo}`,
    commit: skill.commit,
    path: skill.path,
    tree: skill.tree,
    license: input.license,
    addedAt: new Date().toISOString(),
  };
  const target = storePath(root, added);
  if (!(await isFolder(target))) {
    const temporary = join(root, `.tmp-${randomUUID()}`);
    try {
      await writeSkill(temporary, skill, contents);
      await settle(temporary, target);
    } finally {
      await removeTree(temporary);
    }
  }
  let older: AddedSkill | null;
  try {
    older = await input.locked(async () => {
      // The check and the write hold one lock, so two adds cannot both pass it.
      const list = await loadSkills(input.directory);
      if (
        list.some((entry) => entry.name === skill.name && entry.id !== skill.id)
      )
        fail(`You added another skill named ${skill.name}. Remove it first.`);
      const old = list.find((entry) => entry.id === skill.id);
      await saveSkills(input.directory, [
        ...list.filter((entry) => entry.id !== skill.id),
        added,
      ]);
      return old && old.commit !== added.commit ? old : null;
    });
  } catch (error) {
    // No record names these files, so they go.
    if (
      !before.some(
        (entry) => entry.id === skill.id && entry.commit === skill.commit,
      )
    )
      await removeTree(target).catch(() => {});
    throw error;
  }
  if (older) await removeTree(storePath(root, older)).catch(() => {});
  return added;
}

/** Remove an added skill: its record, then its files. */
export async function removeSkill(input: {
  readonly directory: string;
  readonly id: string;
  readonly locked: <T>(work: () => Promise<T>) => Promise<T>;
}): Promise<void> {
  const removed = await input.locked(async () => {
    const list = await loadSkills(input.directory);
    const entry =
      list.find((item) => item.id === input.id) ??
      fail('That skill is not added.');
    await saveSkills(
      input.directory,
      list.filter((item) => item.id !== input.id),
    );
    return entry;
  });
  await removeTree(storePath(await skillsRoot(input.directory), removed)).catch(
    () => {},
  );
}

function saveSkills(
  directory: string,
  list: readonly AddedSkill[],
): Promise<void> {
  return saveAgencyFile(
    directory,
    'skills.json',
    `${JSON.stringify({ schemaVersion: 1, added: list }, null, 2)}\n`,
  );
}

/** Copy an added skill's folder. The copy's modes follow its files. */
async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target);
    else if (entry.isFile()) await copyFile(source, target);
  }
}

/** Where sessions find the copies of the added skills: outside the profile folder, which lab sessions must not read. */
export function pluginsHome(): string {
  return join(homedir(), '.verifold', 'plugins');
}

/**
 * The plugin folder of the added skills under `plugins`, or null without
 * any: a `.claude-plugin/plugin.json` and a `skills/<name>/` copy of each
 * skill, read-only. Its name is a hash of the skills, so each set of skills
 * has one folder, which every session with that set shares. The copy holds
 * whole files, so a session never reads the profile folder.
 */
export async function skillPlugin(
  directory: string,
  plugins: string,
): Promise<string | null> {
  const list = await loadSkills(directory);
  if (!list.length) return null;
  const twice = list.find((skill, at) =>
    list.slice(at + 1).some((other) => other.name === skill.name),
  );
  if (twice)
    throw new Error(
      `Two added skills are named ${twice.name}. Remove one of them in the first run.`,
    );
  const root = await skillsRoot(directory);
  await mkdir(plugins, { recursive: true, mode: 0o700 });
  if (!(await lstat(plugins)).isDirectory())
    throw new Error('The plugins folder must be a folder, not a link.');
  const hash = createHash('sha256')
    .update(
      JSON.stringify(
        list
          .map((skill) => [skill.id, skill.commit, skill.tree, skill.name])
          .sort(),
      ),
    )
    .digest('hex')
    .slice(0, 16);
  const target = join(plugins, hash);
  if (!(await isFolder(target))) {
    const temporary = join(plugins, `.tmp-${randomUUID()}`);
    try {
      await mkdir(join(temporary, '.claude-plugin'), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(temporary, '.claude-plugin', 'plugin.json'),
        `${JSON.stringify({
          name: 'verifold-skills',
          description: 'The skills that the person added in Verifold.',
        })}\n`,
        { mode: 0o644, flag: 'wx' },
      );
      for (const skill of list)
        await copyTree(
          storePath(root, skill),
          join(temporary, 'skills', skill.name),
        );
      await settle(temporary, target);
    } finally {
      await removeTree(temporary);
    }
  }
  // Each use marks the set as used, so a set that a long session still reads is not pruned.
  const now = new Date();
  await utimes(target, now, now).catch(() => {});
  await prune(plugins, hash).catch(() => {});
  return target;
}

/**
 * Remove the sets that no session used for a week, and unfinished ones after
 * an hour. Each launch and each turn of a session marks its set as used.
 */
async function prune(plugins: string, keep: string): Promise<void> {
  const now = Date.now();
  for (const name of await readdir(plugins)) {
    if (name === keep) continue;
    const path = join(plugins, name);
    const age = now - (await lstat(path)).mtimeMs;
    if (age > (name.startsWith('.tmp-') ? 3_600_000 : 7 * 86_400_000))
      await removeTree(path);
  }
}

/**
 * The added skills for the sessions of a project's owner, and the person's
 * own skills that agents do not load. A harness that could not load the
 * added skills gets no more of them while this process runs, and `report`
 * gets each reason once it takes it.
 */
export function skillLoader(
  directory: string,
  plugins: string,
  /** Tell the person. False: nothing could take the text yet, so it comes again later. */
  report: (text: string) => boolean,
): SessionSkills {
  const blocked = new Set<HarnessName>();
  const told = new Set<string>();
  const tell = (text: string): void => {
    if (!told.has(text) && report(text)) told.add(text);
  };
  return {
    folder: async (host) => {
      if (blocked.has(host)) return null;
      try {
        return await skillPlugin(directory, plugins);
      } catch (error) {
        tell(
          `Verifold could not prepare the added skills, so agents run without them: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        return null;
      }
    },
    problem: (host, text) => {
      blocked.add(host);
      tell(text);
    },
    // A turn marks its set as used, so pruning never takes a set that a live session reads.
    used: (folder) => {
      const now = new Date();
      void utimes(folder, now, now).catch(() => {});
    },
    off: async (host) => {
      const file = ownChoicesFile(directory);
      const choices = await loadOwnChoices(directory).catch(() => null);
      if (!choices) {
        tell(
          `Verifold could not read ${file}, so agents load all your skills.`,
        );
        return [];
      }
      if (choices.skipped)
        tell(
          `Verifold skipped ${choices.skipped} ${choices.skipped === 1 ? 'entry' : 'entries'} of ${file} that it could not read. Agents load those skills.`,
        );
      return skillsOff(choices, host);
    },
  };
}
