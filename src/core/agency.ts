import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { validateModel, type HarnessName } from './harness.ts';
import { object, text } from './research-contracts.ts';
import { parseProfileMoney, type ProfileMoney } from './compute.ts';
import { SessionActionError } from './session.ts';
import {
  homeShown,
  missing,
  readBounded,
  writePrivateFile,
} from './storage.ts';

/**
 * The person's global profile lives in `~/.verifold/agency/`:
 * - `settings.json`: the agents, the GPU limits for new projects, and which
 *   first-run steps the person finished or skipped;
 * - `USER.md`: the profile that the person approved;
 * - `profile-state.json`: how the last profile setup in the terminal ended;
 * - `skills.json` and `skills/`: the skills that the person added (see skills.ts);
 * - `own-skills.json`: the person's choices for the skills that their own
 *   Claude Code and Codex load (see own-skills.ts).
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

/** The text of the profile folder's marker, without its line end. */
const markerText = 'Verifold agency v1';

/** Create only Verifold-owned private storage. Refuse redirected directories. */
export async function prepareAgency(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error(
      'Agency directory must be a directory, not a symbolic link.',
    );
  const marker = join(directory, '.verifold-agency');
  // EEXIST: another call made the marker at the same moment, so it is checked like an existing one.
  const owner =
    (await readdir(directory)).length > 0
      ? null
      : await open(marker, 'wx', 0o600).catch((error: unknown) => {
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'EEXIST'
          )
            return null;
          throw error;
        });
  if (owner)
    try {
      await owner.writeFile(`${markerText}\n`);
    } finally {
      await owner.close();
    }
  else await checkMarker(marker);
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

/** Refuse a folder whose marker is not Verifold's. */
async function checkMarker(marker: string): Promise<void> {
  try {
    // A start of the text, or none, is a marker that another call made and still writes.
    if (!markerText.startsWith((await readFileText(marker, 100)).trim()))
      throw new Error('Invalid marker.');
  } catch {
    throw new Error(
      'Choose an empty agency directory or an existing Verifold agency.',
    );
  }
}

/** Read a selected text file without following a final symlink or blocking on a pipe. */
export async function readMemory(path: string, limit = 12000): Promise<string> {
  return text(await readFileText(path, limit), 'research memory', limit);
}

