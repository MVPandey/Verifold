import { PERSON } from '../api/types.ts';
import type {
  AgentView,
  ConversationView,
  Deed,
  HarnessOption,
  Move,
  PostView,
  Power,
  PowerView,
} from '../api/types.ts';
import { authorName, harnessTitle } from './agents.ts';
import { clock } from './format.ts';
import { AT_EXIT, AT_TIME_LIMIT } from './settings.ts';

/** A tab of the panel for the coordinator. */
export type Tab = 'talk' | 'powers' | 'log';

/** What a move's sentences need from the lab. */
export interface Around {
  readonly agents: readonly AgentView[];
  readonly harnesses: readonly HarnessOption[];
  /** The permission requests that the requests in the conversation name. */
  readonly asks: readonly PostView[];
}

/** Return the agent that holds the coordinator seat and is in the lab, or `null`. */
export function coordinatorOf(agents: readonly AgentView[]): AgentView | null {
  return agents.find((view) => view.coordinator && view.left === null) ?? null;
}

/** Return the name of each tab, with the number of posts that wait for the person on the first. */
export function tabs(name: string, waits: number): readonly (readonly [Tab, string])[] {
  return [
    [
      'talk',
      waits > 0
        ? `Conversation (${waits} ${waits === 1 ? 'waits' : 'wait'} for you)`
        : 'Conversation',
    ],
    ['powers', `What ${name} may do`],
    ['log', 'Done for you'],
  ];
}

/** Return the words on the button that opens the conversation. */
export function talkLabel(name: string, waits: number): string {
  return waits > 0
    ? `Talk to ${name} (${waits} ${waits === 1 ? 'waits' : 'wait'} for you)`
    : `Talk to ${name}`;
}

/** The name of each power, and what the coordinator does with it. `what` takes the coordinator's name. */
export const POWER_WORDS: Readonly<
  Record<Power, { readonly name: string; readonly what: (name: string) => string }>
> = {
  time: {
    name: 'Give the lab more time',
    what: (name) => `${name} adds minutes before the lab’s time runs out.`,
  },
  permissions: {
    name: 'Answer permission requests',
    what: (name) =>
      `${name} allows or refuses, for one time, a command or a tool that another agent asks for.`,
  },
  agents: {
    name: 'Add or remove agents',
    what: (name) => `${name} adds an agent, or removes one.`,
  },
  settings: {
    name: 'Change the lab’s settings',
    what: (name) =>
      `${name} changes what happens to the agents’ processes at the time limit and when Verifold exits.`,
  },
  question: {
    name: 'Revise the question',
    what: (name) => `${name} rewrites the question. Earlier versions stay readable.`,
  },
};

/** Return the line under a power that is on: since when, and how often the coordinator used it. */
export function powerLine(power: PowerView): string | null {
  if (!power.on || power.since === null) return null;
  const used = power.used === 1 ? 'Used 1 time.' : `Used ${power.used} times.`;
  return `On since ${clock(power.since)}. ${used}`;
}

/** Return the choice on a permission request that a move picks, as the ask names it, or `null`. */
export function pickedChoice(move: Move, asks: readonly PostView[]): string | null {
  if (move.type !== 'permission') return null;
  const ask = asks.find((item) => item.post.id === move.ask)?.post;
  if (ask?.kind !== 'ask' || ask.shown?.type !== 'permission') return null;
  const at = ask.shown.ids.indexOf(move.option);
  return ask.choices[at] ?? null;
}

function askAuthor(move: Move, around: Around): string {
  const ask =
    move.type === 'permission' ? around.asks.find((item) => item.post.id === move.ask) : null;
  return ask ? authorName(around.agents, ask.post.author) : 'an agent';
}

function settingWords(move: Move & { readonly type: 'setting' }): string {
  const [subject, choices] =
    move.key === 'jobs.at_time_limit'
      ? ['At the time limit, for the agents’ processes', AT_TIME_LIMIT]
      : ['When Verifold exits, for the agents’ processes', AT_EXIT];
  const label = choices.find((choice) => choice.value === move.value)?.label ?? move.value;
  return `${subject}: ${label}`;
}

