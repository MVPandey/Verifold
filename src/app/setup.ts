import type {
  ActionBodies,
  ActionName,
  MoneyLimits,
  ProfileCard,
  SetupStep,
  SetupView,
} from '../protocol/api.ts';
import { act, load, type ActOutcome, type Loaded } from './api.ts';

/** The first run's pages, in order. `done` comes after the last step. */
export const setupSteps = ['agents', 'about', 'skills', 'money'] as const;

export type SetupPage = SetupStep | 'done';

/** The page to open: the first step without a record, or `done`. */
export function firstPage(view: SetupView): SetupPage {
  return setupSteps.find((step) => view.steps[step] === null) ?? 'done';
}

/** What a step needs from the setup page to move between steps. */
export interface StepNav {
  /** The steps that this Verifold has, in order. The label, the bar, Back and Continue all use this list. */
  readonly steps: readonly SetupStep[];
  /** Back and the step bar: open a step. The page asks first while the step holds unsaved input. */
  readonly open: (step: SetupStep) => void;
  /** The step holds input that is not saved. */
  readonly unsaved: (unsaved: boolean) => void;
}

/** The steps that this Verifold has. An older one reports no Skills step. */
export function shownSteps(steps: SetupView['steps']): readonly SetupStep[] {
  return setupSteps.filter((step) => steps[step] !== undefined);
}

/**
 * The page after a step, among `steps`. The order is that of `setupSteps`,
 * so a step that `steps` leaves out, such as Skills on an older Verifold,
 * still leads on.
 */
export function pageAfter(
  step: SetupStep,
  steps: readonly SetupStep[] = setupSteps,
): SetupPage {
  const at = setupSteps.indexOf(step);
  return steps.find((next) => setupSteps.indexOf(next) > at) ?? 'done';
}

/** The step before a step, among `steps`. Null: the first step. */
export function pageBefore(
  step: SetupStep,
  steps: readonly SetupStep[] = setupSteps,
): SetupStep | null {
  const at = setupSteps.indexOf(step);
  return (
    steps.filter((before) => setupSteps.indexOf(before) < at).at(-1) ?? null
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The server is Verifold itself. This check catches an older server without the first run. */
export function isSetupView(value: unknown): value is SetupView {
  return (
    object(value) &&
    object(value.steps) &&
    object(value.agents) &&
    Array.isArray(value.agents.tools) &&
    object(value.about) &&
    Array.isArray(value.about.lines) &&
    object(value.money) &&
    object(value.money.limits)
  );
}

/** The first run's read and its actions. Each action takes the key of the person's intent (see intent.ts). */
export interface SetupActions {
  readonly read: (signal?: AbortSignal) => Promise<Loaded<SetupView>>;
  readonly agents: (
    body: Omit<ActionBodies['setup-agents'], 'key'>,
    key: string,
  ) => Promise<ActOutcome>;
  readonly check: (key: string) => Promise<ActOutcome>;
  /** An answer, or a note that changes the card, with the person's edits of it. */
  readonly say: (
    text: string,
    card: ProfileCard | null,
    key: string,
  ) => Promise<ActOutcome>;
  readonly retry: (key: string) => Promise<ActOutcome>;
  readonly fill: (key: string) => Promise<ActOutcome>;
  readonly restart: (key: string) => Promise<ActOutcome>;
  /** Save the card, or keep the profile in free form (null). */
  readonly about: (
    card: ProfileCard | null,
    key: string,
  ) => Promise<ActOutcome>;
  /** Store a RunPod key. It goes only to Verifold, which checks it with RunPod first. */
  readonly runpodKey: (
    value: string,
    file: boolean,
    key: string,
  ) => Promise<ActOutcome>;
  readonly prices: (key: string) => Promise<ActOutcome>;
  readonly money: (limits: MoneyLimits, key: string) => Promise<ActOutcome>;
  readonly skip: (step: SetupStep | 'all', key: string) => Promise<ActOutcome>;
  /** Read the skill catalogs and match them to the profile. */
  readonly skillsSearch: (key: string) => Promise<ActOutcome>;
  readonly skillAdd: (id: string, key: string) => Promise<ActOutcome>;
  readonly skillRemove: (id: string, key: string) => Promise<ActOutcome>;
  readonly skillsDone: (key: string) => Promise<ActOutcome>;
  /** List the person's own skills. `again`: read them again, though a list exists. */
  readonly ownSkillsList: (again: boolean, key: string) => Promise<ActOutcome>;
  /** Which of the person's own skills Verifold's agents load, with notes on when to use them. */
  readonly ownSkills: (
    choices: ActionBodies['setup-own-skills']['choices'],
    key: string,
  ) => Promise<ActOutcome>;
}

const signedOut = (): Promise<{ readonly refused: string }> =>
  Promise.resolve({ refused: 'This tab has no access key.' });

export function setupActions(token: string | null): SetupActions {
  if (!token)
    return {
      read: () => Promise.resolve({ error: 'This tab has no access key.' }),
      agents: signedOut,
      check: signedOut,
      say: signedOut,
      retry: signedOut,
      fill: signedOut,
      restart: signedOut,
      about: signedOut,
      runpodKey: signedOut,
      prices: signedOut,
      money: signedOut,
      skip: signedOut,
      skillsSearch: signedOut,
      skillAdd: signedOut,
      skillRemove: signedOut,
      skillsDone: signedOut,
      ownSkills: signedOut,
      ownSkillsList: signedOut,
    };
  const run = <Name extends ActionName>(
    name: Name,
    body: ActionBodies[Name],
    key: string,
  ): Promise<ActOutcome> => act(token, name, body, key);
  return {
    read: (signal) => load(token, '/api/v1/setup', isSetupView, signal),
    agents: (body, key) => run('setup-agents', body, key),
    check: (key) => run('setup-check', {}, key),
    say: (text, card, key) =>
      run('setup-say', { text, ...(card ? { card } : {}) }, key),
    retry: (key) => run('setup-retry', {}, key),
    fill: (key) => run('setup-fill', {}, key),
    restart: (key) => run('setup-restart', {}, key),
    about: (card, key) =>
      run('setup-about', card ? { card } : { keep: true }, key),
    runpodKey: (value, file, key) =>
      run('setup-key', { runpodKey: value, ...(file ? { file } : {}) }, key),
    prices: (key) => run('setup-prices', {}, key),
    money: (limits, key) => run('setup-money', limits, key),
    skip: (step, key) => run('setup-skip', { step }, key),
    skillsSearch: (key) => run('setup-skills-search', {}, key),
    skillAdd: (id, key) => run('setup-skill-add', { id }, key),
    skillRemove: (id, key) => run('setup-skill-remove', { id }, key),
    skillsDone: (key) => run('setup-skills-done', {}, key),
    ownSkills: (choices, key) => run('setup-own-skills', { choices }, key),
    ownSkillsList: (again, key) =>
      run('setup-own-skills-list', again ? { again } : {}, key),
  };
}

/** A plan as the agents step names it: "Max plan". */
export function planName(plan: string): string {
  const words = plan.replace(/_/g, ' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} plan`;
}

/**
 * The GPUs that agents may rent: the saved list, or before a save, each
 * GPU shown at or under the price cap.
 */
export function allowedGpus(
  view: SetupView,
  maxUsdPerHour: number,
): readonly string[] {
  if (view.steps.money === 'done') return view.money.limits.gpuTypes;
  return (view.money.prices?.gpus ?? [])
    .filter((gpu) => gpu.usdPerHour <= maxUsdPerHour)
    .map((gpu) => gpu.id);
}
