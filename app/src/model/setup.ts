import type {
  AgentChoice,
  HarnessOption,
  Offer,
  OptionValue,
  SavedChoice,
  SetupChoices,
  SetupDefaults,
  StartRequest,
} from '../api/types.ts';
import { duration } from './format.ts';

/** The most agents of one harness that a lab can start, as the server allows. */
export const MAX_AGENTS = 20;

/**
 * The person's choice for one harness on the setup screen.
 *
 * A blank model or effort keeps the person's own setting. A blank mode follows the answer to the auto mode question.
 */
export interface HarnessPick {
  readonly harness: string;
  readonly count: number;
  readonly model: string;
  readonly effort: string;
  readonly mode: string;
}

/** One entry in a menu: the value to send, or `''` to send nothing, and the text that the menu shows for it. */
export interface MenuEntry {
  readonly value: string;
  readonly label: string;
}

/**
 * Return the first picks: the person's saved choices for new labs, or one agent of each harness that this computer
 * has. A harness that this computer doesn't have starts no agents.
 */
export function firstPicks(
  harnesses: readonly HarnessOption[],
  defaults: SetupDefaults,
): readonly HarnessPick[] {
  return harnesses.map((option) => {
    if (defaults.agents === null) {
      return {
        harness: option.name,
        count: option.available ? 1 : 0,
        model: '',
        effort: '',
        mode: '',
      };
    }
    const saved = defaults.agents.filter((choice) => choice.harness === option.name);
    const count = saved.reduce((sum, choice) => sum + choice.count, 0);
    const first = saved[0];
    return {
      harness: option.name,
      count: option.available ? Math.min(MAX_AGENTS, count) : 0,
      model: first?.model ?? '',
      effort: first?.effort ?? '',
      mode: first?.mode ?? '',
    };
  });
}

/** Return the picks with one harness's count changed by `step`, kept between zero and `MAX_AGENTS`. */
export function step(
  picks: readonly HarnessPick[],
  harness: string,
  change: number,
): readonly HarnessPick[] {
  return picks.map((pick) =>
    pick.harness === harness
      ? { ...pick, count: Math.min(MAX_AGENTS, Math.max(0, pick.count + change)) }
      : pick,
  );
}

/** Return how many agents the picks start. */
export function agentCount(picks: readonly HarnessPick[]): number {
  return picks.reduce((sum, pick) => sum + pick.count, 0);
}

/** Return the request that starts a lab with the person's choices. */
export function startRequest(
  question: string,
  picks: readonly HarnessPick[],
  autoMode: boolean,
  minutes: number | null,
): StartRequest {
  return {
    question: question.trim(),
    agents: chosenAgents(picks),
    auto_mode: autoMode,
    ...(minutes ? { minutes } : {}),
  };
}

/** Return the person's choices on the setup screen as the choices that new labs start with. */
export function setupChoices(
  picks: readonly HarnessPick[],
  autoMode: boolean,
  minutes: number | null,
): SetupChoices {
  return { agents: chosenAgents(picks), auto_mode: autoMode, minutes };
}

function chosenAgents(picks: readonly HarnessPick[]): readonly AgentChoice[] {
  return picks
    .filter((pick) => pick.count > 0)
    .map((pick) => ({
      harness: pick.harness,
      count: pick.count,
      ...(pick.model.trim() ? { model: pick.model.trim() } : {}),
      ...(pick.effort.trim() ? { effort: pick.effort.trim() } : {}),
      ...(pick.mode ? { mode: pick.mode } : {}),
    }));
}

/** Return what new labs start with, in words. */
export function defaultsLine(defaults: SetupDefaults, harnesses: readonly HarnessOption[]): string {
  const agents =
    defaults.agents === null
      ? 'One agent of each harness that this computer has'
      : defaults.agents.map((choice) => agentWords(choice, harnesses)).join('; ');
  const time =
    defaults.minutes === null ? 'No time limit' : `Time limit: ${duration(defaults.minutes)}`;
  return `${agents}. ${defaults.auto_mode ? 'Auto mode' : 'No auto mode'}. ${time}.`;
}

function agentWords(choice: SavedChoice, harnesses: readonly HarnessOption[]): string {
  const title = harnesses.find((option) => option.name === choice.harness)?.title ?? choice.harness;
  const details = [
    choice.model,
    choice.effort ? `${choice.effort} effort` : null,
    choice.mode ? `${choice.mode} mode` : null,
  ].filter((detail) => detail !== null);
  const agents = `${title}: ${choice.count} ${choice.count === 1 ? 'agent' : 'agents'}`;
  return details.length > 0 ? `${agents} (${details.join(', ')})` : agents;
}