function seatWords(move: Move & { readonly type: 'add_agent' }, around: Around): string {
  const { seat } = move;
  const parts = [
    harnessTitle(around.harnesses, seat.harness),
    seat.model,
    seat.effort ? `${seat.effort} effort` : null,
    seat.role ? `role: ${seat.role}` : null,
    seat.on_call ? 'on call' : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Return what the coordinator asks for, as the heading of its request. */
export function askLine(move: Move, around: Around): string {
  switch (move.type) {
    case 'time':
      return `Asks you for ${move.minutes} more minutes`;
    case 'permission': {
      const choice = pickedChoice(move, around.asks);
      const who = askAuthor(move, around);
      return choice
        ? `Asks you to answer “${choice}” to a permission request of ${who}`
        : `Asks you to answer a permission request of ${who}`;
    }
    case 'add_agent':
      return `Asks you to add an agent: ${seatWords(move, around)}`;
    case 'remove_agent':
      return `Asks you to remove ${authorName(around.agents, move.agent)}`;
    case 'setting':
      return `Asks you to change a setting. ${settingWords(move)}`;
    case 'question':
      return 'Asks you to revise the question';
  }
}

/** Return the words on the button that says yes to a request. */
export function yesLabel(move: Move, around: Around): string {
  switch (move.type) {
    case 'time':
      return `Give ${move.minutes} min`;
    case 'permission':
      return pickedChoice(move, around.asks) ?? 'Answer it so';
    case 'add_agent':
      return 'Add the agent';
    case 'remove_agent':
      return `Remove ${authorName(around.agents, move.agent)}`;
    case 'setting':
      return 'Change it';
    case 'question':
      return 'Revise the question';
  }
}

/** Return what a move did, in the past, for the log and for a request that a power decided. */
export function doneLine(item: PostView, agent: string | null, around: Around): string {
  if (item.post.kind !== 'request') return '';
  const { move } = item.post;
  switch (move.type) {
    case 'time':
      return `Gave the lab ${item.decision?.minutes ?? move.minutes} more minutes`;
    case 'permission': {
      const choice = pickedChoice(move, around.asks);
      const who = askAuthor(move, around);
      return choice
        ? `Answered “${choice}” to a permission request of ${who}`
        : `Answered a permission request of ${who}`;
    }
    case 'add_agent':
      return `Added an agent: ${agent ? authorName(around.agents, agent) : seatWords(move, around)}`;
    case 'remove_agent':
      return `Removed ${authorName(around.agents, move.agent)}`;
    case 'setting':
      return `Changed a setting. ${settingWords(move)}`;
    case 'question':
      return 'Revised the question';
  }
}

/** Return who decided a move, as the log says it under the move. */
export function decidedLine(item: PostView, around: Around): string {
  const decision = item.decision;
  if (item.post.kind !== 'request' || !decision) return '';
  if (decision.by === PERSON) return 'You said yes.';
  return `${authorName(around.agents, decision.by)} did it with the power “${POWER_WORDS[powerOf(item.post.move)].name}”.`;
}

/** Return the power that covers a move, as `power_of` in the server's `protocol/moves.py`. */
export function powerOf(move: Move): Power {
  switch (move.type) {
    case 'time':
      return 'time';
    case 'permission':
      return 'permissions';
    case 'add_agent':
    case 'remove_agent':
      return 'agents';
    case 'setting':
      return 'settings';
    case 'question':
      return 'question';
  }
}

/** Return the words on the button that takes a move back, or `null` when the move has no way back. */
export function undoLabel(deed: Deed): string | null {
  return deed.undo === 'remove_agent'
    ? 'Remove it'
    : deed.undo === 'take_minutes'
      ? 'Take the minutes back'
      : null;
}

/** How a request stands in the conversation. */
export type RequestState = 'waits' | 'done' | 'yes' | 'no' | 'ended';

/** Return how a request stands: it waits, a power made its move, the person said yes or no, or it ended with the seat. */
export function requestState(item: PostView): RequestState {
  const decision = item.decision;
  if (!decision) return item.waits ? 'waits' : 'ended';
  if (!decision.yes) return 'no';
  return decision.by === PERSON ? 'yes' : 'done';
}

/** Return the deed of a request, or `null` when the request made no move. */
export function deedOf(view: ConversationView, requestId: string): Deed | null {
  return view.deeds.find((deed) => deed.request.post.id === requestId) ?? null;
}

/** Return the minutes that the person typed for "another amount", or `null` when they are no whole number in range. */
export function minutesOf(typed: string): number | null {
  const minutes = Number(typed.trim());
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 7 * 24 * 60 ? minutes : null;
}
