import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import {
  loadAgency,
  agencyDirectory,
  loadMemory,
  loadProfileState,
  readMemory,
  saveAgencyPreferences,
  setupProfile,
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
import { investigateProject } from './project-context.ts';
import { loadPrompt } from './prompts.ts';

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

/** Review personal and project context before the harness asks research questions. */
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
  let topic = options.setupOnly ? undefined : options.topic?.trim();
  if (topic !== undefined && (!topic || topic.length > 4000))
    throw new Error('Provide a research topic between 1 and 4000 characters.');
  if (options.workspaceSpecified || !io.interactive || options.setupOnly)
    await checkProjectDirectory(root);
  // Legacy JSON imports remain project-scoped and do not change agency settings.
  const directory = agencyDirectory(cwd, options.agencyDir);
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
    'Verifold starts your installed harness as a background CLI session using its existing login and configuration.\nThe harness owns model access, tools, and permissions. Verifold sends research instructions and saves the reviewed results.\nTool activity appears as the harness reports it. Background sessions cannot show interactive permission prompts.',
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
    if (!context && io.interactive && !(await loadProfileState(directory))) {
      context = await setupProfile(
        directory,
        cwd,
        agency,
        io,
        signal,
        harness,
        options.setupOnly === true,
      );
    } else await saveAgencyPreferences(directory, agency, signal);
    io.progress?.(
      context
        ? `Research profile: ${memorySummary(context)}\nFull profile: ${join(directory, 'USER.md')}`
        : `Agency ready: ${directory}\nNo personal research context saved. Use verifold profile --setup to create or retry a profile.`,
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
    let projectReviewed = false;
    let topicFromBrief = false;
    if (host !== 'claude' && host !== 'codex')
      throw new Error('Research requires a supported harness.');
    if (io.interactive && !options.workspaceSpecified) {
      const selected = (await io.ask(`Project directory [${root}]: `)).trim();
      if (selected)
        root = selected.startsWith('~/')
          ? resolve(homedir(), selected.slice(2))
          : resolve(cwd, selected);
    }
    await checkProjectDirectory(root);
    if (io.interactive) {
      const initialContext = topic ?? (await loadPrompt('project-intake'));
      const projectContext = await investigateProject(
        root,
        initialContext,
        { host, ...(model ? { model } : {}) },
        io,
        signal,
        harness,
      );
      if (projectContext !== initialContext) {
        projectReviewed = true;
        context = JSON.stringify({
          personalBackground:
            context ?? (options.profile ? JSON.stringify(profile) : undefined),
          projectContext,
        });
      }
      topic ??= (
        await io.ask(
          'Add a direction, question, or notes; /file <path> imports a written brief (optional; Enter lets your harness help): ',
        )
      ).trim();
      if (topic.startsWith('/file ')) {
        const selected = topic.slice(6).trim();
        if (!selected) throw new Error('Provide a path after /file.');
        const source = selected.startsWith('~/')
          ? resolve(homedir(), selected.slice(2))
          : resolve(cwd, selected);
        const consent = await io.ask(
          `Read only ${source} (up to 12000 bytes) and send its text to ${host} (${model ?? 'host default model'}) as project context? Your model provider may process it under your harness settings. [y/N]: `,
        );
        signal.throwIfAborted();
        if (/^(y|yes)$/i.test(consent.trim())) {
          try {
            context = JSON.stringify({
              background: context,
              source,
              projectNotes: await readMemory(source),
            });
          } catch {
            signal.throwIfAborted();
            io.progress?.(
              'The selected context file could not be read. It must be a regular text file of at most 12000 bytes. Setup will continue with the available context.',
            );
          }
        }
        topic = '';
      }
      if (topic.length > 4000)
        throw new Error('Provide research notes of at most 4000 characters.');
      topicFromBrief = !topic;
      topic ||= await loadPrompt('project-direction');
    }
    if (topic === undefined) throw new Error('Research requires a topic.');
    io.progress?.(
      'Your harness will use this context and your answers to refine the research scope. Review the brief before project creation.',
    );
    io.progress?.(
      projectReviewed
        ? 'Your harness can search the web and read the approved project directory to clarify your question.'
        : 'Your harness can search the web to clarify your question. It can ask you for local files or directories to inspect. Declined directories stay out of scope unless you explicitly authorize them later.',
    );
    context = await researchInterview(
      topic,
      context ?? (options.profile ? JSON.stringify(profile) : undefined),
      { host, ...(model ? { model } : {}) },
      projectReviewed ? root : cwd,
      io,
      signal,
      harness,
      projectReviewed ? 'project' : 'topic',
    );
    if (topicFromBrief) topic = memorySummary(context);
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
