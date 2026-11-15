import type { Api } from '../api/client.ts';
import { PERSON } from '../api/types.ts';
import type { AgentView, Outcomes, Picture, PostRef, ProfileEdit } from '../api/types.ts';

/** The gray of the picture of an agent that left. */
export const GONE_COLOR = '#8d8a9c';

/** How an agent's picture shows: what it chose, and what the lab knows about its seat and its status. */
export interface PictureLook {
  /** The picture that the agent chose, or `null` for the dashed outline with the seat's number. */
  readonly picture: Picture | null;
  /** The number of the agent's seat among the seats with the same label. */
  readonly number: number;
  /** Whether the picture is an outline: the agent is on call. */
  readonly hollow: boolean;
  /** Whether the picture is gray and faded: the agent left. */
  readonly gone: boolean;
  /** The dot on the picture: green in a turn, yellow while the agent waits for the person. */
  readonly dot: 'live' | 'wait' | null;
}

/** Return the number at the end of a seat's label, such as 2 for "Codex · gpt-6.1-sol 2", or else 1. */
export function seatNumber(seat: string): number {
  const found = / ([1-9][0-9]*)$/.exec(seat)?.[1];
  return found ? Number(found) : 1;
}

/** Return how an agent's picture shows. */
export function pictureLook(view: AgentView): PictureLook {
  const waits = view.need === 'approval' || view.need === 'answer';
  return {
    picture: view.picture,
    number: seatNumber(view.seat),
    hollow: view.on_call,
    gone: view.left !== null,
    dot: waits ? 'wait' : view.in_turn ? 'live' : null,
  };
}

/** Return the seat's label to show beside a name, or `null` when the label is the name. */
export function seatBeside(view: AgentView): string | null {
  return view.seat && view.seat !== view.agent.name ? view.seat : null;
}

/** Return the marks of the seats that an agent holds, in their fixed order. */
export function seatMarks(view: AgentView): readonly string[] {
  return [
    view.coordinator ? 'Coordinator' : null,
    view.reviewer ? 'Reviewer seat' : null,
    view.on_call ? 'On call' : null,
  ].filter((mark) => mark !== null);
}

/** Return who made a change, as the start of a sentence: the person, or an agent that held the coordinator seat. */
function actor(by: string): string {
  return by === PERSON ? 'You' : 'The coordinator';
}

/**
 * Return an agent's roles: the one that somebody gave its seat, with who gave it, and then its own. A role that
 * the agent repeats shows once, as the given one.
 */
export function roles(view: AgentView): readonly string[] {
  const giver = view.given_by === null || view.given_by === PERSON ? 'you' : 'the coordinator';
  return [
    view.given_role ? `${view.given_role} (given by ${giver})` : null,
    view.role && view.role !== view.given_role ? view.role : null,
  ].filter((role) => role !== null);
}

/** Return one change to an agent's profile in plain words, with the text from before. */
export function editLine(edit: ProfileEdit): string {
  const who = actor(edit.by);
  const before = edit.before ? ` Before: ${edit.before}` : '';
  switch (edit.part) {
    case 'name':
      return edit.after
        ? `${who} changed the name to “${edit.after}”.${before}`
        : `${who} took back the name “${edit.before}”.`;
    case 'about':
      return `${who} ${edit.after ? 'rewrote' : 'took back'} the about line.${before}`;
    case 'picture':
      return `${who} took back the picture.`;
    case 'role':
      if (!edit.after) return `${who} took back the role “${edit.before}”.`;
      return edit.before
        ? `${who} changed the given role from “${edit.before}” to “${edit.after}”.`
        : `${who} gave the role “${edit.after}”.`;
    case 'flag':
      return edit.after
        ? `${who} flagged this profile: ${edit.after}`
        : `${who} took back the flag.${before}`;
  }
}

/** Return the picture that a change took back, from its three parts in words, or `null` when they name none. */
export function pictureBefore(edit: ProfileEdit): Picture | null {
  const [shape, color, symbol, ...rest] = edit.part === 'picture' ? edit.before.split(', ') : [];
  if (!shape || !color || !symbol || rest.length > 0) return null;
  // The drawing ignores a shape or a symbol that it does not know, so the words need no further check.
  return { shape, color, symbol } as Picture;
}

/** One count of what became of an agent's posts, with the posts. */
export interface OutcomeLine {
  readonly label: string;
  readonly posts: readonly PostRef[];
}

/** Return what became of an agent's posts as four plain counts. A count of zero shows as zero. */
export function outcomeLines(outcomes: Outcomes): readonly OutcomeLine[] {
  return [
    { label: 'Results built on', posts: outcomes.built_on },
    { label: 'Checked and held', posts: outcomes.held },
    { label: 'Refuted or ruled out', posts: outcomes.refuted },
    { label: 'Open asks', posts: outcomes.open_asks },
  ];
}

/** One thing that the person can do to an agent's seat or profile: the words on its button, and the call. */
export interface SeatAction {
  readonly label: string;
  readonly run: (api: Pick<Api, 'changeSeat' | 'changeProfile'>) => Promise<unknown>;
}

/**
 * Return the ways to take back what an agent chose: its name, its about line, and its picture, each only when
 * there is one to take back.
 */
export function takeBacks(view: AgentView): readonly SeatAction[] {
  const id = view.agent.id;
  const actions: SeatAction[] = [];
  if (view.chosen_name) {
    actions.push({
      label: 'Take back the name',
      run: (api) => api.changeProfile(id, { reset_name: true }),
    });
  }
  if (view.about) {
    actions.push({
      label: 'Take back the about line',
      run: (api) => api.changeProfile(id, { reset_about: true }),
    });
  }
  if (view.picture) {
    actions.push({
      label: 'Take back the picture',
      run: (api) => api.changeProfile(id, { reset_picture: true }),
    });
  }
  return actions;
}

/** Return the person's three switches for an agent's seat: on call, the coordinator seat, and a reviewer seat. */
export function seatSwitches(view: AgentView): readonly SeatAction[] {
  const id = view.agent.id;
  return [
    {
      label: view.on_call ? 'Take off call' : 'Put on call',
      run: (api) => api.changeSeat(id, { on_call: !view.on_call }),
    },
    {
      label: view.coordinator ? 'Remove as coordinator' : 'Make coordinator',
      run: (api) => api.changeSeat(id, { coordinator: !view.coordinator }),
    },
    {
      label: view.reviewer ? 'Take back the reviewer seat' : 'Give a reviewer seat',
      run: (api) => api.changeSeat(id, { reviewer: !view.reviewer }),
    },
  ];
}

/** The most characters of a role, as the server takes it. */
export const ROLE_LIMIT = 40;

/**
 * Return the way to give an agent's seat the role in `text`, or `null` when the text is empty, too long, or the
 * role that the seat has.
 */
export function giveRole(view: AgentView, text: string): SeatAction | null {
  const role = text.trim();
  if (!role || role.length > ROLE_LIMIT || role === view.given_role) return null;
  return {
    label: view.given_role ? 'Change the role' : 'Give the role',
    run: (api) => api.changeProfile(view.agent.id, { role }),
  };
}

/** Return the way to take back the role that an agent's seat has, or `null` when it has none. */
export function takeBackRole(view: AgentView): SeatAction | null {
  if (!view.given_role) return null;
  return {
    label: 'Take back the role',
    run: (api) => api.changeProfile(view.agent.id, { role: '' }),
  };
}
