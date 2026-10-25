import { opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ownLimits, type ProfileCard } from './agency.ts';
import { runHarness, type HarnessName } from './harness.ts';
import type { OwnSkill } from './own-skills.ts';
import { replyCard, type ChatHarness } from './profile-chat.ts';
import { loadPrompt } from './prompts.ts';
import { parseHostJson } from './research-contracts.ts';
import { SessionActionError, hostName } from './session.ts';
import { credentialPaths } from './session-hosts.ts';
import { inEmptyFolder } from './storage.ts';

/**
 * "Get information about me from my harnesses": each harness that the
 * person uses tells what it knows about them, from its own instructions and
 * memories, and which of their skills fit their research. Nothing is saved
 * here. The person accepts or discards the result.
 */
export interface ImportedSkill {
  readonly harness: HarnessName;
  readonly id: string;
  readonly name: string;
  readonly fits: boolean;
  /** When an agent should use the skill. Empty when it does not fit. */
  readonly when: string;
}

export interface ProfileImport {
  /** The harnesses that answered, the lead first. */
  readonly from: readonly HarnessName[];
  /** The draft card. A part that no harness knew is empty. */
  readonly card: ProfileCard;
  /** The skills that each answer named. A skill that it left out has no opinion. */
  readonly skills: readonly ImportedSkill[];
  /** What each harness says that it read, one line each. */
  readonly read: readonly string[];
  /** Why a harness did not answer, or why the drafts were not merged. */
  readonly problems: readonly string[];
}

const limits = {
  /** The memory folders of Claude Code's projects that the prompt names, the newest first. */
  memoryFolders: 40,
  /** Files that the prompt names in a memory folder without MEMORY.md. */
  memoryFiles: 5,
  /** Entries of a folder that Verifold looks at. */
  entries: 2000,
  /** Characters of a skill's description in the prompt. */
  description: 300,
  /** Characters of the line on what a harness read. */
  read: 200,
  timeoutMs: 300_000,
  idleMs: 120_000,
} as const;

const empty: ProfileCard = { workOn: '', explore: '', talk: '' };

/** What Claude Code keeps beside its memory, which the import never reads. */
const claudePrivate = [
  'projects/**/*.jsonl',
  'history.jsonl',
  '.credentials.json',
  'settings*.json',
  'file-history',
  'paste-cache',
  'shell-snapshots',
  'session-env',
  'todos',
  'debug',
  'telemetry',
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new SessionActionError(message);
}

/** The entries of a folder, at most `limits.entries`. None when it cannot be read. */
async function entries(
  folder: string,
  signal: AbortSignal,
): Promise<{ readonly name: string; readonly folder: boolean }[]> {
  const dir = await opendir(folder).catch(() => null);
  if (!dir) return [];
  const found: { name: string; folder: boolean }[] = [];
  try {
    for await (const entry of dir) {
      signal.throwIfAborted();
      if (found.length >= limits.entries) break;
      found.push({ name: entry.name, folder: entry.isDirectory() });
    }
  } finally {
    // A loop that ends early leaves the folder open.
    await dir.close().catch(() => {});
  }
  return found;
}

async function mtime(path: string): Promise<number> {
  return (await stat(path).catch(() => null))?.mtimeMs ?? 0;
}

/**
 * Claude Code's settings folder, as an absolute path that a permission rule
 * can hold. A rule reads `*`, `?`, `[`, `]`, `{`, `}` and parentheses in it
 * as syntax, so such a path is refused.
 */
export function claudeFolder(config: string): string {
  const path = resolve(config);
  if (
    [...path].some((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 || code === 0x7f || '*?[]{}()'.includes(char);
    })
  )
    fail(
      'Verifold did not ask Claude Code: the path of its settings folder holds a character that a permission rule cannot hold, such as * or (.',
    );
  return path;
}

