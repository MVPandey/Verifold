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
import { hostName } from './session.ts';

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

/** Validate the requested degree of interaction. Research runs without a stop unless the person asks for one ("guided"). */
export function parseAutonomy(
  value: string | undefined,
): 'guided' | 'autonomous' {
  const autonomy = value?.trim() || 'autonomous';
  if (autonomy !== 'guided' && autonomy !== 'autonomous') {
    throw new Error('Choose guided or autonomous research.');
  }
  return autonomy;
}

/** Ask for the harness and its model. The current values are the defaults. */
async function askHarness(
  io: CliIO,
  host: string,
  model: string | undefined,
): Promise<{ host: string; model: string | undefined }> {
  const chosen = (
    await choose(
      io,
      'Which harness runs the research?',
      [
        {
          value: 'claude',
          label: 'Claude Code',
          description: 'It runs with your Claude Code sign-in and settings.',
        },
        {
          value: 'codex',
          label: 'Codex',
          description: 'It runs with your Codex sign-in and settings.',
        },
      ],
      host === 'codex' ? 'codex' : 'claude',
    )
  ).trim();
  const current = chosen === host ? model : undefined;
  const input = (
    await io.ask(
      `Model [${current ?? 'harness default'}]; enter default to use the harness default: `,
      {
        kind: 'text',
        label:
          'Which model should it use? Leave it empty to keep the current choice.',
        placeholder: current ?? 'Harness default',
        actions: [{ label: 'Use the harness default', value: 'default' }],
      },
    )
  ).trim();
  const next = input === 'default' ? undefined : input || current;
  validateModel(next);
  return { host: chosen, model: next };
}

/** The harness, the model, the folder, and the optional research stop of a new project, in one line. */
function settingsLine(
  host: string,
  model: string | undefined,
  root: string,
  askFirst: boolean,
): string {
  const home = homedir();
  const folder =
    root === home || root.startsWith(`${home}/`)
      ? `~${root.slice(home.length)}`
      : root;
  const name = host === 'claude' || host === 'codex' ? hostName(host) : host;
  return `${name}, with ${model ? `the model ${model}` : 'its default model'}. Folder: ${folder}.${askFirst ? ' Asks you before the source search.' : ''}`;
}

/**
 * Set up a project. Research setup starts with the question. The harness, the
 * model, and the folder have defaults that the person can change from the
 * question. Setup without research asks for the harness and the model, and it
 * offers the reusable profile.
 */
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
  let host = (
    options.host ??
    saved?.host ??
    (io.interactive ? 'claude' : 'existing-harness')
  ).trim();
  let model = options.model ?? (saved?.host === host ? saved.model : undefined);
  validateModel(model);
  if (options.setupOnly && io.interactive && !options.host && !options.profile)
    ({ host, model } = await askHarness(io, host, model));
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
  // The research plan waits for the person only when they ask for that stop.
  let askFirst = parseAutonomy(options.autonomy) === 'guided';
  let projectReviewed = false;
  let topicFromBrief = false;
  if (!options.setupOnly && io.interactive) {
    io.step?.('Question');
    for (;;) {
      const settings = settingsLine(host, model, root, askFirst);
      const answer = (
        topic ??
        (await io.ask(
          `What do you want to find out?\n${settings} Type /settings to change these, or /file and a path to import a written brief. Press Enter to let your harness help: `,
          {
            kind: 'text',
            label: 'What do you want to find out?',
            multiline: true,
            placeholder: 'A question, a direction, or notes',
            note: settings,
            actions: [
              { label: 'Change the settings', value: '/settings' },
              { label: 'Let my harness help', value: '' },
            ],
          },
        ))
      ).trim();
      if (answer !== '/settings') {
        topic = answer;
        break;
      }
      ({ host, model } = await askHarness(io, host, model));
      if (!options.workspaceSpecified) {
        const selected = (
          await io.ask(`Project folder [${root}]: `, {
            kind: 'text',
            label: `Project folder. Leave it empty to keep ${root}.`,
            placeholder: root,
          })
        ).trim();
        if (selected)
          root = selected.startsWith('~/')
            ? resolve(homedir(), selected.slice(2))
            : resolve(cwd, selected);
      }
      askFirst = /^(y|yes)$/i.test(
        (
          await io.ask(
            'Ask you before the source search? Research then waits for your approval of its plan. [y/N]: ',
            {
              kind: 'confirm',
              yes: 'Ask me before the source search',
              no: 'Search without a stop',
            },
          )
        ).trim(),
      );
    }
  }
  if (
    (!options.profile || !options.setupOnly) &&
    host !== 'claude' &&
    host !== 'codex'
  )
    throw new Error(
      'Choose claude or codex. Install and authenticate it before starting research.',
    );
  let context: string | undefined;
  if (!options.profile && (host === 'claude' || host === 'codex')) {
    const agency: Agency = { host, ...(model ? { model } : {}) };
    context = await loadMemory(directory);
    // Setup without research offers the reusable profile. Research setup starts with the question instead.
    if (
      options.setupOnly &&
      !context &&
      io.interactive &&
      !(await loadProfileState(directory))
    )
      context = await setupProfile(
        directory,
        cwd,
        agency,
        io,
        signal,
        harness,
        true,
      );
    else await saveAgencyPreferences(directory, agency, signal);
    if (options.setupOnly)
      io.progress?.(
        context
          ? `Research profile: ${memorySummary(context)}\nFull profile: ${join(directory, 'USER.md')}`
          : `Agency ready: ${directory}\nNo personal research context saved. Use verifold profile --setup to create or retry a profile.`,
      );
  }
  if (!options.setupOnly) {
    if (host !== 'claude' && host !== 'codex')
      throw new Error('Research requires a supported harness.');
    const agency: Agency = { host, ...(model ? { model } : {}) };
    await checkProjectDirectory(root);
    if (io.interactive) {
      topic ??= '';
      if (topic.startsWith('/file ')) {
        const selected = topic.slice(6).trim();
        if (!selected) throw new Error('Provide a path after /file.');
        const source = selected.startsWith('~/')
          ? resolve(homedir(), selected.slice(2))
          : resolve(cwd, selected);
        const consent = await io.ask(
          `Read only ${source} (up to 12000 bytes) and send its text to ${hostName(host)} (${model ?? 'harness default model'}) as project context? Your model provider may process it under your harness settings. [y/N]: `,
          {
            kind: 'confirm',
            yes: 'Read and send the file',
            no: 'Skip the file',
          },
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
      // A folder with files asks for consent before the harness reads it.
      const initialContext = topic || (await loadPrompt('project-intake'));
      const projectContext = await investigateProject(
        root,
        initialContext,
        agency,
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
      topicFromBrief = !topic;
      topic ||= await loadPrompt('project-direction');
    }
    if (topic === undefined) throw new Error('Research requires a topic.');
    io.progress?.(
      projectReviewed
        ? 'Your harness can search the web and read the approved folder to clarify the question.'
        : 'Your harness can search the web to clarify the question. It asks before it reads other local files.',
    );
    io.step?.('Quick questions');
    context = await researchInterview(
      topic,
      context ?? (options.profile ? JSON.stringify(profile) : undefined),
      agency,
      projectReviewed ? root : cwd,
      io,
      signal,
      harness,
      projectReviewed ? 'project' : 'topic',
    );
    if (topicFromBrief) topic = memorySummary(context);
    research = { topic, autonomy: askFirst ? 'guided' : 'autonomous' };
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
