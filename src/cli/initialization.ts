import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import {
  loadAgency,
  loadMemory,
  saveAgencyFile,
  personalize,
  memorySummary,
  type Agency,
} from './agency.ts';
import { validateModel, runHarness } from './harness.ts';
import { choose } from './choices.ts';
import { parseProfile } from '../domain/profile.ts';
import type { CliIO } from './commands.ts';
import type { Workspace } from './contracts.ts';
import { readJson } from './storage.ts';
import { researchInterview } from './onboarding.ts';
import { checkProjectDirectory, createProject } from './project.ts';

export interface InitializationOptions {
  readonly profile?: string;
  readonly host?: string;
  readonly model?: string;
  readonly agencyDir?: string;
  readonly topic?: string;
  readonly autonomy?: string;
  readonly setupOnly?: boolean;
  readonly workspaceSpecified?: boolean;
}
export interface Initialization {
  readonly root: string;
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

/** Choose a harness, review optional context, then collect the research brief. */
export async function initializeProject(
  root: string,
  cwd: string,
  options: InitializationOptions,
  io: CliIO,
  signal: AbortSignal,
  harness: typeof runHarness = runHarness,
): Promise<Initialization> {
  signal.throwIfAborted();
  if (options.autonomy !== undefined) parseAutonomy(options.autonomy);
  if (!io.interactive && !options.host && !options.profile)
    throw new Error(
      'Noninteractive init requires --host claude|codex or a legacy --profile.',
    );
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
  const topic = options.setupOnly
    ? undefined
    : (options.topic ?? (await io.ask('What do you want to work on? '))).trim();
  if (topic !== undefined && (!topic || topic.length > 4000))
    throw new Error('Provide a research topic between 1 and 4000 characters.');
  if (options.workspaceSpecified || !io.interactive || options.setupOnly)
    await checkProjectDirectory(root);
  // Legacy JSON imports remain project-scoped and do not change agency settings.
  const directory = resolve(
    cwd,
    options.agencyDir ?? join(homedir(), '.verifold', 'agency'),
  );
  const saved = options.profile ? undefined : await loadAgency(directory);
  const host = (
    options.host ??
    (io.interactive
      ? await choose(
          io,
          '01 / Connect · Choose your agent harness',
          [
            {
              value: 'claude',
              label: 'Claude Code',
              description:
                'Use your Claude tools, permissions, and native agents.',
            },
            {
              value: 'codex',
              label: 'Codex',
              description:
                'Use your Codex tools, permissions, and native agents.',
            },
          ],
          saved?.host ?? 'claude',
        )
      : 'existing-harness')
  ).trim();
  if (
    (!options.profile || !options.setupOnly) &&
    host !== 'claude' &&
    host !== 'codex'
  )
    throw new Error(
      'Choose claude or codex. Install and authenticate it before starting research.',
    );
  io.progress?.(
    'Your harness runs the AI work using its existing login. Verifold keeps the research record.',
  );
  const defaultModel = saved?.host === host ? saved.model : undefined;
  const modelInput =
    options.model ??
    (io.interactive && !options.profile
      ? (
          await io.ask(
            `Model [${defaultModel ?? 'host default'}]; enter default to use host settings: `,
          )
        ).trim() || defaultModel
      : defaultModel);
  const model = modelInput === 'default' ? undefined : modelInput;
  validateModel(model);
  let context: string | undefined;
  if (!options.profile && (host === 'claude' || host === 'codex')) {
    const agency: Agency = { host, ...(model ? { model } : {}) };
    context = await loadMemory(directory);
    await saveAgencyFile(
      directory,
      'settings.json',
      JSON.stringify(agency, null, 2),
    );
    if (!context && io.interactive && options.setupOnly) {
      try {
        context = await personalize(
          directory,
          cwd,
          agency,
          io,
          signal,
          harness,
        );
      } catch {
        signal.throwIfAborted();
        io.progress?.(
          'Profile setup did not finish. No new memory was adopted. You can continue research without it.',
        );
        // File and host errors can contain private source data. Do not print them.
      }
    }
    io.progress?.(
      context
        ? `Research profile: ${memorySummary(context)}\nFull profile: ${join(directory, 'USER.md')}`
        : `Agency ready: ${directory}\nNo personal research context saved. You can start with a topic.`,
    );
  }
  const profile = options.profile
    ? parseProfile(await readJson(resolve(cwd, options.profile)))
    : {
        name: 'Researcher',
        interests: ['Computational research'],
        scholar: '',
        github: '',
        session: '',
      };
  let research: Initialization['research'] = null;
  if (!options.setupOnly) {
    if (topic === undefined || (host !== 'claude' && host !== 'codex'))
      throw new Error('Research requires a topic and supported harness.');
    io.progress?.(
      'Your harness will use your answers and saved background to refine the research scope. Review the brief before project creation.',
    );
    const brief = await researchInterview(
      topic,
      context ?? (options.profile ? JSON.stringify(profile) : undefined),
      { host, ...(model ? { model } : {}) },
      cwd,
      io,
      signal,
      harness,
    );
    context = brief;
    if (io.interactive && !options.workspaceSpecified) {
      const selected = (await io.ask(`Project directory [${root}]: `)).trim();
      if (selected)
        root = selected.startsWith('~/')
          ? resolve(homedir(), selected.slice(2))
          : resolve(cwd, selected);
    }
    await checkProjectDirectory(root);
    const autonomy = parseAutonomy(
      options.autonomy ??
        (io.interactive
          ? await choose(
              io,
              'How should your agents explore?',
              [
                {
                  value: 'guided',
                  label: 'Collaborate with me',
                  description:
                    'Review the agent plan before it searches the field.',
                },
                {
                  value: 'autonomous',
                  label: 'Explore independently',
                  description:
                    'Plan and search now; bring back ideas for me to choose.',
                },
              ],
              'guided',
            )
          : undefined),
    );
    research = { topic, autonomy };
  }
  signal.throwIfAborted();
  const workspace = await createProject(
    root,
    {
      schemaVersion: 1,
      visibility: 'private',
      profile,
      host,
      ...(model ? { model } : {}),
      ...(context ? { context } : {}),
      candidates: [],
      selectedId: null,
    },
    topic,
    context,
    signal,
  );
  return { root, workspace, research };
}