/** A regular file's text, which can be empty. A final symlink is not followed, and a pipe does not block. */
async function readFileText(path: string, limit: number): Promise<string> {
  const content = await readBounded(path, limit);
  if (content === null)
    throw new Error(
      `Memory must be a regular text file of at most ${limit} bytes.`,
    );
  if (content.includes('\0'))
    throw new Error('Memory must contain bounded plain text.');
  return content;
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
  name:
    | 'settings.json'
    | 'USER.md'
    | 'profile-state.json'
    | 'skills.json'
    | 'own-skills.json',
  content: string,
): Promise<void> {
  await prepareAgency(directory);
  await writePrivateFile(join(directory, name), content, { sync: true });
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

/** The person's choice for one of the skills that their own harness loads. */
export interface OwnChoice {
  /** The skill's name, as its harness lists it. */
  readonly name: string;
  /** Verifold's agents load the skill. */
  readonly use: boolean;
  /** When and how agents should use it, in the person's words. Empty: no note. */
  readonly when: string;
  /** What turns the skill off in its harness: its names for Claude Code, its SKILL.md path for Codex. Empty while it loads. */
  readonly off: readonly string[];
}

/** A change of one choice. Without `when`, the note stays as it is. `name` and `off` come from the list of the person's skills. */
export interface OwnChange {
  readonly harness: HarnessName;
  readonly id: string;
  readonly name: string;
  readonly use: boolean;
  readonly when?: string;
  readonly off: readonly string[];
}

/**
 * The choices by harness, keyed by each skill's ID: its name for Claude
 * Code, whose rules cover every skill of a name, and its SKILL.md path for
 * Codex, whose rules name one file. A skill without a choice loads, with no
 * note.
 */
export interface OwnChoices {
  readonly claude: ReadonlyMap<string, OwnChoice>;
  readonly codex: ReadonlyMap<string, OwnChoice>;
  /** Entries of the file that Verifold could not read, and so left out. */
  readonly skipped: number;
}

/**
 * A skill's name as Claude Code or Codex lists it, such as `python` or
 * `vercel:nextjs`. It goes as it is into a permission rule.
 */
export const ownSkillName = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** The most characters of a note on when to use a skill, choices in the file, bytes of the file, and characters of a path. */
export const ownLimits = {
  when: 300,
  choices: 600,
  bytes: 1024 * 1024,
  path: 1024,
} as const;

/**
 * A skill's ID, which is also what turns it off: a skill name for Claude
 * Code, an absolute SKILL.md path for Codex. A path holds no control
 * character, which a TOML string cannot hold.
 */
export function offTarget(host: HarnessName, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (host === 'claude') return ownSkillName.test(value);
  return (
    value.startsWith('/') &&
    value.endsWith('/SKILL.md') &&
    value.length <= ownLimits.path &&
    ![...value].some((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  );
}

const ownFile = 'own-skills.json';

/** The file of the choices, as the person reads its path. */
export function ownChoicesFile(directory: string): string {
  return homeShown(join(directory, ownFile));
}

/**
 * `own-skills.json`. A missing file holds no choices. An entry that is not
 * valid is left out and counted. A file that cannot be read at all throws.
 */
export async function loadOwnChoices(directory: string): Promise<OwnChoices> {
  let content: string;
  try {
    content = await readMemory(join(directory, ownFile), ownLimits.bytes);
  } catch (error) {
    if (missing(error))
      return { claude: new Map(), codex: new Map(), skipped: 0 };
    throw error;
  }
  const data: unknown = JSON.parse(content);
  if (!record(data) || data.schemaVersion !== 1 || !record(data.skills))
    throw new Error(`${ownChoicesFile(directory)} is not valid.`);
  const skills = data.skills;
  let skipped = 0;
  const side = (host: HarnessName): Map<string, OwnChoice> => {
    const entries = Object.hasOwn(skills, host) ? skills[host] : {};
    const found = new Map<string, OwnChoice>();
    if (!record(entries)) {
      skipped += 1;
      return found;
    }
    for (const [id, value] of Object.entries(entries)) {
      const off: unknown = record(value) ? (value.off ?? []) : null;
      const name: unknown = record(value) ? (value.name ?? id) : null;
      if (
        found.size >= ownLimits.choices ||
        !offTarget(host, id) ||
        !ownSkillName.test(String(name)) ||
        !record(value) ||
        typeof value.use !== 'boolean' ||
        (value.when !== undefined &&
          (typeof value.when !== 'string' ||
            value.when.length > ownLimits.when)) ||
        !Array.isArray(off) ||
        off.length > 2 ||
        !off.every((target) => offTarget(host, target)) ||
        (!value.use && !off.length)
      ) {
        skipped += 1;
        continue;
      }
      found.set(id, {
        name: String(name),
        use: value.use,
        when: typeof value.when === 'string' ? value.when : '',
        off: value.use ? [] : off,
      });
    }
    return found;
  };
  return { claude: side('claude'), codex: side('codex'), skipped };
}

/**
 * Apply changes to `own-skills.json`. The caller holds the lock. A skill
 * that loads with no note needs no entry, so it has none. A change that
 * would pass the limits is refused before anything is written. A file that
 * cannot be read at all moves to `own-skills.json.bad`, and the changes
 * start a new one. Returns the moved file's path as the person reads it, or
 * null.
 */
export async function writeOwnChoices(
  directory: string,
  changes: readonly OwnChange[],
): Promise<string | null> {
  for (const change of changes)
    if (
      !offTarget(change.harness, change.id) ||
      (!change.use &&
        (!change.off.length ||
          !change.off.every((target) => offTarget(change.harness, target))))
    )
      throw new SessionActionError(
        `Verifold cannot turn off ${change.name}. Read the list again.`,
      );
  let moved: string | null = null;
  const current: OwnChoices = await loadOwnChoices(directory).catch(
    async (error: unknown): Promise<OwnChoices> => {
      const bad = join(directory, `${ownFile}.bad`);
      try {
        await rename(join(directory, ownFile), bad);
      } catch {
        throw new SessionActionError(
          `Verifold could not read or move ${ownChoicesFile(directory)}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
      moved = homeShown(bad);
      return { claude: new Map(), codex: new Map(), skipped: 0 };
    },
  );
  const next = {
    claude: new Map(current.claude),
    codex: new Map(current.codex),
  };
  for (const change of changes) {
    const side = next[change.harness];
    const when =
      change.when === undefined
        ? (side.get(change.id)?.when ?? '')
        : change.when.trim().slice(0, ownLimits.when);
    if (change.use && !when) side.delete(change.id);
    else
      side.set(change.id, {
        name: change.name,
        use: change.use,
        when,
        off: change.use ? [] : change.off,
      });
  }
  if (next.claude.size + next.codex.size > ownLimits.choices)
    throw new SessionActionError(
      `Verifold keeps choices for at most ${ownLimits.choices} skills. Say Yes with no note to some skills, then try again.`,
    );
  const entries = (side: ReadonlyMap<string, OwnChoice>) =>
    Object.fromEntries(
      [...side].map(([id, { name, use, when, off }]) => [
        id,
        {
          ...(name === id ? {} : { name }),
          use,
          ...(when ? { when } : {}),
          ...(off.length ? { off } : {}),
        },
      ]),
    );
  const content = JSON.stringify({
    schemaVersion: 1,
    skills: { claude: entries(next.claude), codex: entries(next.codex) },
  });
  if (Buffer.byteLength(content) > ownLimits.bytes)
    throw new SessionActionError(
      'The skill choices would be too large to keep. Remove some notes, then try again.',
    );
  await saveAgencyFile(directory, ownFile, content);
  return moved;
}

/** The inode, change time and size of a file of the profile folder, so a reader can tell when it changed. */
async function stamp(directory: string, name: string): Promise<string> {
  const info = await lstat(join(directory, name)).catch((error: unknown) => {
    if (missing(error)) return null;
    throw error;
  });
  return info ? `${info.ino}:${info.mtimeMs}:${info.size}` : 'none';
}

/**
 * A reader of the choices that reads the file again only when it changed.
 * Null: the file cannot be read at all.
 */
export function ownChoicesReader(
  directory: string,
): () => Promise<OwnChoices | null> {
  let last: { readonly key: string; readonly value: OwnChoices | null } | null =
    null;
  return async () => {
    const key = await stamp(directory, ownFile).catch(() => 'unread');
    if (last?.key === key && key !== 'unread') return last.value;
    const value = await loadOwnChoices(directory).catch(() => null);
    last = { key, value };
    return value;
  };
}

/** What turns off each skill of a harness that Verifold's agents do not load. */
export function skillsOff(
  choices: OwnChoices,
  host: HarnessName,
): readonly string[] {
  return [
    ...new Set(
      [...choices[host].values()].flatMap((choice) =>
        choice.use ? [] : choice.off,
      ),
    ),
  ];
}

/** The most characters of one harness's notes in a prompt. */
const notesLimit = 2000;

/** The notes on when to use the skills that load, one line each, for each harness that has any. */
function skillNotes(choices: OwnChoices): Partial<Record<HarnessName, string>> {
  const notes: Partial<Record<HarnessName, string>> = {};
  for (const host of ['claude', 'codex'] as const) {
    const lines = [...choices[host].values()]
      .filter((choice) => choice.use && choice.when)
      .map((choice) => `- ${choice.name}: ${choice.when}`);
    if (lines.length) notes[host] = lines.join('\n').slice(0, notesLimit);
  }
  return notes;
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
  /** The whole profile, for the planner of each project. Empty without a profile. */
  readonly whole: string;
  /** "Talk to me", for every agent. Null when the profile has none. */
  readonly style: string | null;
  /** The person's notes on when to use their own skills, for the agents of each harness. */
  readonly skills?: Partial<Record<HarnessName, string>>;
}

/** The most characters of the profile in the planner's prompt. */
const wholeLimit = 4000;

/**
 * The profile for the lab's prompts, or null without one. A card becomes
 * plain sentences about the person, so no heading reads as an order to the
 * agent. A free-form profile goes to the planner as it is, and has no style.
 * The notes on skills come with it. Choices that cannot be read add none.
 */
export async function personProfile(
  directory: string,
): Promise<PersonProfile | null> {
  const markdown = await loadMemory(directory);
  const notes = await loadOwnChoices(directory).then(skillNotes, () => ({}));
  const skills = Object.keys(notes).length ? { skills: notes } : {};
  const card = markdown ? parseCard(markdown) : null;
  const lines = card
    ? [
        card.workOn && `The person works on: ${card.workOn}`,
        card.explore && `They want the agents to explore: ${card.explore}`,
        card.talk && `How they want agents to write to them: ${card.talk}`,
      ].filter(Boolean)
    : [];
  if (markdown && !card)
    return {
      whole: markdown.trim().slice(0, wholeLimit),
      style: null,
      ...skills,
    };
  if (lines.length)
    return {
      whole: lines.join('\n').slice(0, wholeLimit),
      style: card?.talk || null,
      ...skills,
    };
  return 'skills' in skills ? { whole: '', style: null, ...skills } : null;
}

/**
 * A reader of the profile for the lab's prompts. It reads USER.md and the
 * skill choices again only when a file changed: its inode, its change time,
 * or its size.
 */
export function profileReader(
  directory: string,
): () => Promise<PersonProfile | null> {
  let last: {
    readonly key: string;
    readonly value: PersonProfile | null;
  } | null = null;
  return async () => {
    const key = `${await stamp(directory, 'USER.md')}/${await stamp(directory, ownFile)}`;
    if (last?.key === key) return last.value;
    const value = await personProfile(directory);
    last = { key, value };
    return value;
  };
}
