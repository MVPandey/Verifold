import type { AgentChoice, HarnessOption, StartRequest } from '../api/types.ts';

/** The most agents of one harness that a lab can start, as the server allows. */
export const MAX_AGENTS = 20;

/** The person's choice for one harness on the setup screen. Blank model and effort keep their own settings. */
export interface HarnessPick {
  readonly harness: string;
  readonly count: number;
  readonly model: string;
  readonly effort: string;
}

/** Return the first picks: one agent of each harness that this computer has. */
export function firstPicks(harnesses: readonly HarnessOption[]): readonly HarnessPick[] {
  return harnesses.map((option) => ({
    harness: option.name,
    count: option.available ? 1 : 0,
    model: '',
    effort: '',
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

/** Return what a pick's model menu says when it is closed. */
export function modelSummary(pick: HarnessPick): string {
  const model = pick.model.trim();
  const effort = pick.effort.trim();
  if (!model && !effort) return 'Your default model and effort';
  return `${model || 'Your default model'}, ${effort ? `${effort} effort` : 'default effort'}`;
}
