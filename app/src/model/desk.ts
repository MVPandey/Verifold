import type { AgentView, DeskAction, DeskView, PostView } from '../api/types.ts';
import { authorName } from './agents.ts';
import { clock } from './format.ts';

/** The panel for the desk has no view before a lab starts. */
export const NO_DESK: DeskView = { desk: null, thread: null, actions: [] };

/** Return the agent that holds the desk seat and is in the lab, or `null`. */
export function deskOf(agents: readonly AgentView[]): AgentView | null {
  return agents.find((view) => view.desk === true && view.left === null) ?? null;
}

/** Return whether a post is the desk's post for the person: it rests on a post of the person in the desk chat. */
export function byDesk(post: PostView['post']): boolean {
  return post.on !== undefined && post.on !== null;
}

/**
 * Return the one line that the desk chat shows for an action under the person's message that it rests on. The app
 * writes the line, so no text of an agent stands in it: only IDs, names of agents, and a time.
 */
export function actionLine(action: DeskAction, agents: readonly AgentView[]): string {
  switch (action.kind) {
    case 'post':
      return `Posted for you in ${action.thread ?? 'a thread'}`;
    case 'round':
      return `Opened a round for you in ${action.thread ?? 'a thread'}`;
    case 'question':
      return 'Revised the question for you';
    case 'deliverable': {
      const id = action.deliverable ?? 'a deliverable';
      if (action.change === 'added') return `Stated the deliverable ${id} for you`;
      if (action.change === 'removed') return `Removed the deliverable ${id} for you`;
      return `Changed the sentence of the deliverable ${id} for you`;
    }
    case 'time':
      return action.ends_at
        ? `Set the lab to end at ${clock(action.ends_at)}`
        : 'Set the lab’s time';
    case 'interrupt':
      return `Ended the turn of ${action.agent ? authorName(agents, action.agent) : 'an agent'}, so it reads its news now`;
  }
}

/** Return the actions of the desk that rest on one post of the person, oldest first. */
export function actionsOn(view: DeskView, postId: string): readonly DeskAction[] {
  return view.actions.filter((action) => action.on === postId);
}
