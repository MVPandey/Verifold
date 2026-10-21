import type { Lab } from '../protocol/api.ts';
import { href } from './route.ts';

/**
 * Desktop notifications, the decisions only. A note comes for each call that
 * waits for the person and each direction that holds up or is ruled out,
 * once, while the page is in the background, and only after the person
 * turned notes on. Events that the page found when it loaded never notify.
 */

/**
 * - `off`: the person has not turned notes on.
 * - `on`: they did, and the browser allows notes.
 * - `blocked`: the browser blocks notes from this page.
 * - `unavailable`: the browser has no notes at all.
 */
export type NotifyState = 'off' | 'on' | 'blocked' | 'unavailable';

/** The browser's permission, or `unsupported` without the Notification API. */
export type Permission = 'default' | 'granted' | 'denied' | 'unsupported';

/** The setting from the person's saved choice and the browser's permission. */
export function notifyState(
  chosen: boolean,
  permission: Permission,
): NotifyState {
  if (permission === 'unsupported') return 'unavailable';
  if (permission === 'denied') return 'blocked';
  return chosen && permission === 'granted' ? 'on' : 'off';
}

/** One desktop note: its key (one note per key), its words, and the page that a click opens. */
export interface Note {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly route: string;
}

/** What the page remembers: whether it saw a lab yet, and the keys of the events that it saw. */
export interface NotifyMemory {
  readonly primed: boolean;
  readonly seen: ReadonlySet<string>;
}

export const freshMemory: NotifyMemory = { primed: false, seen: new Set() };

/** The events of a lab that a note can be about, as notes. */
export function events(lab: Lab, project: string): readonly Note[] {
  return [
    ...lab.needsYou.map((call) => ({
      key: `call:${call.id}`,
      title: `${project} needs you`,
      body: call.question,
      route: href.call(call.id),
    })),
    ...lab.directions.flatMap((direction) =>
      direction.verdict === 'holds-up' || direction.verdict === 'ruled-out'
        ? [
            {
              key: `settled:${direction.id}:${direction.verdict}`,
              title: project,
              body:
                direction.verdict === 'holds-up'
                  ? `"${direction.title}" holds up.`
                  : `"${direction.title}" is ruled out.`,
              route: href.direction(direction.id),
            },
          ]
        : [],
    ),
  ];
}

/**
 * The notes for a new snapshot, and what the page remembers after it. The
 * first lab that the page sees only primes the memory. After that, each new
 * event notifies once, if notes are on and the page is in the background.
 * An event that comes while the person looks is seen, and never notifies
 * later.
 */
export function notesFor(
  memory: NotifyMemory,
  lab: Lab | null,
  project: string,
  background: boolean,
  on: boolean,
): { readonly notes: readonly Note[]; readonly memory: NotifyMemory } {
  if (!lab) return { notes: [], memory };
  const seen = new Set(memory.seen);
  const fresh = events(lab, project).filter((note) => !seen.has(note.key));
  for (const note of fresh) seen.add(note.key);
  return {
    notes: memory.primed && on && background ? fresh : [],
    memory: { primed: true, seen },
  };
}

/** The line about notes under the lab, and whether it offers to turn them on or off. */
export function notifyLine(state: NotifyState): {
  readonly text: string;
  readonly button: string | null;
} | null {
  switch (state) {
    case 'on':
      return {
        text: 'Desktop notifications are on: one for each call and each settled direction while this page is in the background.',
        button: 'Turn off',
      };
    case 'off':
      return {
        text: 'Get a desktop notification for each call and each settled direction while this page is in the background.',
        button: 'Turn on',
      };
    case 'blocked':
      return {
        text: 'The browser blocks notifications from this page. Allow them in its site settings.',
        button: null,
      };
    case 'unavailable':
      return null;
  }
}
