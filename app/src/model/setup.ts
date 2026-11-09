import type { AgentChoice, HarnessOption, Offer, OptionValue, StartRequest } from '../api/types.ts';

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

/** Return the first picks: one agent of each harness that this computer has. */
export function firstPicks(harnesses: readonly HarnessOption[]): readonly HarnessPick[] {
  return harnesses.map((option) => ({
    harness: option.name,
    count: option.available ? 1 : 0,
    model: '',
    effort: '',
    mode: '',
  }));
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
  const agents: readonly AgentChoice[] = picks
    .filter((pick) => pick.count > 0)
    .map((pick) => ({
      harness: pick.harness,
      count: pick.count,
      ...(pick.model.trim() ? { model: pick.model.trim() } : {}),
      ...(pick.effort.trim() ? { effort: pick.effort.trim() } : {}),
      ...(pick.mode ? { mode: pick.mode } : {}),
    }));
  return {
    question: question.trim(),
    agents,
    auto_mode: autoMode,
    ...(minutes ? { minutes } : {}),
  };
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
 * `current` is the person's own value, as the harness reported it.
 */
export function menuEntries(
  values: readonly OptionValue[],
  current: string | null,
): readonly MenuEntry[] {
  if (values.length === 0) return [];
  return [
    { value: '', label: current ? `${nameOf(values, current)} (your default)` : 'Your default' },
    ...values
      .filter((option) => option.value !== current)
      .map((option) => ({ value: option.value, label: option.name })),
  ];
}

/** Return a menu of a harness's modes: first the answer to the auto mode question, then each mode. */
export function modeEntries(offer: Offer): readonly MenuEntry[] {
  if (offer.modes.length === 0) return [];
  return [
    { value: '', label: 'Your auto mode answer' },
    ...offer.modes.map((mode) => ({
      value: mode.value,
      label: mode.value === offer.mode ? `${mode.name} (your default)` : mode.name,
    })),
  ];
}

/** Return the name that a harness shows for `value`, or `value` itself when the harness offered no name for it. */
function nameOf(values: readonly OptionValue[], value: string): string {
  return values.find((option) => option.value === value)?.name ?? value;
}
