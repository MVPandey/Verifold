import { mkdir, readdir } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { loadSettings } from '../core/agency.ts';
import {
  computeDefaults,
  parseSettings,
  projectSettings,
  type ProfileMoney,
} from '../core/compute.ts';
import type { Workspace } from '../core/contracts.ts';
import { detectHarnesses, type HarnessStatus } from '../core/detect.ts';
import { validateModel, type HarnessName } from '../core/harness.ts';
import { defaultLabHours, hours, labLimits, text } from '../core/lab/schema.ts';
import { ownProfileFolder } from '../core/project-profile.ts';
import { removeTree } from '../core/skills.ts';
import { SessionActionError } from '../core/session.ts';
import type { ProjectAgents, StartView } from '../protocol/api.ts';
import type { ProjectStart } from '../server/api.ts';
import {
  checkProjectDirectory,
  createProject,
  defaultProfile,
  expandHome,
  homeShown,
} from './project.ts';

/** A project that the Ask page started: its folder, the question, and the lab's hours. */
export interface Begun {
  readonly root: string;
  readonly question: string;
  readonly hours: number;
}

/** What a new project starts with unless the Ask page changes it. */
interface Defaults {
  readonly agents: ProjectAgents | null;
  readonly gpuUsd: number | null;
  /** The profile's GPU limits, which a project copies. Null: the profile has none. */
  readonly money: ProfileMoney | null;
}

function fail(message: string): never {
  throw new SessionActionError(message);
}

function harness(value: unknown, what: string): HarnessName {
  return value === 'claude' || value === 'codex'
    ? value
    : fail(`Choose claude or codex for ${what}.`);
}

/** A model name, or nothing. Refused names say why. */
function model(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    validateModel(value);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'That model is not valid.');
  }
  return value;
}

/** The agents that the Ask page sends: a lead and maybe a helper, each with a model or none. */
function team(value: unknown): ProjectAgents {
  const data =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : fail('Choose the agents of the project.');
  const host = harness(data.host, 'the lead agent');
  const helper =
    data.helper === undefined || data.helper === null
      ? undefined
      : harness(data.helper, 'the second agent');
  if (helper === host) fail('Choose two different agents, or one.');
  const lead = model(data.model);
  const second = helper ? model(data.helperModel) : undefined;
  return {
    host,
    ...(lead ? { model: lead } : {}),
    ...(helper ? { helper } : {}),
    ...(second ? { helperModel: second } : {}),
  };
}

/**
 * The project's agents unless the person changes them: the profile's lead
 * and helper with the models that it saved, else the harnesses on this
 * computer that are installed and not signed out, Claude Code first. Null:
 * none of them is.
 */
export function defaultTeam(
  profile: ProjectAgents | null,
  found: readonly HarnessStatus[],
): ProjectAgents | null {
  if (profile) return profile;
  const [lead, second] = (['claude', 'codex'] as const).filter((name) =>
    found.some(
      (status) =>
        status.harness === name &&
        status.installed &&
        status.signedIn !== false,
    ),
  );
  return lead ? { host: lead, ...(second ? { helper: second } : {}) } : null;
}

/**
 * The Ask page's start, while Verifold runs without a project. The view
 * holds the project's defaults, and the page shows exactly those; Start
 * then sends what the page shows. Only one start runs, and nothing starts
 * after it. `begun` settles with the new project.
 */
