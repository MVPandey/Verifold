/**
 * Each agent's helpers: the subagents of its harness, from harness events
 * only. A pure fold, with no lab. A helper stops with no result when its
 * harness says so, or when its process ends while it runs: a background
 * subagent lives in the process of its agent, so a stop of that process ends
 * it. Then it is `lost`, its agent hears of it once, and a later event of it
 * shows that the agent resumed it.
 */
import { clip, object } from '../board.ts';
import { readingLimits } from '../lab-tools.ts';
import type { TranscriptUpdate } from '../transcript.ts';
import type { Helper } from './schema.ts';

/** The tool that starts a helper. Claude Code calls it `Agent`, and `Task` before that. Verifold's transcript gives Codex's spawn the same name. */
const helperTools: ReadonlySet<string> = new Set(['Agent', 'Task']);

/** Claude Code answers a helper in the background at once, with this text. The helper goes on. */
const backgroundAnswer = /^Async agent launched/;

/** The next label of an agent's helpers. */
function nextLabel(helpers: readonly Helper[], handle: string): string {
  const last = Math.max(
    0,
    ...helpers.map((helper) => Number(helper.label.split('.').at(-1))),
  );
  return `${handle}.${last + 1}`;
}

/**
 * An agent's helpers after one update of its harness. Returns the same list
 * when the update is about no helper, so the caller saves nothing. `handle`:
 * the agent's name. `launch`: its process.
 */
export function helpersAfter(
  helpers: readonly Helper[],
  update: TranscriptUpdate,
  handle: string,
  launch: string,
  at: string,
): readonly Helper[] {
  const known = helpers.find(
    (helper) => helper.id === update.id || helper.id === update.parent,
  );
  if (!known) {
    if (!update.id || !update.name || !helperTools.has(update.name))
      return helpers;
    return [
      ...helpers,
      {
        id: update.id,
        label: nextLabel(helpers, handle),
        title: clip(update.title ?? '', readingLimits.helper),
        state: 'running' as const,
        at,
        launch,
      },
    ].slice(-readingLimits.helpers);
  }
  // The agent resumed it, or it works on: its own work has the helper as its parent.
  if (known.id === update.parent)
    return known.state === 'running' && known.launch === launch
      ? helpers
      : replaced(helpers, known, { state: 'running', at, launch });
  // A call's first report, or Codex's report of the spawn. The helper goes on.
  if (update.name && update.status !== 'failed') return helpers;
  if (known.state === 'done') return helpers;
  if (update.final)
    return replaced(helpers, known, {
      state: update.status === 'done' ? 'done' : 'lost',
      at,
    });
  if (update.status === undefined) return helpers;
  if (update.output !== undefined && backgroundAnswer.test(update.output))
    return helpers;
  return replaced(helpers, known, {
    state: update.status === 'done' && update.output ? 'done' : 'lost',
    at,
  });
}

function replaced(
  helpers: readonly Helper[],
  known: Helper,
  change: Pick<Helper, 'state' | 'at'> & { readonly launch?: string },
): readonly Helper[] {
  const { told, ...rest } = known;
  const kept = change.state === 'lost' && told ? { told } : {};
  return helpers.map((helper) =>
    helper === known ? { ...rest, ...change, ...kept } : helper,
  );
}

/** The helpers once `live` is the process that runs now, or null for none: what ran in an earlier process is lost. */
export function afterProcess(
  helpers: readonly Helper[],
  live: string | null,
  at: string,
): readonly Helper[] {
  return helpers.some(
    (helper) => helper.state === 'running' && helper.launch !== live,
  )
    ? helpers.map((helper) =>
        helper.state === 'running' && helper.launch !== live
          ? { ...helper, state: 'lost', at }
          : helper,
      )
    : helpers;
}

/** What an agent hears of a helper that stopped with no result. Its title comes from the harness, so it is quoted. */
export function lostLine(helper: Helper): string {
  return `Your helper ${helper.label} ${JSON.stringify(helper.title)} stopped with no result. A background helper stops when your session stops. Start it again if you still need its work.`;
}

/** A saved helper, or null. A harness can write in the project, so every field is checked. */
export function parseHelper(value: unknown): Helper | null {
  const entry = object(value);
  const state = (['running', 'done', 'lost'] as const).find(
    (item) => item === entry?.state,
  );
  return entry &&
    state &&
    typeof entry.id === 'string' &&
    entry.id.length <= 300 &&
    typeof entry.label === 'string' &&
    /^[a-z]+-[1-9]\d{0,3}\.[1-9]\d{0,5}$/.test(entry.label) &&
    typeof entry.title === 'string' &&
    typeof entry.at === 'string' &&
    !Number.isNaN(Date.parse(entry.at)) &&
    typeof entry.launch === 'string'
    ? {
        id: entry.id,
        label: entry.label,
        title: entry.title.slice(0, readingLimits.helper),
        state,
        at: entry.at,
        launch: entry.launch.slice(0, 40),
        ...(entry.told === true ? { told: true as const } : {}),
      }
    : null;
}
