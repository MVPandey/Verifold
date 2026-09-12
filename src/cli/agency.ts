import { loadPrompt } from './prompts.ts';
import { constants } from 'node:fs';
import {
  mkdir,
  open,
  lstat,
  rename,
  rm,
  mkdtemp,
  readdir,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { CliIO } from './commands.ts';
import { choose, withActivity } from './choices.ts';
import { runHarness, validateModel, type HarnessName } from './harness.ts';
import { object, text } from './research-contracts.ts';
import { researchInterview } from './onboarding.ts';
import { contextFiles } from './context-files.ts';

export interface Agency {
  readonly host: HarnessName;
  readonly model?: string;
}

export interface ProfileState {
  readonly schemaVersion: 1;
  readonly status: 'accepted' | 'skipped' | 'failed';
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

export async function loadAgency(
  directory: string,
): Promise<Agency | undefined> {
  try {
    if (!(await lstat(directory)).isDirectory())
      throw new Error('Agency directory must not be a symbolic link.');
    const data = object(
      JSON.parse(await readMemory(join(directory, 'settings.json'))),
    );
    if (data.host !== 'claude' && data.host !== 'codex')
      throw new Error('Saved agency harness must be claude or codex.');
    validateModel(data.model);
    return {
      host: data.host,
      ...(data.model === undefined ? {} : { model: data.model }),
    };
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
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
      throw new Error('Invalid profile setup state.');
    return { schemaVersion: 1, status: data.status };
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

/** Replace one owned file atomically. Existing symlink targets are never written. */
export async function saveAgencyFile(
  directory: string,
  name: 'settings.json' | 'USER.md' | 'profile-state.json',
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

export function memorySummary(markdown: string): string {
  const paragraph =
    stripVTControlCharacters(markdown)
      .split(/\n\s*\n/)
      .map((part) =>
        part
          .split('\n')
          .filter((line) => !line.startsWith('#'))
          .join(' ')
          .trim(),
      )
      .find(Boolean) ?? 'No summary available.';
  return paragraph.length <= 600
    ? paragraph
    : `${paragraph.slice(0, 597).trimEnd()}…`;
}

async function withProfileLock<T>(
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
      throw new Error(
        `Profile setup is locked. Confirm no profile setup is running before removing ${lockPath}.`,
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

/** Preference updates share ownership with profile setup. */
export async function saveAgencyPreferences(
  directory: string,
  agency: Agency,
  signal: AbortSignal,
): Promise<void> {
  await withProfileLock(directory, signal, () =>
    saveAgencyFile(directory, 'settings.json', JSON.stringify(agency, null, 2)),
  );
}

/** Serialize reviewed profile changes and record outcomes separately from approved memory. */
export async function setupProfile(
  directory: string,
  cwd: string,
  agency: Agency,
  io: CliIO,
  signal: AbortSignal,
  host: typeof runHarness = runHarness,
  offerInterview = true,
): Promise<string | undefined> {
  return withProfileLock(directory, signal, async () => {
    await saveAgencyFile(
      directory,
      'settings.json',
      JSON.stringify(agency, null, 2),
    );
    let status: ProfileState['status'];
    try {
      const approved = await personalize(
        directory,
        cwd,
        agency,
        io,
        signal,
        host,
        offerInterview,
      );
      status = approved === undefined ? 'skipped' : 'accepted';
    } catch {
      signal.throwIfAborted();
      status = 'failed';
    }
    signal.throwIfAborted();
    await saveAgencyFile(
      directory,
      'profile-state.json',
      JSON.stringify({ schemaVersion: 1, status }, null, 2),
    );
    if (status === 'failed')
      io.progress?.(
        'Profile setup did not finish. Any previously approved memory remains available. Run verifold profile --setup to try again.',
      );
    return loadMemory(directory);
  });
}

/** Consent precedes source access. Only reviewed Markdown becomes reusable memory. */
export async function personalize(
  directory: string,
  cwd: string,
  agency: Agency,
  io: CliIO,
  signal: AbortSignal,
  host: typeof runHarness = runHarness,
  offerInterview = true,
): Promise<string | undefined> {
  const choice = await choose(
    io,
    '02 / Personalize · Give your agents useful research context',
    [
      {
        value: 'history',
        label: 'Learn from my chats',
        description:
          'Review a profile from selected local chats or an export folder.',
      },
      ...(offerInterview
        ? [
            {
              value: 'chat',
              label: 'Build a profile with my agent',
              description: 'A short interview, then an AI draft you review.',
            },
          ]
        : []),
      {
        value: 'import',
        label: 'Use existing memory',
        description: 'Choose one text memory file or conversation export.',
      },
      {
        value: 'write',
        label: 'Write my own context',
        description: 'Save a short introduction without an AI call.',
      },
      {
        value: 'skip',
        label: 'Start without a profile',
        description: 'Go straight to a research question. No history is read.',
      },
    ],
    'skip',
  );
  if (choice === 'skip') return undefined;
  let draft: string;
  if (choice === 'import' || choice === 'history') {
    const defaultSource = join(
      homedir(),
      agency.host === 'claude' ? '.claude/projects' : '.codex/sessions',
    );
    const selected = (
      await io.ask(
        choice === 'history'
          ? `Chat file or folder [${defaultSource}]; /skip to continue without import: `
          : 'Path to one plain-text memory file or conversation export (blank to skip): ',
      )
    ).trim();
    if (selected === '/skip' || (!selected && choice === 'import'))
      return undefined;
    const source = selected
      ? selected.startsWith('~/')
        ? resolve(homedir(), selected.slice(2))
        : resolve(cwd, selected)
      : defaultSource;
    const consent = await io.ask(
      `Verifold will read ${choice === 'history' ? `a bounded sample from ${source}: up to 200 directory entries, 10 text/chat files, 256 KB per file and 512 KB total; no links or hidden subdirectories` : `only the selected file, ${source} (up to 128 KB)`}, and send its text to ${agency.host} (${agency.model ?? 'host default model'}) to summarize your research interests and working preferences. The model provider may process this content under your harness settings. Your harness keeps its own permissions and session records. Verifold will not copy the source archive. Native user-role messages can include harness-injected context; the reviewed profile must distinguish it from your own statements. You will review a private Markdown draft under ${directory} before reuse; accepted context is saved as USER.md there. Allow this? [y/N]: `,
    );
    if (!/^(y|yes)$/i.test(consent.trim())) return undefined;
    signal.throwIfAborted();
    const content =
      choice === 'history'
        ? await contextFiles(source, 'chats', signal)
        : await readMemory(source, 128000);
    const result = await withActivity(
      io,
      `Asking ${agency.host} to draft your research context.`,
      async () =>
        host({
          ...agency,
          cwd,
          signal,
          prompt: `${await loadPrompt('profile-summary')}\nSource path: ${JSON.stringify(source)}\nSource text (JSON string): ${JSON.stringify(content)}`,
        }),
    );
    draft = text(result.text, 'profile draft', 12000);
  } else if (choice === 'chat') {
    io.progress?.(
      'Your answers help your agent tailor research directions and experiments. No accounts or history are read.',
    );
    const topic = text(
      await io.ask('What do you want to work on? '),
      'research topic',
      4000,
    );
    const consent = await io.ask(
      `Use ${agency.host} (${agency.model ?? 'host default model'}) to ask follow-up questions and draft a private research profile? Your model provider may process the answers and your harness may retain the session. You will review it before saving. [y/N]: `,
    );
    if (!/^(y|yes)$/i.test(consent.trim())) return undefined;
    draft = await researchInterview(
      topic,
      undefined,
      agency,
      cwd,
      io,
      signal,
      host,
    );
  } else {
    draft = text(
      await io.ask(
        'What interests or working preferences should research use? ',
      ),
      'research context',
      10000,
    );
  }
  signal.throwIfAborted();
  await prepareAgency(directory);
  const review = await mkdtemp(join(directory, 'review-'));
  try {
    const path = join(review, 'USER.md');
    const file = await open(path, 'wx', 0o600);
    try {
      await file.writeFile(draft);
    } finally {
      await file.close();
    }
    io.progress?.(
      `Draft summary: ${memorySummary(draft)}\nFull draft: ${path}\nYou can edit this Markdown file before accepting. The draft is removed after this prompt.`,
    );
    const accepted = await io.ask(
      'Save this profile for future research with your chosen harness and model provider? [y/N]: ',
    );
    if (!/^(y|yes)$/i.test(accepted.trim())) return undefined;
    signal.throwIfAborted();
    const approved = await readMemory(path);
    await saveAgencyFile(directory, 'USER.md', approved);
    return approved;
  } finally {
    await rm(review, { recursive: true, force: true });
  }
}
