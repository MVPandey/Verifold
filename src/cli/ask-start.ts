import { mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { loadSettings, type Agency } from '../core/agency.ts';
import { computeDefaults, parseSettings } from '../core/compute.ts';
import type { Workspace } from '../core/contracts.ts';
import { validateModel, type HarnessName } from '../core/harness.ts';
import { defaultLabHours, hours, labLimits, text } from '../core/lab/schema.ts';
import { SessionActionError } from '../core/session.ts';
import type { StartView } from '../protocol/api.ts';
import type { ProjectStart } from '../server/api.ts';
import { checkProjectDirectory, createProject } from './project.ts';

/** A project that the Ask page started: its folder, the question, and the lab's hours. */
export interface Begun {
  readonly root: string;
  readonly question: string;
  readonly hours: number;
}

function fail(message: string): never {
  throw new SessionActionError(message);
}

/** A folder for the person, with their home folder as `~`. */
function shown(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`)
    ? `~${path.slice(home.length)}`
    : path;
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

/** The project's harnesses: the person's choice on the Ask page, else the profile's harnesses without their models, which the lab reads from the profile. */
function team(
  value: unknown,
  profile: Agency | null,
): Pick<Workspace, 'host' | 'model' | 'helper' | 'helperModel'> {
  if (value === undefined)
    return {
      host: profile?.host ?? 'claude',
      ...(profile?.helper && profile.helper !== profile.host
        ? { helper: profile.helper }
        : {}),
    };
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
 * The Ask page's start, while Verifold runs without a project. It creates
 * the project with the person's question and settings, and `begun` settles
 * with it. Only one start runs, and nothing starts after it.
 */
export function askStart(options: {
  /** The folder where Verifold started. */
  readonly root: string;
  /** The folder of the person's profile. */
  readonly agency: string;
  readonly signal: AbortSignal;
}): { readonly start: ProjectStart; readonly begun: Promise<Begun> } {
  let settle: (project: Begun) => void = () => {};
  const begun = new Promise<Begun>((resolve) => {
    settle = resolve;
  });
  let busy = false;
  let done = false;
  const start: ProjectStart = {
    view: async (): Promise<StartView> => ({
      folder: shown(options.root),
      // The person's own files, not what macOS adds.
      files: (await readdir(options.root).catch(() => [])).some(
        (name) => name !== '.DS_Store',
      ),
      hours: defaultLabHours,
      maxHours: labLimits.hours,
      questionLimit: labLimits.question,
    }),
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
        const folder =
          body.folder === undefined || body.folder === ''
            ? options.root
            : typeof body.folder === 'string' && body.folder.length <= 4096
              ? body.folder.startsWith('~/')
                ? join(homedir(), body.folder.slice(2))
                : isAbsolute(body.folder)
                  ? resolve(body.folder)
                  : fail(
                      'Give the folder as a full path, or as one that starts with ~/.',
                    )
              : fail('Give the folder as a full path.');
        const budget =
          body.hours === undefined ? defaultLabHours : hours(body.hours);
        const profile = await loadSettings(options.agency).catch(() => null);
        const agents = team(body.agents, profile?.agency ?? null);
        const base = { ...computeDefaults, ...(profile?.money ?? {}) };
        const compute =
          body.gpuUsd === undefined
            ? base
            : parseSettings({ ...base, limitUsd: body.gpuUsd }, base);
        try {
          await checkProjectDirectory(folder);
          // A new folder from Change comes into being here.
          await mkdir(folder, { recursive: true, mode: 0o700 });
          await createProject(
            folder,
            {
              schemaVersion: 1,
              visibility: 'private',
              profile: {
                name: 'Researcher',
                interests: ['Computational research'],
                scholar: '',
                github: '',
                session: '',
              },
              ...agents,
              // The lab keeps the question for the project, as setup does.
              research: {
                topic: question,
                autonomy: 'autonomous',
                phase: 'needs-plan',
              },
              candidates: [],
              selectedId: null,
            },
            question,
            undefined,
            options.signal,
            true,
            compute,
          );
        } catch (error) {
          if (error instanceof SessionActionError) throw error;
          fail(
            `Verifold could not start the project in ${shown(folder)}: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        }
        done = true;
        settle({ root: folder, question, hours: budget });
        return 202;
      } finally {
        busy = false;
      }
    },
  };
  return { start, begun };
}
