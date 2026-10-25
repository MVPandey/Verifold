import { mkdtemp, opendir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownLimits, type ProfileCard } from './agency.ts';
import { runHarness, type HarnessName } from './harness.ts';
import type { OwnSkill } from './own-skills.ts';
import { replyCard, type ChatHarness } from './profile-chat.ts';
import { loadPrompt } from './prompts.ts';
import { parseHostJson } from './research-contracts.ts';
import { SessionActionError, hostName } from './session.ts';

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
  /** Every listed skill of each harness that answered. A skill that its answer left out does not fit. */
  readonly skills: readonly ImportedSkill[];
  /** What each harness says that it read, one line each. */
  readonly read: readonly string[];
  /** Why a harness did not answer, or why the drafts were not merged. */
  readonly problems: readonly string[];
}

const limits = {
  /** The memory folders of Claude Code's projects that the prompt names, the newest first. */
  memoryFolders: 40,
  /** Entries of Claude Code's projects folder that Verifold looks at. */
  entries: 2000,
  /** Characters of a skill's description in the prompt. */
  description: 300,
  /** Characters of the line on what a harness read. */
  read: 200,
  timeoutMs: 300_000,
  idleMs: 120_000,
} as const;

const empty: ProfileCard = { workOn: '', explore: '', talk: '' };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What Claude Code may read: its CLAUDE.md and the memory folders of its
 * projects, never the session transcripts beside them. `files` names where
 * to start: CLAUDE.md, and each memory folder's MEMORY.md, else the folder.
 */
export async function claudeMemory(
  config: string,
  signal: AbortSignal,
): Promise<{
  readonly allow: readonly string[];
  readonly files: readonly string[];
}> {
  const projects = join(config, 'projects');
  const found: { readonly path: string; readonly at: number }[] = [];
  const dir = await opendir(projects).catch(() => null);
  if (dir) {
    let seen = 0;
    try {
      for await (const entry of dir) {
        signal.throwIfAborted();
        if (++seen > limits.entries) break;
        if (!entry.isDirectory()) continue;
        const memory = join(projects, entry.name, 'memory');
        const info = await stat(memory).catch(() => null);
        if (info?.isDirectory()) found.push({ path: memory, at: info.mtimeMs });
      }
    } finally {
      // A loop that ends early leaves the folder open.
      await dir.close().catch(() => {});
    }
  }
  const newest = found
    .sort((a, b) => b.at - a.at)
    .slice(0, limits.memoryFolders);
  const instructions = join(config, 'CLAUDE.md');
  const starts = await Promise.all(
    newest.map(async ({ path }) => {
      const index = join(path, 'MEMORY.md');
      return (await stat(index).catch(() => null))?.isFile() ? index : path;
    }),
  );
  return {
    allow: [instructions, join(projects, '*', 'memory', '**')],
    files: [
      ...((await stat(instructions).catch(() => null))?.isFile()
        ? [instructions]
        : []),
      ...starts,
    ],
  };
}

/** Run `work` in an empty private folder, which Verifold removes afterwards. */
async function inEmptyFolder<T>(work: (cwd: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), 'verifold-import-'));
  try {
    return await work(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** One harness's answer, checked: the card, a choice for each of its listed skills, and what it read. */
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
    throw new SessionActionError(
      `${hostName(host)} did not send an answer that Verifold can read.`,
    );
  const byId = new Map(listed.map((skill) => [skill.id, skill]));
  const answered = new Map<string, ImportedSkill>();
  for (const entry of Array.isArray(value.skills) ? value.skills : []) {
    if (!record(entry) || typeof entry.id !== 'string') continue;
    const skill = byId.get(entry.id);
    if (!skill || answered.has(skill.id)) continue;
    const fits = entry.fits === true;
    answered.set(skill.id, {
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
    skills: listed.map(
      (skill) =>
        answered.get(skill.id) ?? {
          harness: host,
          id: skill.id,
          name: skill.name,
          fits: false,
          when: '',
        },
    ),
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
  const config =
    input.claudeConfig ??
    process.env.CLAUDE_CONFIG_DIR ??
    join(homedir(), '.claude');
  const instructions = await loadPrompt('profile-import');
  const answers = await Promise.allSettled(
    input.harnesses.map(async (harness) => {
      const listed = input.skills.filter(
        (skill) => skill.harness === harness.host,
      );
      const memory =
        harness.host === 'claude' ? await claudeMemory(config, signal) : null;
      const result = await inEmptyFolder((cwd) =>
        run({
          host: harness.host,
          ...(harness.model ? { model: harness.model } : {}),
          cwd,
          signal,
          timeoutMs: limits.timeoutMs,
          idleMs: limits.idleMs,
          ownFiles: memory?.allow ?? [],
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
    throw new SessionActionError(
      problems.join(' ') || 'No agent is signed in to answer.',
    );
  const cards = done.flatMap((answer) => (answer.card ? [answer.card] : []));
  let card = cards[0] ?? empty;
  if (cards.length > 1 && input.merger) {
    const merger = input.merger;
    try {
      const prompt = `${await loadPrompt('profile-merge')}

The input, as JSON:
${JSON.stringify({ drafts: cards })}`;
      const result = await inEmptyFolder((cwd) =>
        run({
          host: merger.host,
          ...(merger.model ? { model: merger.model } : {}),
          cwd,
          signal,
          timeoutMs: 180_000,
          idleMs: limits.idleMs,
          textOnly: true,
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

function fail(message: string): never {
  throw new SessionActionError(message);
}
