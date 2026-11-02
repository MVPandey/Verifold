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
import type { HelperEvent } from '../transcript.ts';
import type { Helper } from './schema.ts';

/** The next label of an agent's helpers. */
function nextLabel(helpers: readonly Helper[], handle: string): string {
  const last = Math.max(
    0,
    ...helpers.map((helper) => Number(helper.label.split('.').at(-1))),
  );
  return `${handle}.${last + 1}`;
}

/**
 * The list with room for one more, or null when the list is full of what must
 * stay. A helper that ended goes first, then a lost one that its agent heard
 * of. A helper that runs, or a lost one that its agent has not heard of, never
 * goes.
 */
function withRoom(helpers: readonly Helper[]): readonly Helper[] | null {
  if (helpers.length < readingLimits.helpers) return helpers;
  const gone =
    helpers.find((helper) => helper.state === 'done') ??
    helpers.find((helper) => helper.state === 'lost' && helper.told);
  return gone ? helpers.filter((helper) => helper !== gone) : null;
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

/**
 * An agent's helpers after one event. Returns the same list when the event
 * changes nothing, so the caller saves nothing. A list full of what must stay
 * takes no new helper. `handle`: the agent's name. `launch`: its process.
 */
export function helpersAfter(
  helpers: readonly Helper[],
  event: HelperEvent,
  handle: string,
  launch: string,
  at: string,
): readonly Helper[] {
  const known = helpers.find((helper) => helper.id === event.id);
  if (event.type === 'started') {
    const room = known ? null : withRoom(helpers);
    return room
      ? [
          ...room,
          {
            id: event.id,
            label: nextLabel(helpers, handle),
            title: clip(event.title, readingLimits.helper),
            state: 'running',
            at,
            launch,
          },
        ]
      : helpers;
  }
  if (!known) return helpers;
  // The agent resumed it, or it works on.
  if (event.type === 'working')
    return known.state === 'running' && known.launch === launch
      ? helpers
      : replaced(helpers, known, { state: 'running', at, launch });
  return known.state === 'done'
    ? helpers
    : replaced(helpers, known, { state: event.result ? 'done' : 'lost', at });
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
