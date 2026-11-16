import { GUEST, PERSON } from '../api/types.ts';
import type {
  AgentView,
  ConversationView,
  Deed,
  HarnessOption,
  LabView,
  Move,
  PostView,
  Power,
  PowerView,
} from '../api/types.ts';
import { authorName, labTotal } from './agents.ts';
import { ago, clock, dayClock } from './format.ts';
import { AT_EXIT, AT_TIME_LIMIT } from './settings.ts';

/** A tab of the panel for the coordinator. */
export type Tab = 'talk' | 'powers' | 'log';

/** What a move's words need from the lab. */
export interface Around {
  readonly lab: LabView;
  readonly harnesses: readonly HarnessOption[];
  /** The permission requests that the requests in the conversation name. */
  readonly asks: readonly PostView[];
  readonly now: Date;
}

/** Return the agent that holds the coordinator seat and is in the lab, or `null`. */
export function coordinatorOf(agents: readonly AgentView[]): AgentView | null {
  return agents.find((view) => view.coordinator && view.left === null) ?? null;
}

function waitWords(waits: number): string {
  return `${waits} ${waits === 1 ? 'waits' : 'wait'} for you`;
}

/** Return the name of each tab, with the number of posts that wait for the person on the first. */
export function tabs(name: string, waits: number): readonly (readonly [Tab, string])[] {
  return [
    ['talk', waits > 0 ? `Conversation (${waitWords(waits)})` : 'Conversation'],
    ['powers', `What ${name} may do`],
    ['log', 'Done for you'],
  ];
}

/** Return the words on the button that opens the conversation. */
export function talkLabel(name: string, waits: number): string {
  return waits > 0 ? `Talk to ${name} (${waitWords(waits)})` : `Talk to ${name}`;
}

/**
 * Return whether Verifold starts a turn of the coordinator for a message of the person: it runs the coordinator,
 * the coordinator is not stopped, and the lab has time. An invited agent runs by itself.
 */
export function wakes(holder: AgentView, lab: LabView): boolean {
  const stopped = holder.stopped || holder.activity.state === 'stopped';
  return holder.agent.harness !== GUEST && !stopped && !lab.out_of_time;
}

/** The line under a message of the person in the conversation: the message's post, and where the message is. */
export interface HeardLine {
  readonly post: string;
  readonly text: string;
}

/**
 * Return the line under the person's newest message in the conversation: whether a turn of the coordinator runs,
 * and whether the coordinator has read the message. It is `null` once the coordinator posted in the conversation
 * after the message, and while nobody holds the seat.
 *
 * "Read" means that a result of the coordinator's board tools carried the message to it, as a line or in full.
 * The line says nothing about what the coordinator made of the message.
 */
export function heardLine(view: ConversationView, lab: LabView, now: Date): HeardLine | null {
  const holder = coordinatorOf(lab.agents);
  const posts = view.thread?.posts ?? [];
  const said = posts.filter((item) => item.post.author === PERSON).at(-1);
  if (!holder || !said) return null;
  const replied = posts.some((item) => item.seq > said.seq && item.post.author === holder.agent.id);
  return replied ? null : { post: said.post.id, text: heardWords(holder, lab, said, now) };
}

function heardWords(holder: AgentView, lab: LabView, said: PostView, now: Date): string {
  const { heard, activity } = holder;
  const name = holder.agent.name;
  const read = heard !== null && heard.seq >= said.seq;
  // The time is this message's own only when no later post of the person reached the coordinator.
  const when =
    heard?.seq === said.seq && heard.at ? `read this ${ago(heard.at, now)}` : 'has read this';
  const fact = (who: string): string => `${who} ${read ? when : 'has not read this'}.`;
  if (holder.agent.harness === GUEST) {
    if (activity.state === 'void') {
      return `The invitation of ${name} is void, so ${name} cannot use the board. Invite it again from its profile.`;
    }
    if (lab.out_of_time) {
      return `The lab is out of time, so the board takes no post from ${name}. ${fact(name)}`;
    }
    if (read) return `${name} runs by itself and ${when}.`;
    return activity.state === 'invited'
      ? `${name} has not joined the lab yet.`
      : `${name} runs by itself and has not read this. Verifold cannot wake it.`;
  }
  if (holder.stopped) {
    return `Verifold stopped ${name}, because its harness failed too often. You can start it again in the member list.`;
  }
  if (activity.state === 'stopped') {
    return `${name} is stopped, so no message wakes it.${activity.detail ? ` ${activity.detail}` : ''}`;
  }
  if (lab.out_of_time) return `The lab is out of time, so no turn of ${name} starts. ${fact(name)}`;
  if (holder.in_turn) {
    // The record holds a failure only while no turn started after it, so the harness is on its way back.
    if (holder.error !== null) {
      return `The harness of ${name} failed, and Verifold starts it again.`;
    }
    return `${name} is in a turn and ${read ? when : 'has not read this yet'}.`;
  }
  // A turn that ended after the message can have used the one doorbell that the message rings.
  const rang = holder.turn_ended_at !== null && new Date(holder.turn_ended_at) >= new Date(said.at);
  const rings = !read && activity.state === 'idle' && !rang;
  return `${name} is not in a turn. ${rings ? 'This message wakes it.' : fact('It')}`;
}

