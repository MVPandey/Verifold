/**
 * Which directions and agents a snapshot keeps when it cannot keep them all.
 * These read the lists as the lab holds them and keep their order. Nothing
 * here holds state.
 */

/**
 * The directions that fit in `max`: the open ones first, then the newest.
 * A list holds them oldest first, so its last entries are the newest.
 */
export function keptDirections<T extends { readonly state: string }>(
  list: readonly T[],
  max: number,
): T[] {
  if (list.length <= max) return [...list];
  if (!max) return [];
  const open = list.filter((entry) => entry.state === 'open');
  const ended = list.filter((entry) => entry.state !== 'open');
  const room = max - open.length;
  const kept = new Set([
    ...open.slice(-max),
    ...(room > 0 ? ended.slice(-room) : []),
  ]);
  return list.filter((entry) => kept.has(entry));
}

/**
 * The agents of a snapshot: each agent of a kept direction, so a row always
 * has its agent's name, and each running checker. The newest of the other
 * checkers fill what is left of `max`. `max` 0 keeps none, so the smallest
 * snapshot always fits.
 */
export function keptAgents<
  T extends { readonly direction: string | null; readonly status: string },
>(agents: readonly T[], directions: ReadonlySet<string>, max: number): T[] {
  if (!max) return [];
  const must = agents.filter((agent) =>
    agent.direction === null
      ? agent.status === 'running'
      : directions.has(agent.direction),
  );
  const rest = agents.filter(
    (agent) => agent.direction === null && agent.status !== 'running',
  );
  const room = max - must.length;
  const kept = new Set([...must, ...(room > 0 ? rest.slice(-room) : [])]);
  return agents.filter((agent) => kept.has(agent));
}
