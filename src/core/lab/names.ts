/**
 * The handles of a lab. A new lab names its agents by role: `agent-3` and
 * `checker-1`. `LabState.roles` holds their counts, so a number says how many
 * came before it and nothing about the harness. A lab from before these names
 * has no `roles`: it keeps `claude-2` and `codex-1`, counted for each harness.
 * `handlePattern` in ../lab-tools.ts accepts both. Nothing here holds state.
 */
import type { HarnessName } from '../harness.ts';
import { hostName } from '../session.ts';
import type { AgentRecord, Direction, LabState } from './schema.ts';

/** The highest number that `handlePattern` accepts. */
const mostHandles = 9999;

/**
 * The next handle of a lab, with the counts to save with it. Null when the
 * lab used every number. `role`: an agent that owns a direction, or a checker.
 * `host`: the harness, which counts only in a lab from before role names.
 */
export function nextHandle(
  state: Pick<LabState, 'handles' | 'roles'>,
  role: 'agents' | 'checkers',
  host: HarnessName,
): {
  readonly handle: string;
  readonly counts: Partial<Pick<LabState, 'handles' | 'roles'>>;
} | null {
  if (state.roles) {
    const count = state.roles[role] + 1;
    return count > mostHandles
      ? null
      : {
          handle: `${role === 'agents' ? 'agent' : 'checker'}-${count}`,
          counts: { roles: { ...state.roles, [role]: count } },
        };
  }
  const count = state.handles[host] + 1;
  return count > mostHandles
    ? null
    : {
        handle: `${host}-${count}`,
        counts: { handles: { ...state.handles, [host]: count } },
      };
}

/**
 * An agent as other agents read it: its handle, its harness, and the job and
 * team of its direction. A check uses the other harness, so a peer's harness
 * always shows. An agent wrote the job and the team, so they are quoted.
 */
export function agentLine(
  agent: Pick<AgentRecord, 'handle' | 'host'>,
  direction: Pick<Direction, 'job' | 'team'>,
): string {
  return [
    `${agent.handle} (${hostName(agent.host)})`,
    ...(direction.job ? [`job ${JSON.stringify(direction.job)}`] : []),
    ...(direction.team ? [`team ${JSON.stringify(direction.team)}`] : []),
  ].join(', ');
}