/** Return the line above the conversation that names the newest report: who wrote it, and how long ago. */
export function reportLine(report: PostView, agents: readonly AgentView[], now: Date): string {
  return `Where the lab is: ${authorName(agents, report.post.author)} reported ${ago(report.at, now)}.`;
}

/** The name of each power, and what the coordinator does with it. `what` takes the coordinator's name. */
export const POWER_WORDS: Readonly<
  Record<Power, { readonly name: string; readonly what: (name: string) => string }>
> = {
  time: {
    name: 'Give the lab more time',
    what: (name) => `${name} adds minutes while the lab has time.`,
  },
  permissions: {
    name: 'Answer permission requests',
    what: (name) =>
      `${name} allows or refuses, for one time, a command or a tool that another agent asks for.`,
  },
  agents: {
    name: 'Add or remove agents',
    what: (name) =>
      `${name} adds an agent, or removes one. For an agent that it adds, ${name} picks the harness, the model, and the effort. The request and the log show them.`,
  },
  settings: {
    name: 'Change the lab’s settings',
    what: (name) =>
      `${name} sets the agents’ processes to pause or to stop at the time limit, and to stop when Verifold exits. To let them run on after a stop, ${name} asks you.`,
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

/**
 * Return what the coordinator asks for, as the heading of its request.
 *
 * The app writes the sentence, and it holds no text of an agent or a harness: only the kind of the move and, for
 * more time, its number of minutes. `details` gives the rest as labelled values.
 */
export function askLine(move: Move): string {
  switch (move.type) {
    case 'time':
      return `Asks you for ${move.minutes} more minutes`;
    case 'permission':
      return 'Asks you to answer a permission request of another agent';
    case 'add_agent':
      return 'Asks you to add one agent';
    case 'remove_agent':
      return 'Asks you to remove an agent';
    case 'setting':
      return 'Asks you to change a setting of the lab';
    case 'question':
      return 'Asks you to revise the question';
  }
}

/** Return the words on the button that says yes to a request. They hold no text of an agent or a harness. */
export function yesLabel(move: Move): string {
  switch (move.type) {
    case 'time':
      return `Give ${move.minutes} min`;
    case 'permission':
      return 'Give this answer';
    case 'add_agent':
      return 'Add the agent';
    case 'remove_agent':
      return 'Remove the agent';
    case 'setting':
      return 'Change it';
    case 'question':
      return 'Revise the question';
  }
}

/** Return what a move did, in the past, as the app's own sentence. `details` gives the rest. */
export function doneLine(item: PostView): string {
  if (item.post.kind !== 'request') return '';
  const { move } = item.post;
  switch (move.type) {
    case 'time':
      return `Gave the lab ${item.decision?.minutes ?? move.minutes} more minutes`;
    case 'permission':
      return 'Answered a permission request';
    case 'add_agent':
      return 'Added an agent';
    case 'remove_agent':
      return 'Removed an agent';
    case 'setting':
      return 'Changed a setting of the lab';
    case 'question':
      return 'Revised the question';
  }
}

/**
 * One field of a move: the app's label, and the value. `theirs` marks a value that an agent or a harness wrote,
 * which the page shows in a box of its own and never inside a sentence of the app.
 */
export interface Detail {
  readonly label: string;
  readonly value: string;
  readonly theirs?: boolean;
}

const SETTINGS = {
  'jobs.at_time_limit': {
    label: 'The agents’ processes at the time limit, and when you stop the lab',
    choices: AT_TIME_LIMIT,
  },
  'jobs.at_exit': { label: 'The agents’ processes when Verifold exits', choices: AT_EXIT },
} as const;

/** Return when the lab would end with `minutes` more: after its end, or after now when the end has passed. */
export function newEnd(lab: LabView, minutes: number, now: Date): Date | null {
  if (lab.ends_at === null) return null;
  const from = Math.max(new Date(lab.ends_at).getTime(), now.getTime());
  return new Date(from + minutes * 60_000);
}

/**
 * Return every field of a move as a labelled value, in the app's words. A request shows them all, so the person
 * sees the whole of what a yes does. `added` is the agent that the move added, once it did.
 */
export function details(
  move: Move,
  around: Around,
  added: string | null = null,
): readonly Detail[] {
  const { lab, now } = around;
  const name = (id: string): string => authorName(lab.agents, id);
  switch (move.type) {
    case 'time': {
      const end = newEnd(lab, move.minutes, now);
      return [
        ...(lab.ends_at === null
          ? []
          : [{ label: 'The lab ends now at', value: dayClock(lab.ends_at, now) }]),
        ...(end === null
          ? []
          : [{ label: 'With these minutes it ends at', value: dayClock(end.toISOString(), now) }]),
        { label: 'The lab’s cost so far', value: labTotal(lab.agents) },
      ];
    }
    case 'permission': {
      const ask = around.asks.find((item) => item.post.id === move.ask);
      const choice = pickedChoice(move, around.asks);
      return [
        {
          label: 'The agent that asks for the permission',
          value: ask ? name(ask.post.author) : 'Not known',
          theirs: ask !== undefined,
        },
        {
          label: 'The answer that the coordinator would give',
          value: choice ?? move.option,
          theirs: true,
        },
        { label: 'How long the answer holds', value: 'For this one time' },
      ];
    }
    case 'add_agent': {
      const { seat } = move;
      const harness = around.harnesses.find((option) => option.name === seat.harness);
      return [
        { label: 'Harness', value: harness?.title ?? seat.harness, theirs: harness === undefined },
        seat.model
          ? { label: 'Model', value: seat.model, theirs: true }
          : { label: 'Model', value: 'The harness’s default' },
        // The ID of a model that the harness does not list is the coordinator's text, so no name holds it.
        ...(seat.model && !harness?.offer?.models.some((model) => model.value === seat.model)
          ? [
              {
                label: 'About this model',
                value:
                  'The harness does not list this model. The agent’s name says “model not listed” until the harness reports its model.',
              },
            ]
          : []),
        seat.effort
          ? { label: 'Effort', value: seat.effort, theirs: true }
          : { label: 'Effort', value: 'The harness’s default' },
        { label: 'On call', value: seat.on_call ? 'Yes. Only a post for it wakes it.' : 'No' },
        seat.role
          ? { label: 'Role, given by the coordinator', value: seat.role, theirs: true }
          : { label: 'Role', value: 'None' },
        { label: 'Model family', value: harness ? harness.family : 'The family of its harness' },
        { label: 'Mode', value: 'As the lab’s other agents' },
        ...(added ? [{ label: 'The agent that joined', value: name(added), theirs: true }] : []),
      ];
    }
    case 'remove_agent':
      return [
        { label: 'The agent to remove', value: name(move.agent), theirs: true },
        { label: 'For how long', value: 'For good. Its posts stay.' },
      ];
    case 'setting': {
      const setting = SETTINGS[move.key];
      const now_ = setting.choices.find(
        (choice) =>
          choice.value ===
          lab.settings.jobs[move.key === 'jobs.at_exit' ? 'at_exit' : 'at_time_limit'],
      );
      const next = setting.choices.find((choice) => choice.value === move.value);
      return [
        { label: 'Setting', value: setting.label },
        {
          label: 'New value',
          value: next ? `${next.label}. ${next.detail}` : move.value,
          theirs: next === undefined,
        },
        { label: 'The lab’s value now', value: now_?.label ?? 'Not known' },
      ];
    }
    case 'question':
      return [
        { label: 'The new question', value: move.question, theirs: true },
        ...(move.note ? [{ label: 'The coordinator’s note', value: move.note, theirs: true }] : []),
      ];
  }
}

/** Return who decided a move, as the log says it under the move. */
export function decidedLine(item: PostView): string {
  const decision = item.decision;
  if (item.post.kind !== 'request' || !decision) return '';
  if (decision.by === PERSON) return 'You said yes.';
  return `The coordinator did it with the power “${POWER_WORDS[powerOf(item.post.move)].name}”.`;
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

/** Return how a request stands: it waits, a power made its move, the person said yes or no, or it ended. */
export function requestState(item: PostView): RequestState {
  const decision = item.decision;
  if (!decision) return item.waits ? 'waits' : 'ended';
  if (!decision.yes) return 'no';
  return decision.by === PERSON ? 'yes' : 'done';
}

/** Return why a request ended without an answer, as one sentence. */
export function endedLine(item: PostView): string {
  return item.ended === 'ask'
    ? 'This request ended, because the permission request got its answer or ended.'
    : 'This request ended when the coordinator seat changed.';
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
