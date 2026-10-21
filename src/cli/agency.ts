import { loadPrompt } from './prompts.ts';
import { open, rm, mkdtemp, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import type { CliIO } from './commands.ts';
import { choose, withActivity } from './choices.ts';
import { activityProgress, runHarness } from '../core/harness.ts';
import { text } from '../core/research-contracts.ts';
import {
  loadMemory,
  prepareAgency,
  readMemory,
  saveAgencyFile,
  withProfileLock,
  writeSettings,
  type Agency,
  type ProfileState,
} from '../core/agency.ts';
import { researchInterview } from './onboarding.ts';
import { contextFiles } from './context-files.ts';
import { expandHome } from './project.ts';

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
    await writeSettings(directory, (current) => ({ ...current, agency }));
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
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
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
        value: 'harness-history',
        label: 'Ask my harness to review my chats',
        description:
          'Your harness reads a selected local history folder and drafts context for review.',
      },
      {
        value: 'history',
        label: 'Import a sample of my chats',
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
  if (
    choice === 'harness-history' ||
    choice === 'import' ||
    choice === 'history'
  ) {
    const defaultSource = join(
      homedir(),
      agency.host === 'claude' ? '.claude/projects' : '.codex/sessions',
    );
    const selected = (
      await io.ask(
        choice === 'import'
          ? 'Path to one plain-text memory file or conversation export (blank to skip): '
          : `Local chat file or folder [${defaultSource}]; /skip to skip: `,
        {
          kind: 'text',
          label:
            choice === 'import'
              ? 'Path to one plain-text memory file or conversation export.'
              : `Local chat file or folder. Leave it empty to use ${defaultSource}.`,
          placeholder: choice === 'import' ? 'Path to a file' : defaultSource,
          actions: [
            { label: 'Skip', value: choice === 'import' ? '' : '/skip' },
          ],
        },
      )
    ).trim();
    if (selected === '/skip' || (!selected && choice === 'import'))
      return undefined;
    const source = selected ? expandHome(selected, cwd) : defaultSource;
    if (choice === 'harness-history') {
      io.progress?.(
        `## Let your harness build your profile\n\nSource: ${source}\nHarness: ${agency.host} (${agency.model ?? 'host default model'})\n\n- Your harness chooses and reads relevant local chats using its own tools and permissions.\n- It chooses how much context to read within this source and reports its coverage. The scope is a prompt instruction, not a filesystem sandbox.\n- This does not grant access to cloud chats or guarantee that earlier conversations are available.\n- Your model provider may process the text, and your harness may retain session records.\n- You review the full draft before Verifold saves reusable context in ${directory}/USER.md.`,
      );
      const consent = await io.ask(
        'Ask your harness to read this source and draft your profile? [y/N]: ',
        { kind: 'confirm', yes: 'Read and draft my profile', no: 'Skip' },
      );
      if (!/^(y|yes)$/i.test(consent.trim())) return undefined;
      signal.throwIfAborted();
      const sourceStat = await lstat(source);
      if (!sourceStat.isFile() && !sourceStat.isDirectory())
        throw new Error(
          'Choose a regular chat file or directory, not a symbolic link.',
        );
      const result = await withActivity(
        io,
        `${agency.host} · Reviewing selected chat history`,
        async () =>
          host({
            ...agency,
            cwd,
            signal,
            onActivity: activityProgress(io.progress),
            prompt: `${await loadPrompt('profile-history')}\nSelected source: ${JSON.stringify(source)}`,
          }),
      );
      draft = text(result.text, 'profile draft', 12000);
    } else {
      const consent = await io.ask(
        `Verifold will read ${choice === 'history' ? `a bounded sample from ${source}: up to 200 directory entries, 10 text/chat files, 256 KB per file and 512 KB total; no links or hidden subdirectories` : `only the selected file, ${source} (up to 128 KB)`}.\n\nIt sends this text to ${agency.host} (${agency.model ?? 'host default model'}) to summarize research interests and working preferences. Your model provider may process this content. Your harness keeps its own permissions and session records.\n\nVerifold will not copy the source archive. Native user-role messages can include harness-injected context. Review which statements are yours.\n\nYou will review the full draft before reuse. Accepted context is saved in ${directory}/USER.md.\n\nAllow this import? [y/N]: `,
        { kind: 'confirm', yes: 'Allow this import', no: 'Skip' },
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
            onActivity: activityProgress(io.progress),
            prompt: `${await loadPrompt('profile-summary')}\nSource path: ${JSON.stringify(source)}\nSource text (JSON string): ${JSON.stringify(content)}`,
          }),
      );
      draft = text(result.text, 'profile draft', 12000);
    }
  } else if (choice === 'chat') {
    io.progress?.(
      'Your answers help your agent tailor research directions and experiments. No accounts or history are read.',
    );
    const topic = text(
      await io.ask('What do you want to work on? ', {
        kind: 'text',
        multiline: true,
      }),
      'research topic',
      4000,
    );
    const consent = await io.ask(
      `Use ${agency.host} (${agency.model ?? 'host default model'}) to ask follow-up questions and draft a private research profile? Your model provider may process the answers and your harness may retain the session. You will review it before saving. [y/N]: `,
      { kind: 'confirm', yes: 'Start the interview', no: 'Skip' },
    );
    if (!/^(y|yes)$/i.test(consent.trim())) return undefined;
    draft = await researchInterview(
      topic,
      undefined,
      agency,
      undefined,
      io,
      signal,
      host,
    );
  } else {
    draft = text(
      await io.ask(
        'What interests or working preferences should research use? ',
        { kind: 'text', multiline: true },
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
      `## Profile draft for review\n\n${draft}\n\nFull draft: ${path}\nYou can edit this Markdown file before accepting. The draft is removed after this prompt.`,
    );
    const accepted = await io.ask(
      'Save this profile for future research with your chosen harness and model provider? [y/N]: ',
      { kind: 'confirm', yes: 'Save my profile', no: "Don't save it" },
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
