import type { LabView, PostView } from '../api/types.ts';
import { isPermission } from './posts.ts';

/** Return whether an ask pauses its agent: a permission request while the agent waits and the lab has time. */
export function pauses(item: PostView, lab: LabView): boolean {
  const agent = lab.agents.find((view) => view.agent.id === item.post.author);
  return isPermission(item.post) && agent?.activity.state === 'waiting' && !lab.out_of_time;
}

/** Return the asks to the person with the ones that pause an agent first, and otherwise in the order that they came. */
export function orderNeeds(needs: readonly PostView[], lab: LabView): readonly PostView[] {
  return [...needs].sort(
    (first, second) => Number(pauses(second, lab)) - Number(pauses(first, lab)),
  );
}
