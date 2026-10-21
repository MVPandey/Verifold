import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { setupProfile, memorySummary } from './agency.ts';
import {
  agencyDirectory,
  loadMemory,
  loadProfileState,
  loadSettings,
  readMemory,
  saveAgencyPreferences,
  type Agency,
} from '../core/agency.ts';
import { computeDefaults } from '../core/compute.ts';
import {
  validateModel,
  runHarness,
  type HarnessName,
} from '../core/harness.ts';
import { choose } from './choices.ts';
import { parseProfile } from '../core/profile.ts';
import type { CliIO } from './commands.ts';
import type { Workspace } from '../core/contracts.ts';
import { readJson } from '../core/storage.ts';
import { researchInterview } from './onboarding.ts';
import { checkProjectDirectory, createProject } from './project.ts';
import { investigateProject } from './project-context.ts';
import { loadPrompt } from './prompts.ts';
import { hostName } from '../core/session.ts';

export interface InitializationOptions {
  readonly profile?: string;
  readonly host?: string;
  readonly model?: string;
  readonly agencyDir?: string;
  readonly topic?: string;
  readonly autonomy?: string;
  readonly setupOnly?: boolean;
  readonly workspaceSpecified?: boolean;
  /** The harness commands on PATH, which the CLI looks up. With both, a new team has a helper by default. */
  readonly harnesses?: readonly HarnessName[];
  /**
   * A lab starts on the question after setup. A lab has no stop before its
   * work, so setup does not offer the research stop.
   */
  readonly lab?: boolean;
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

/** The teams that setup offers: one harness, or a lead and a helper. */
const teams: readonly {
  readonly value: string;
  readonly host: HarnessName;
  readonly helper?: HarnessName;
  readonly label: string;
  readonly description: string;
}[] = [
  {
    value: 'claude',
    host: 'claude',
    label: 'Claude Code',
    description: 'Claude Code runs research, the coordinator, and every task.',
  },
  {
    value: 'codex',
    host: 'codex',
    label: 'Codex',
    description: 'Codex runs research, the coordinator, and every task.',
  },
  {
    value: 'claude+codex',
    host: 'claude',
    helper: 'codex',
    label: 'Claude Code leads and Codex helps',
    description:
      'Claude Code runs research and the coordinator. The coordinator gives tasks to both, for example the independent half of a check.',
  },
  {
    value: 'codex+claude',
    host: 'codex',
    helper: 'claude',
    label: 'Codex leads and Claude Code helps',
    description:
      'Codex runs research and the coordinator. The coordinator gives tasks to both, for example the independent half of a check.',
  },
];

/** Ask for the team and the lead's model. The current values are the defaults. */
async function askTeam(
  io: CliIO,
  host: string,
  helper: HarnessName | undefined,
  model: string | undefined,
  installed: readonly HarnessName[] | undefined,
): Promise<{
  host: HarnessName;
  helper: HarnessName | undefined;
  model: string | undefined;
}> {
  // A team whose command the PATH does not hold says so. The person can still choose it.
  const missing = (names: readonly HarnessName[]): string => {
    const absent = installed
      ? names.filter((name) => !installed.includes(name))
      : [];
    return absent.length
      ? ` ${absent.map(hostName).join(' and ')} is not on your PATH.`
      : '';
  };
  const current =
    teams.find((team) => team.host === host && team.helper === helper)?.value ??
    (host === 'codex' ? 'codex' : 'claude');
  const chosen = (
    await choose(
      io,
      'Which harnesses run the research?',
      teams.map((team) => ({
        value: team.value,
        label: team.label,
        description: `${team.description}${missing(team.helper ? [team.host, team.helper] : [team.host])}`,
      })),
      current,
    )
  ).trim();
  const team = teams.find((entry) => entry.value === chosen) ?? teams[0];
  if (!team) throw new Error('Choose a listed team.');
  const kept = team.host === host ? model : undefined;
  const input = (
    await io.ask(
      `Model for ${hostName(team.host)} [${kept ?? 'harness default'}]; enter default to use the harness default: `,
      {
        kind: 'text',
        label: `Which model should ${hostName(team.host)} use? Leave it empty to keep the current choice.`,
        placeholder: kept ?? 'Harness default',
        actions: [{ label: 'Use the harness default', value: 'default' }],
      },
    )
  ).trim();
  const next = input === 'default' ? undefined : input || kept;
  validateModel(next);
  return { host: team.host, helper: team.helper, model: next };
}

/** The team, the lead's model, the folder, and the optional research stop of a new project, in one line. */
function settingsLine(
  host: string,
  helper: HarnessName | undefined,
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
  const lead = `with ${model ? `the model ${model}` : 'its default model'}`;
  return `${helper ? `${name} leads, ${lead}, and ${hostName(helper)} helps` : `${name}, ${lead}`}. Folder: ${folder}.${askFirst ? ' Asks you before the source search.' : ''}`;
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
  const settings = options.profile ? null : await loadSettings(directory);
  const saved = settings?.agency ?? undefined;
  let host = (
    options.host ??
    saved?.host ??
    (io.interactive ? 'claude' : 'existing-harness')
  ).trim();
  let model = options.model ?? (saved?.host === host ? saved.model : undefined);
  validateModel(model);
  // The saved team, or a lead and a helper when the PATH holds both harnesses.
  const other: HarnessName = host === 'codex' ? 'claude' : 'codex';
  let helper: HarnessName | undefined =
    saved?.host === host
      ? saved.helper
      : io.interactive &&
          !options.host &&
          options.harnesses?.includes('claude') &&
          options.harnesses.includes('codex')
        ? other
        : undefined;
  if (options.setupOnly && io.interactive && !options.host && !options.profile)
    ({ host, helper, model } = await askTeam(
      io,
      host,
      helper,
      model,
      options.harnesses,
    ));
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
  // A lab follows setup, and a lab has no stop before its work.
  if (options.lab && askFirst) {
    askFirst = false;
    io.progress?.(
      'A lab starts after this setup, and a lab has no stop before its work, so --autonomy guided changes nothing here. It applies to verifold init and verifold research.',
    );
  }
  let projectReviewed = false;
  let topicFromBrief = false;
  if (!options.setupOnly && io.interactive) {
    io.step?.('Question');
    for (;;) {
      const settings = settingsLine(host, helper, model, root, askFirst);
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
      ({ host, helper, model } = await askTeam(
        io,
        host,
        helper,
        model,
        options.harnesses,
      ));
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
      if (!options.lab)
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
    const agency: Agency = {
      host,
      ...(model ? { model } : {}),
      ...(helper ? { helper } : {}),
      // The first run's model for the helper stays while the helper does.
      ...(helper && helper === saved?.helper && saved.helperModel
        ? { helperModel: saved.helperModel }
        : {}),
    };
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
      projectReviewed ? root : undefined,
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
      ...(helper && helper !== host ? { helper } : {}),
      ...(context ? { context } : {}),
      // The question stays with the project from the start, so Home offers it with Start the lab even when the lab cannot start.
      ...(options.lab && research
        ? {
            research: {
              topic: research.topic,
              autonomy: research.autonomy,
              phase: 'needs-plan' as const,
            },
          }
        : {}),
      candidates: [],
      selectedId: null,
    },
    topic,
    context,
    signal,
    options.lab === true && research !== null,
    // A new project starts with the GPU limits of the profile.
    settings?.money ? { ...computeDefaults, ...settings.money } : undefined,
  );
  return { root, workspace, research };
}
