import type { Lab, ProjectCompute } from '../protocol/api.ts';
import { usd } from './format.ts';
import { gpuName, podAsker, waitingPods } from './pods.ts';
import { href } from './route.ts';

/**
 * Desktop notifications, the decisions only. A note comes for each call and
 * each pod that waits for the person, and each direction that holds up or is
 * ruled out, once, while the page is in the background, and only after the
 * person turned notes on. Events that the page found when it loaded never notify.
 * The events come from the snapshot's `notify` lists, which no level cuts,
 * so a smaller snapshot neither hides a new event nor makes an old one new.
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

/**
 * The events of a lab that a note can be about, as notes. An event that the
 * snapshot's lists leave out gets plain words and opens the page that can
 * show it. An older server sends no `notify`: then its lists are the events.
 * Each pod that waits for the person is an event too.
 */
export function events(
  lab: Lab,
  project: string,
  compute?: ProjectCompute,
): readonly Note[] {
  const calls = new Map(lab.needsYou.map((call) => [call.id, call]));
  const titles = new Map(
    lab.directions.map((direction) => [direction.id, direction.title]),
  );
  const settled = (verdict: 'holds-up' | 'ruled-out'): readonly string[] =>
    lab.directions
      .filter((direction) => direction.verdict === verdict)
      .map((direction) => direction.id);
  const feed = lab.notify ?? {
    calls: [...calls.keys()],
    holdsUp: settled('holds-up'),
    ruledOut: settled('ruled-out'),
  };
  const direction = (id: string, verdict: 'holds-up' | 'ruled-out'): Note => {
    const title = titles.get(id);
    const name = title ? `"${title}"` : `Direction ${id}`;
    return {
      key: `settled:${id}:${verdict}`,
      title: project,
      body:
        verdict === 'holds-up' ? `${name} holds up.` : `${name} is ruled out.`,
      route: href.direction(id),
    };
  };
  return [
    ...feed.calls.map((id) => {
      const call = calls.get(id);
      return {
        key: `call:${id}`,
        title: `${project} needs you`,
        body: call?.question ?? `Call ${id} waits for your answer.`,
        route: call ? href.call(id) : href.lab,
      };
    }),
    ...(compute
      ? waitingPods(compute).map((pod) => {
          const who = podAsker(pod, lab);
          return {
            key: `pod:${pod.id}`,
            title: `${project} needs you`,
            body: `${who} ${who === 'You' ? 'asked' : 'asks'} for a pod with one ${gpuName(pod.gpu, compute)}, up to ${usd(pod.maxUsd)}.`,
            route: href.lab,
          };
        })
      : []),
    ...feed.holdsUp.map((id) => direction(id, 'holds-up')),
    ...feed.ruledOut.map((id) => direction(id, 'ruled-out')),
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
  compute?: ProjectCompute,
): { readonly notes: readonly Note[]; readonly memory: NotifyMemory } {
  if (!lab) return { notes: [], memory };
  const seen = new Set(memory.seen);
  const fresh = events(lab, project, compute).filter(
    (note) => !seen.has(note.key),
  );
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
        text: 'Desktop notifications are on: one for each call, each pod request, and each settled direction while this page is in the background.',
        button: 'Turn off',
      };
    case 'off':
      return {
        text: 'Get a desktop notification for each call, each pod request, and each settled direction while this page is in the background.',
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
