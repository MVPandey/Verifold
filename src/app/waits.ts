import type { Lab, Wait } from '../protocol/api.ts';
import { roleName } from '../ui/lab-lines.ts';

/** Who a wait is on, as a name: "you" or "Agent 2". */
function onName(wait: Wait): string {
  return wait.onHandle ? roleName(wait.onHandle) : 'you';
}

/** The line on an agent's row: its oldest wait, such as "Waits on Agent 2: Does seed 2 agree?". Null when it waits on no one. */
export function waitLine(lab: Lab, agent: string): string | null {
  const wait = lab.waits?.find((entry) => entry.waiter === agent);
  return wait ? `Waits on ${onName(wait)}: ${wait.subject}` : null;
}

/** The asks that wait for the person, the oldest first. */
export function askedOfYou(lab: Lab): readonly Wait[] {
  return (lab.waits ?? []).filter(
    (wait) => wait.on === 'person' && wait.reason === 'ask',
  );
}
