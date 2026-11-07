import type { AgentView, PostView } from '../api/types.ts';

/** Return the asks to the person with the ones that pause an agent first, and otherwise in the order that they came. */
export function orderNeeds(
  needs: readonly PostView[],
  agents: readonly AgentView[],
): readonly PostView[] {
  const waiting = new Set(
    agents.filter((view) => view.activity.state === 'waiting').map((view) => view.agent.id),
  );
  return [...needs].sort(
    (first, second) =>
      Number(waiting.has(second.post.author)) - Number(waiting.has(first.post.author)),
  );
}