/**
 * What Claude Code may read: its CLAUDE.md and the memory folders of its
 * projects, never the session transcripts and settings beside them. `files`
 * names where to start: CLAUDE.md, then for each memory folder, the newest
 * first, its MEMORY.md, else up to five of its notes.
 */
export async function claudeMemory(
  config: string,
  signal: AbortSignal,
): Promise<{
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly files: readonly string[];
}> {
  const projects = join(config, 'projects');
  const found: { readonly path: string; readonly at: number }[] = [];
  for (const entry of await entries(projects, signal)) {
    if (!entry.folder) continue;
    const memory = join(projects, entry.name, 'memory');
    if (!(await stat(memory).catch(() => null))?.isDirectory()) continue;
    // A note changes MEMORY.md, which the folder's own time does not show.
    found.push({
      path: memory,
      at: Math.max(await mtime(memory), await mtime(join(memory, 'MEMORY.md'))),
    });
  }
  const newest = found
    .sort((a, b) => b.at - a.at)
    .slice(0, limits.memoryFolders);
  const starts = await Promise.all(
    newest.map(async ({ path }) => {
      const index = join(path, 'MEMORY.md');
      if ((await stat(index).catch(() => null))?.isFile()) return [index];
      return (await entries(path, signal))
        .filter((entry) => !entry.folder && entry.name.endsWith('.md'))
        .slice(0, limits.memoryFiles)
        .map((entry) => join(path, entry.name));
    }),
  );
  const instructions = join(config, 'CLAUDE.md');
  return {
    allow: [instructions, join(projects, '*', 'memory', '**')],
    deny: [
      ...claudePrivate.map((path) => join(config, path)),
      ...credentialPaths,
    ],
    files: [
      ...((await stat(instructions).catch(() => null))?.isFile()
        ? [instructions]
        : []),
      ...starts.flat(),
    ],
  };
}

/** What Codex's commands may not read: the person's home folder, Codex's own folder, and the credential paths. */
function codexClosed(): string[] {
  const home = homedir();
  const codex = resolve(process.env.CODEX_HOME ?? join(home, '.codex'));
  return [
    home,
    ...(codex.startsWith(`${home}/`) ? [] : [codex]),
    ...credentialPaths,
  ];
}

/** One harness's answer, checked: the card, its view of each listed skill that it named, and what it read. */
function answerOf(
  text: string,
  host: HarnessName,
  listed: readonly OwnSkill[],
): {
  readonly card: ProfileCard | null;
  readonly skills: ImportedSkill[];
  readonly read: string;
} {
  let value: unknown;
  try {
    value = parseHostJson(text);
  } catch {
    value = null;
  }
  if (!record(value))
    fail(`${hostName(host)} did not send an answer that Verifold can read.`);
  const byId = new Map(listed.map((skill) => [skill.id, skill]));
  const skills = new Map<string, ImportedSkill>();
  for (const entry of Array.isArray(value.skills) ? value.skills : []) {
    if (!record(entry) || typeof entry.id !== 'string') continue;
    const skill = byId.get(entry.id);
    if (!skill || skills.has(skill.id)) continue;
    const fits = entry.fits === true;
    skills.set(skill.id, {
      harness: host,
      id: skill.id,
      name: skill.name,
      fits,
      when:
        fits && typeof entry.when === 'string'
          ? entry.when.trim().slice(0, ownLimits.when)
          : '',
    });
  }
  return {
    card: replyCard(value.card),
    skills: [...skills.values()],
    read:
      typeof value.read === 'string'
        ? value.read.trim().slice(0, limits.read)
        : '',
  };
}

/** A reason that the person can read: Verifold's own, or the error's first 300 characters. */
function reason(error: unknown): string {
  if (error instanceof SessionActionError) return error.message;
  return error instanceof Error
    ? error.message.slice(0, 300)
    : 'It did not say why.';
}

/**
 * Ask each harness, at the same time, what it knows about the person. A
 * harness that fails does not hold up the others. Two cards are merged by
 * `merger`, the harness of the "About you" conversation, else the first
 * card stays. Fails only when no harness answers.
 */