/** Return the two letters in a harness's avatar: the first letters of two words, or the ends of one word. */
export function initials(title: string): string {
  const words = title.split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`
      : `${title[0] ?? ''}${title.at(-1) ?? ''}`;
  return letters.toUpperCase();
}

/** The effort levels that a harness offers with one model, and the person's own level, when the harness said it. */
export interface Efforts {
  readonly values: readonly OptionValue[];
  readonly current: string | null;
}

/**
 * Return the effort levels that a harness offers with a pick's model. A blank model is the person's own model.
 *
 * The harness reports the person's own effort level only for their own model. A model that the harness didn't
 * switch to offers no levels, so the agent keeps the harness's default for it.
 */
export function effortsOf(offer: Offer, model: string): Efforts {
  if (!model || model === offer.model) return { values: offer.efforts, current: offer.effort };
  return {
    values: offer.models.find((option) => option.value === model)?.efforts ?? [],
    current: null,
  };
}

/** Return the pick with another model, and without an effort level that the harness doesn't offer with it. */
export function withModel(pick: HarnessPick, offer: Offer, model: string): HarnessPick {
  const kept = effortsOf(offer, model).values.some((option) => option.value === pick.effort);
  return { ...pick, model, effort: kept ? pick.effort : '' };
}

/** Return what a pick's model menu says when it is closed, with the names that the harness offered. */
export function modelSummary(pick: HarnessPick, offer: Offer | null): string {
  const mode = pick.mode ? `, ${nameOf(offer?.modes ?? [], pick.mode)} mode` : '';
  const chosen = pick.model.trim() || pick.effort.trim();
  if (offer === null) {
    if (!chosen) return `Your default model and effort${mode}`;
    const effort = pick.effort.trim() ? `${pick.effort.trim()} effort` : 'default effort';
    return `${pick.model.trim() || 'Your default model'}, ${effort}${mode}`;
  }
  const model = pick.model.trim() || offer.model;
  const efforts = effortsOf(offer, pick.model.trim());
  const effort = pick.effort.trim() || efforts.current;
  const parts = [
    model ? nameOf(offer.models, model) : 'Your default model',
    ...(effort
      ? [`${nameOf(efforts.values, effort)} effort`]
      : efforts.values.length > 0 || !model
        ? ['default effort']
        : []),
  ];
  return `${parts.join(', ')}${chosen ? '' : ' (your default)'}${mode}`;
}

/**
 * Return a menu of a harness's values: first the person's own value, which sends nothing, then the others.
 *
 * `current` is the person's own value, as the harness reported it. `chosen` is the pick's value: a saved one that
 * the harness doesn't offer now stays in the menu, so the menu shows what the lab would get.
 */
export function menuEntries(
  values: readonly OptionValue[],
  current: string | null,
  chosen = '',
): readonly MenuEntry[] {
  const kept = chosen !== '' && !values.some((option) => option.value === chosen);
  if (values.length === 0 && !kept) return [];
  return [
    { value: '', label: current ? `${nameOf(values, current)} (your default)` : 'Your default' },
    ...values
      .filter((option) => option.value !== current)
      .map((option) => ({ value: option.value, label: option.name })),
    ...(kept ? [{ value: chosen, label: chosen }] : []),
  ];
}

/** Return a menu of a harness's modes: first the answer to the auto mode question, then each mode. */
export function modeEntries(offer: Offer, chosen = ''): readonly MenuEntry[] {
  const kept = chosen !== '' && !offer.modes.some((mode) => mode.value === chosen);
  if (offer.modes.length === 0 && !kept) return [];
  return [
    { value: '', label: 'Your auto mode answer' },
    ...offer.modes.map((mode) => ({
      value: mode.value,
      label: mode.value === offer.mode ? `${mode.name} (your default)` : mode.name,
    })),
    ...(kept ? [{ value: chosen, label: chosen }] : []),
  ];
}

/** Return the name that a harness shows for `value`, or `value` itself when the harness offered no name for it. */
function nameOf(values: readonly OptionValue[], value: string): string {
  return values.find((option) => option.value === value)?.name ?? value;
}
