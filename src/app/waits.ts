import type { Lab, Wait } from '../protocol/api.ts';
import { roleName } from '../ui/lab-lines.ts';

/** Who a wait is on, as a name: "you" or "Agent 2". */
function onName(wait: Wait): string {
  return wait.onHandle ? roleName(wait.onHandle) : 'you';
}

/** The waits that a row shows. An agent that ended waits on no one, and a reopen brings its waits back. */
export function rowWaits(
  lab: Pick<Lab, 'waits' | 'directions'>,
): readonly Wait[] {
  const ended = new Set(
    lab.directions
      .filter((direction) => direction.state !== 'open')
      .map((direction) => direction.agent),
  );
  return (lab.waits ?? []).filter((wait) => !ended.has(wait.waiter));
}

/** The line on an agent's row: its oldest wait, such as "Waits on Agent 2: Does seed 2 agree?". Null when it waits on no one. */
export function waitLine(lab: Lab, agent: string): string | null {
  const wait = rowWaits(lab).find((entry) => entry.waiter === agent);
  return wait ? `Waits on ${onName(wait)}: ${wait.subject}` : null;
}

/** The asks that wait for the person, the oldest first. */
export function askedOfYou(lab: Lab): readonly Wait[] {
  return (lab.waits ?? []).filter(
    (wait) => wait.on === 'person' && wait.reason === 'ask',
  );
}