export async function importProfile(input: {
  /** The harnesses that the person uses, the lead first, with their models. */
  readonly harnesses: readonly ChatHarness[];
  readonly merger: ChatHarness | null;
  /** The person's own skills, as the Skills step lists them. */
  readonly skills: readonly OwnSkill[];
  /** Claude Code's settings folder. Tests use a fake one. */
  readonly claudeConfig?: string;
  readonly signal: AbortSignal;
  readonly run?: typeof runHarness;
}): Promise<ProfileImport> {
  const { signal } = input;
  const run = input.run ?? runHarness;
  const instructions = await loadPrompt('profile-import');
  const answers = await Promise.allSettled(
    input.harnesses.map(async (harness) => {
      const listed = input.skills.filter(
        (skill) => skill.harness === harness.host,
      );
      const memory =
        harness.host === 'claude'
          ? await claudeMemory(
              claudeFolder(
                input.claudeConfig ??
                  process.env.CLAUDE_CONFIG_DIR ??
                  join(homedir(), '.claude'),
              ),
              signal,
            )
          : null;
      const result = await inEmptyFolder('import', (cwd) =>
        run({
          host: harness.host,
          ...(harness.model ? { model: harness.model } : {}),
          cwd,
          signal,
          timeoutMs: limits.timeoutMs,
          idleMs: limits.idleMs,
          ownFiles: memory
            ? { allow: memory.allow, deny: memory.deny }
            : { allow: [], deny: codexClosed() },
          // Skill descriptions come from plugins and catalogs.
          outsideText: true,
          prompt: `${instructions}

The input, as JSON:
${JSON.stringify({
  skills: listed.map(({ id, name, description }) => ({
    id,
    name,
    description: description.slice(0, limits.description),
  })),
  ...(memory?.files.length ? { files: memory.files } : {}),
})}`,
        }),
      );
      return {
        host: harness.host,
        ...answerOf(result.text, harness.host, listed),
      };
    }),
  );
  signal.throwIfAborted();
  const problems: string[] = [];
  const done = answers.flatMap((answer, index) => {
    if (answer.status === 'fulfilled') return [answer.value];
    const host = input.harnesses[index]?.host ?? 'claude';
    problems.push(`${hostName(host)} did not answer: ${reason(answer.reason)}`);
    return [];
  });
  if (!done.length)
    fail(problems.join(' ') || 'No agent is signed in to answer.');
  const cards = done.flatMap((answer) => (answer.card ? [answer.card] : []));
  let card = cards[0] ?? empty;
  if (cards.length > 1 && input.merger) {
    const merger = input.merger;
    try {
      const prompt = `${await loadPrompt('profile-merge')}

The input, as JSON:
${JSON.stringify({ drafts: cards })}`;
      const result = await inEmptyFolder('import', (cwd) =>
        run({
          host: merger.host,
          ...(merger.model ? { model: merger.model } : {}),
          cwd,
          signal,
          timeoutMs: 180_000,
          idleMs: limits.idleMs,
          textOnly: true,
          // The drafts hold what the harnesses read.
          outsideText: true,
          prompt,
        }),
      );
      const value = parseHostJson(result.text);
      card =
        (record(value) ? replyCard(value.card) : null) ??
        fail(`${hostName(merger.host)} did not send a card.`);
    } catch (error) {
      signal.throwIfAborted();
      problems.push(
        `Verifold could not merge the two drafts, so the card is ${hostName(done[0]?.host ?? merger.host)}'s draft: ${reason(error)}`,
      );
    }
  }
  return {
    from: done.map((answer) => answer.host),
    card,
    skills: done.flatMap((answer) => answer.skills),
    read: done.map(
      (answer) =>
        `${hostName(answer.host)}: ${answer.read || 'It did not say what it read.'}`,
    ),
    problems,
  };
}
