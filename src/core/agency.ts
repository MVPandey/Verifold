import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateModel, type HarnessName } from './harness.ts';
import { object, text } from './research-contracts.ts';
import { parseProfileMoney, type ProfileMoney } from './compute.ts';
import { SessionActionError } from './session.ts';

/**
 * The person's global profile lives in `~/.verifold/agency/`:
 * - `settings.json`: the agents, the GPU limits for new projects, and which
 *   first-run steps the person finished or skipped;
 * - `USER.md`: the profile that the person approved;
 * - `profile-state.json`: how the last profile setup in the terminal ended;
 * - `skills.json` and `skills/`: the skills that the person added (see skills.ts).
 */
export interface Agency {
  readonly host: HarnessName;
  readonly model?: string;
  /** The second harness of the team, saved as the default for the next project. */
  readonly helper?: HarnessName;
  /** The helper's model. The first run saves it. */
  readonly helperModel?: string;
}

export interface ProfileState {
  readonly schemaVersion: 1;
  readonly status: 'accepted' | 'skipped' | 'failed';
}

/** The first run's steps. A step without a record was never offered. */
export type SetupStep = 'agents' | 'about' | 'skills' | 'money';
export type SetupSteps = Readonly<
  Partial<Record<SetupStep, 'done' | 'skipped'>>
>;

/**
 * `settings.json`. The agents keep the fields of older versions (`host`,
 * `model`, `helper`), so an older Verifold reads the same file. `money` and
 * `steps` came with the first run.
 */
export interface AgencySettings {
  /** Null: the person chose no agents yet. */
  readonly agency: Agency | null;
  /** Null: the person set no GPU limits yet, or the saved ones are not valid. */
  readonly money: ProfileMoney | null;
  /**
   * Saved GPU limits that are not valid, and why. They read as not set, and
   * the file keeps them until the person saves new ones.
   */
  readonly unreadMoney: {
    readonly saved: unknown;
    readonly reason: string;
  } | null;
  readonly steps: SetupSteps;
}

/** The profile card of the first run. Each field can be empty. */
export interface ProfileCard {
  readonly workOn: string;
  readonly explore: string;
  readonly talk: string;
}

/** The most characters of each field of the card. "Talk to me" goes into every agent's prompt, so it is short. */
export const cardLimits = { workOn: 600, explore: 1000, talk: 400 } as const;

const cardHeadings: Readonly<Record<keyof ProfileCard, string>> = {
  workOn: 'You work on',
  explore: 'To explore',
  talk: 'Talk to me',
};

export function agencyDirectory(cwd: string, path?: string): string {
  return resolve(cwd, path ?? join(homedir(), '.verifold', 'agency'));
}

/** Create only Verifold-owned private storage. Refuse redirected directories. */
export async function prepareAgency(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error(
      'Agency directory must be a directory, not a symbolic link.',
    );
  const marker = join(directory, '.verifold-agency');
  if ((await readdir(directory)).length > 0) {
    try {
      if ((await readMemory(marker, 100)) !== 'Verifold agency v1')
        throw new Error('Invalid marker.');
    } catch {
      throw new Error(
        'Choose an empty agency directory or an existing Verifold agency.',
      );
    }
  } else {
    const owner = await open(marker, 'wx', 0o600);
    try {
      await owner.writeFile('Verifold agency v1\n');
    } finally {
      await owner.close();
    }
  }
  const ignore = await open(
    join(directory, '.gitignore'),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    if (!(await ignore.stat()).isFile())
      throw new Error('Agency ignore file must be a regular file.');
    await ignore.writeFile('*\n');
  } finally {
    await ignore.close();
  }
}