export function askStart(options: {
  /** The folder where Verifold started. */
  readonly root: string;
  /** The folder of the person's global profile. */
  readonly agency: string;
  readonly signal: AbortSignal;
  /** Tests use fakes. */
  readonly detect?: () => Promise<readonly HarnessStatus[]>;
}): { readonly start: ProjectStart; readonly begun: Promise<Begun> } {
  let settle: (project: Begun) => void = () => {};
  const begun = new Promise<Begun>((resolve) => {
    settle = resolve;
  });
  let busy = false;
  let done = false;
  let detected: Promise<readonly HarnessStatus[]> | null = null;
  /** The defaults, from the profile at `folder` when it reads, else from this computer. */
  const defaults = async (folder: string): Promise<Defaults> => {
    const settings = await loadSettings(folder).catch(() => null);
    const saved = settings?.agency;
    const profile: ProjectAgents | null = saved
      ? {
          host: saved.host,
          ...(saved.model ? { model: saved.model } : {}),
          ...(saved.helper && saved.helper !== saved.host
            ? {
                helper: saved.helper,
                ...(saved.helperModel
                  ? { helperModel: saved.helperModel }
                  : {}),
              }
            : {}),
        }
      : null;
    // Without a profile team, the harnesses on this computer, found once. A failed look runs again.
    const found = profile
      ? []
      : await (detected ??= (options.detect ?? detectHarnesses)().catch(
          (): readonly HarnessStatus[] => {
            detected = null;
            return [];
          },
        ));
    const money = settings?.money ?? null;
    return {
      agents: defaultTeam(profile, found),
      gpuUsd: money?.limitUsd ?? null,
      money,
    };
  };
  const start: ProjectStart = {
    view: async (scope?: 'project'): Promise<StartView> => {
      const { agents, gpuUsd, money } = await defaults(
        scope === 'project' ? ownProfileFolder(options.root) : options.agency,
      );
      return {
        folder: homeShown(options.root),
        // The person's own files, not what macOS adds.
        files: (await readdir(options.root).catch(() => [])).some(
          (name) => name !== '.DS_Store',
        ),
        hours: defaultLabHours,
        maxHours: labLimits.hours,
        questionLimit: labLimits.question,
        agents,
        gpuUsd,
        gpuLimits: money !== null,
        started: done,
      };
    },
    act: async (body) => {
      if (done) fail('The project started already. Reload the page.');
      if (busy) fail('The project is starting. Wait a moment.');
      busy = true;
      try {
        const question = text(
          body.question,
          labLimits.question,
          'the question',
        );
        // An isolated project's own settings are in this folder already, so it starts here.
        const own =
          body.profile === undefined
            ? false
            : body.profile === 'project' ||
              fail('Choose the global settings, or this project’s own.');
        if (own && body.folder !== undefined && body.folder !== '')
          fail(
            'An isolated project stays in this folder. To use another folder, run verifold there.',
          );
        const folder =
          body.folder === undefined || body.folder === ''
            ? options.root
            : typeof body.folder === 'string' &&
                body.folder.length <= 4096 &&
                (body.folder.startsWith('~/') || isAbsolute(body.folder))
              ? expandHome(body.folder, options.root)
              : fail(
                  'Give the folder as a full path, or as one that starts with ~/.',
                );
        const budget =
          body.hours === undefined ? defaultLabHours : hours(body.hours);
        const fallback = await defaults(
          own ? ownProfileFolder(folder) : options.agency,
        );
        const agents =
          body.agents === undefined ? fallback.agents : team(body.agents);
        if (!agents)
          fail(
            'Verifold found no agent tool that is signed in. Sign in to Claude Code or Codex, then start again.',
          );
        // The profile's limits without its monthly one, which each check reads from the profile.
        const base = fallback.money
          ? projectSettings(fallback.money)
          : computeDefaults;
        const compute = parseSettings(
          {
            ...base,
            limitUsd: body.gpuUsd === undefined ? fallback.gpuUsd : body.gpuUsd,
          },
          base,
        );
        try {
          await checkProjectDirectory(folder);
          // A new folder from Change comes into being here.
          await mkdir(folder, { recursive: true, mode: 0o700 });
          await createProject(
            folder,
            {
              schemaVersion: 1,
              visibility: 'private',
              profile: defaultProfile,
              ...agents,
              // The lab keeps the question for the project, as setup does.
              research: {
                topic: question,
                autonomy: 'autonomous',
                phase: 'needs-plan',
              },
              candidates: [],
              selectedId: null,
            } satisfies Workspace,
            question,
            undefined,
            options.signal,
            true,
            compute,
            own,
          );
        } catch (error) {
          if (error instanceof SessionActionError) throw error;
          fail(
            `Verifold could not start the project in ${homeShown(folder)}: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        }
        done = true;
        // A project on the global settings drops an isolated copy that the person left here: nothing uses it.
        const left = ownProfileFolder(folder);
        if (!own && left !== options.agency)
          await removeTree(left).catch(() => {});
        settle({ root: folder, question, hours: budget });
        return 202;
      } finally {
        busy = false;
      }
    },
  };
  return { start, begun };
}
