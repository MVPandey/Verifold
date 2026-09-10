import { resolve } from 'node:path';
import { parseProfile } from '../domain/profile.ts';
import type { CliIO } from './commands.ts';
import type { Workspace } from './contracts.ts';
import { changeWorkspace, readJson } from './storage.ts';

export interface InitializationOptions {
  readonly profile?: string;
  readonly host?: string;
  readonly topic?: string;
  readonly autonomy?: string;
  readonly setupOnly?: boolean;
}
export interface Initialization {
  readonly workspace: Workspace;
  readonly research: {
    readonly topic: string;
    readonly autonomy: 'guided' | 'autonomous';
  } | null;
}

/** Validate the requested degree of interaction. Guided research is the default. */
export function parseAutonomy(
  value: string | undefined,
): 'guided' | 'autonomous' {
  const autonomy = value?.trim() || 'guided';
  if (autonomy !== 'guided' && autonomy !== 'autonomous') {
    throw new Error('Choose guided or autonomous research.');
  }
  return autonomy;
}

/** Collect project settings before writing private state. This does not launch a harness. */
export async function initializeProject(
  root: string,
  cwd: string,
  options: InitializationOptions,
  io: CliIO,
  signal: AbortSignal,
): Promise<Initialization> {
  signal.throwIfAborted();
  if (!options.profile && !io.interactive)
    throw new Error('Noninteractive init requires --profile profile.json.');
  if (
    !options.setupOnly &&
    !io.interactive &&
    (!options.topic?.trim() ||
      !options.host ||
      options.autonomy !== 'autonomous')
  ) {
    throw new Error(
      'Noninteractive research requires --topic, --host claude|codex, and --autonomy autonomous. Use --setup-only to create a workspace without research.',
    );
  }
  const profile = options.profile
    ? parseProfile(await readJson(resolve(cwd, options.profile)))
    : parseProfile({
        name: await io.ask('Your name: '),
        interests: (
          await io.ask(
            'What do you publish or want to research? (comma-separated; math, CS/ML, security, etc.): ',
          )
        ).split(','),
        scholar: await io.ask('Google Scholar URL (optional): '),
        github: await io.ask('GitHub URL (optional): '),
        session: await io.ask(
          'Coding session reference (optional; no automatic import): ',
        ),
      });
  const host = (
    options.host ??
    (io.interactive
      ? await io.ask(
          options.setupOnly
            ? 'Existing AI harness name: '
            : 'Choose your agent harness (claude or codex): ',
        )
      : 'existing-harness')
  ).trim();
  let research: Initialization['research'] = null;
  if (!options.setupOnly) {
    if (host !== 'claude' && host !== 'codex')
      throw new Error(
        'Research currently supports --host claude or --host codex.',
      );
    const topic = (
      options.topic ?? (await io.ask('Research topic or broad field: '))
    ).trim();
    if (!topic || topic.length > 4000)
      throw new Error(
        'Provide a research topic between 1 and 4000 characters.',
      );
    const autonomy = parseAutonomy(
      options.autonomy ??
        (io.interactive
          ? await io.ask('Research mode (guided or autonomous) [guided]: ')
          : undefined),
    );
    research = { topic, autonomy };
  }
  signal.throwIfAborted();
  const workspace = await changeWorkspace(root, (current) => {
    if (current)
      throw new Error('Workspace already exists; refusing to overwrite it.');
    return {
      schemaVersion: 1,
      visibility: 'private',
      profile,
      host,
      candidates: [],
      selectedId: null,
    };
  });
  return { workspace, research };
}