/** Read a selected text file without following a final symlink or blocking on a pipe. */
export async function readMemory(path: string, limit = 12000): Promise<string> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error(
        `Memory must be a regular text file of at most ${limit} bytes.`,
      );
    const content = await file.readFile('utf8');
    if (content.includes('\0') || Buffer.byteLength(content) > limit)
      throw new Error('Memory must contain bounded plain text.');
    return text(content, 'research memory', limit);
  } finally {
    await file.close();
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function harness(value: unknown): HarnessName | undefined {
  return value === 'claude' || value === 'codex' ? value : undefined;
}

/** The agents, the GPU limits, and the steps, from `settings.json`. A missing file has none of them. */
export async function loadSettings(directory: string): Promise<AgencySettings> {
  let data: Record<string, unknown>;
  try {
    if (!(await lstat(directory)).isDirectory())
      throw new Error('Agency directory must not be a symbolic link.');
    data = object(
      JSON.parse(await readMemory(join(directory, 'settings.json'))),
    );
  } catch (error) {
    if (missing(error))
      return { agency: null, money: null, unreadMoney: null, steps: {} };
    throw error;
  }
  let agency: Agency | null = null;
  if (data.host !== undefined) {
    const host = harness(data.host);
    if (!host) throw new Error('Saved agency harness must be claude or codex.');
    validateModel(data.model);
    validateModel(data.helperModel);
    const helper = harness(data.helper);
    agency = {
      host,
      ...(data.model === undefined ? {} : { model: data.model }),
      ...(helper && helper !== host
        ? {
            helper,
            ...(data.helperModel === undefined
              ? {}
              : { helperModel: data.helperModel }),
          }
        : {}),
    };
  }
  // GPU limits that are not valid read as not set, so nothing that reads the settings stops on them.
  let money: ProfileMoney | null = null;
  let unreadMoney: AgencySettings['unreadMoney'] = null;
  if (data.money !== undefined)
    try {
      money = parseProfileMoney(object(data.money));
    } catch (error) {
      unreadMoney = {
        saved: data.money,
        reason: error instanceof Error ? error.message : 'They are not valid.',
      };
    }
  const steps: Partial<Record<SetupStep, 'done' | 'skipped'>> = {};
  const saved = record(data.steps) ? data.steps : {};
  for (const step of ['agents', 'about', 'skills', 'money'] as const)
    if (saved[step] === 'done' || saved[step] === 'skipped')
      steps[step] = saved[step];
  return { agency, money, unreadMoney, steps };
}

export async function loadAgency(
  directory: string,
): Promise<Agency | undefined> {
  return (await loadSettings(directory)).agency ?? undefined;
}

export async function loadMemory(
  directory: string,
): Promise<string | undefined> {
  try {
    if (!(await lstat(directory)).isDirectory())
      throw new Error('Agency directory must not be a symbolic link.');
    return await readMemory(join(directory, 'USER.md'));
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

export async function loadProfileState(
  directory: string,
): Promise<ProfileState | undefined> {
  try {
    if (!(await lstat(directory)).isDirectory())
      throw new Error('Agency directory must not be a symbolic link.');
    const data = object(
      JSON.parse(await readMemory(join(directory, 'profile-state.json'))),
    );
    if (
      data.schemaVersion !== 1 ||
      (data.status !== 'accepted' &&
        data.status !== 'skipped' &&
        data.status !== 'failed')
    )
      throw new Error(
        `Invalid profile setup state: ${join(directory, 'profile-state.json')}.`,
      );
    return { schemaVersion: 1, status: data.status };
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

/** Replace one owned file atomically. Existing symlink targets are never written. */
export async function saveAgencyFile(
  directory: string,
  name: 'settings.json' | 'USER.md' | 'profile-state.json' | 'skills.json',
  content: string,
): Promise<void> {
  await prepareAgency(directory);
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, name));
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Run `work` while this process holds the agency's lock. Another process
 * that holds it makes this fail with how to recover, and never waits.
 */
export async function withProfileLock<T>(
  directory: string,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  await prepareAgency(directory);
  signal.throwIfAborted();
  const lockPath = join(directory, 'profile.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new SessionActionError(
        `Agency settings are locked. Confirm no profile setup or initialization is running before removing ${lockPath}.`,
      );
    throw error;
  });
  try {
    await lock.writeFile(`${process.pid}\n`);
    await loadProfileState(directory);
    await loadMemory(directory);
    signal.throwIfAborted();
    return await work();
  } finally {
    try {
      await lock.close();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}

/**
 * Change `settings.json`. The caller holds the lock. Each part that the
 * change leaves as it is stays.
 */
export async function writeSettings(
  directory: string,
  change: (current: AgencySettings) => AgencySettings,
): Promise<AgencySettings> {
  const next = change(await loadSettings(directory));
  await saveAgencyFile(
    directory,
    'settings.json',
    JSON.stringify(
      {
        ...next.agency,
        // Limits that are not valid stay in the file until a save replaces them.
        ...(next.money
          ? { money: next.money }
          : next.unreadMoney
            ? { money: next.unreadMoney.saved }
            : {}),
        ...(Object.keys(next.steps).length ? { steps: next.steps } : {}),
      },
      null,
      2,
    ),
  );
  return next;
}

/** Preference updates share ownership with profile setup. The GPU limits and the steps stay. */
export async function saveAgencyPreferences(
  directory: string,
  agency: Agency,
  signal: AbortSignal,
): Promise<void> {
  await withProfileLock(directory, signal, () =>
    writeSettings(directory, (current) => ({ ...current, agency })),
  );
}

/**
 * A field's line that starts with `#`, after any backslashes, gets one more
 * backslash in USER.md, so no line of a field reads as a heading.
 * `unescapeLine` takes it off again.
 */
const escapeLine = (line: string): string =>
  /^\\*#/.test(line) ? `\\${line}` : line;
const unescapeLine = (line: string): string =>
  /^\\+#/.test(line) ? line.slice(1) : line;

/** The card as the Markdown of USER.md, one heading for each field. */
export function cardMarkdown(card: ProfileCard): string {
  return `${(Object.keys(cardHeadings) as (keyof ProfileCard)[])
    .map(
      (field) =>
        `## ${cardHeadings[field]}\n\n${card[field].trim().split('\n').map(escapeLine).join('\n')}\n`,
    )
    .join('\n')}`;
}

/**
 * The card in a USER.md, or null for a profile in free form, such as one
 * from `verifold profile --setup`. Text under other headings is not part
 * of the card.
 */
export function parseCard(markdown: string): ProfileCard | null {
  const fields: Partial<Record<keyof ProfileCard, string[]>> = {};
  let current: keyof ProfileCard | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading !== undefined) {
      current =
        (Object.keys(cardHeadings) as (keyof ProfileCard)[]).find(
          (field) =>
            cardHeadings[field].toLowerCase() === heading.toLowerCase(),
        ) ?? null;
      if (current) fields[current] = [];
    } else if (current) fields[current]?.push(unescapeLine(line));
  }
  if (!Object.keys(fields).length) return null;
  const field = (name: keyof ProfileCard): string =>
    (fields[name] ?? []).join('\n').trim().slice(0, cardLimits[name]);
  return {
    workOn: field('workOn'),
    explore: field('explore'),
    talk: field('talk'),
  };
}

/** What the lab's prompts take from the profile. */
export interface PersonProfile {
  /** The whole profile, for the planner of each project. */
  readonly whole: string;
  /** "Talk to me", for every agent. Null when the profile has none. */
  readonly style: string | null;
}

/** The most characters of the profile in the planner's prompt. */
const wholeLimit = 4000;

/**
 * The profile for the lab's prompts, or null without one. A card becomes
 * plain sentences about the person, so no heading reads as an order to the
 * agent. A free-form profile goes to the planner as it is, and has no style.
 */
export async function personProfile(
  directory: string,
): Promise<PersonProfile | null> {
  const markdown = await loadMemory(directory);
  if (!markdown) return null;
  const card = parseCard(markdown);
  if (!card)
    return { whole: markdown.trim().slice(0, wholeLimit), style: null };
  const lines = [
    card.workOn && `The person works on: ${card.workOn}`,
    card.explore && `They want the agents to explore: ${card.explore}`,
    card.talk && `How they want agents to write to them: ${card.talk}`,
  ].filter(Boolean);
  if (!lines.length) return null;
  return {
    whole: lines.join('\n').slice(0, wholeLimit),
    style: card.talk || null,
  };
}

/**
 * A reader of the profile for the lab's prompts. It reads USER.md again only
 * when the file changed: its inode, its change time, or its size.
 */
export function profileReader(
  directory: string,
): () => Promise<PersonProfile | null> {
  let last: {
    readonly key: string;
    readonly value: PersonProfile | null;
  } | null = null;
  return async () => {
    const info = await lstat(join(directory, 'USER.md')).catch(
      (error: unknown) => {
        if (missing(error)) return null;
        throw error;
      },
    );
    const key = info ? `${info.ino}:${info.mtimeMs}:${info.size}` : 'none';
    if (last?.key === key) return last.value;
    const value = await personProfile(directory);
    last = { key, value };
    return value;
  };
}
