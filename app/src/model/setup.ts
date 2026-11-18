import type {
  AgentChoice,
  HarnessOption,
  Offer,
  OptionValue,
  Power,
  SavedChoice,
  SetupChoices,
  SetupDefaults,
  StartRequest,
} from '../api/types.ts';
import { duration, money, tokens } from './format.ts';

/** The most agents that a lab starts in all, as the server allows. */
export const MAX_AGENTS = 20;

/**
 * One seat that the person sets up: some agents of one harness with one model, and the facts of the seat. A harness
 * can have several seats.
 *
 * A blank model or effort keeps the person's own setting. A blank mode follows the answer to the auto mode question.
 * A blank role gives none, and a blank family takes the family of the harness.
 */
export interface Seat {
  readonly harness: string;
  readonly count: number;
  readonly model: string;
  /** The person types the model, because the harness's list does not hold the one that they want. */
  readonly typed: boolean;
  readonly effort: string;
  readonly mode: string;
  readonly role: string;
  readonly family: string;
  readonly onCall: boolean;
  readonly coordinator: boolean;
  /** The powers that the person switches on for the coordinator from the start. Only the coordinator's seat sends them. */
  readonly powers: readonly Power[];
  /** Whether the seat is the lab's desk. A lab has one desk, its seat holds one agent, and it holds no other seat. */
  readonly desk: boolean;
}

/** Return a seat of a harness with the person's own settings and no facts. */
export function newSeat(harness: string, count = 1): Seat {
  return {
    harness,
    count,
    model: '',
    typed: false,
    effort: '',
    mode: '',
    role: '',
    family: '',
    onCall: false,
    coordinator: false,
    powers: [],
    desk: false,
  };
}

/** One entry in a menu: the value to send, or `''` to send nothing, and the text that the menu shows for it. */
export interface MenuEntry {
  readonly value: string;
  readonly label: string;
}

/**
 * Return the first seats: the person's saved choices for new labs, or one agent of each harness that this computer
 * has. A harness that this computer doesn't have gets a seat with no agents.
 */
export function firstSeats(
  harnesses: readonly HarnessOption[],
  defaults: SetupDefaults,
): readonly Seat[] {
  let room = MAX_AGENTS;
  return harnesses.flatMap((option): readonly Seat[] => {
    const saved = (defaults.agents ?? []).filter((choice) => choice.harness === option.name);
    if (defaults.agents === null || saved.length === 0 || !option.available) {
      // One of each harness that this computer has, for as long as the lab has room. With saved choices, a
      // harness that they leave out starts none.
      const count = defaults.agents === null && option.available && room > 0 ? 1 : 0;
      room -= count;
      return [newSeat(option.name, count)];
    }
    const listed = new Set(option.offer?.models.map((model) => model.value));
    return saved.map((choice) => ({
      harness: option.name,
      count: choice.count,
      model: choice.model ?? '',
      // A saved model that the harness does not list now stays as a typed one.
      typed: option.offer !== null && choice.model !== null && !listed.has(choice.model),
      effort: choice.effort ?? '',
      mode: choice.mode ?? '',
      role: choice.role ?? '',
      family: choice.family ?? '',
      onCall: choice.on_call ?? false,
      coordinator: choice.coordinator ?? false,
      // A saved choice switches on no power. The person does that for each lab.
      powers: [],
      desk: choice.desk ?? false,
    }));
  });
}

/**
 * Return the seats with the seat at `index` replaced. A lab has one coordinator and one desk, so a seat that becomes
 * the coordinator's or the desk holds one agent, and no other seat is the coordinator's or the desk. The desk holds
 * no other seat, so a seat that becomes the desk is not the coordinator's and not on call.
 */
export function withSeat(seats: readonly Seat[], index: number, changed: Seat): readonly Seat[] {
  // A seat with no agent takes one only while the lab has room for it.
  const room = MAX_AGENTS - agentCount(seats.filter((_, at) => at !== index));
  const old = seats[index];
  // A seat becomes the desk, or one of its other seats: the one that the person ticked last stays.
  const desked = changed.desk && !old?.desk;
  const facts = desked
    ? { ...changed, coordinator: false, onCall: false, powers: [] }
    : changed.desk && (changed.coordinator || changed.onCall)
      ? { ...changed, desk: false }
      : changed;
  const seat =
    facts.coordinator || facts.desk
      ? { ...facts, count: Math.min(1, room, Math.max(facts.count, 1)) }
      : facts;
  return seats.map((other, at) =>
    at === index
      ? seat
      : {
          ...other,
          ...(seat.coordinator ? { coordinator: false } : {}),
          ...(seat.desk ? { desk: false } : {}),
        },
  );
}

/** Return the seats with one more seat of a harness, after the harness's other seats. */
export function addSeat(seats: readonly Seat[], harness: string): readonly Seat[] {
  const last = seats.map((seat) => seat.harness).lastIndexOf(harness);
  const count = agentCount(seats) < MAX_AGENTS ? 1 : 0;
  return [...seats.slice(0, last + 1), newSeat(harness, count), ...seats.slice(last + 1)];
}

/** Return the seats without the seat at `index`. */
export function removeSeat(seats: readonly Seat[], index: number): readonly Seat[] {
  return seats.filter((_, at) => at !== index);
}

/**
 * Return the seats with the count of the seat at `index` changed by `change`, kept at zero or more, and
 * `MAX_AGENTS` in all. The coordinator's seat holds one agent at most.
 */
export function step(seats: readonly Seat[], index: number, change: number): readonly Seat[] {
  const room = MAX_AGENTS - agentCount(seats.filter((_, at) => at !== index));
  // A count never grows past the room that the other seats leave, and a step down always works.
  return seats.map((seat, at) => {
    if (at !== index) return seat;
    const most = seat.coordinator || seat.desk ? 1 : Math.max(room, seat.count);
    return { ...seat, count: Math.max(0, Math.min(most, seat.count + change)) };
  });
}

/** Return whether a seat asks for a typed model and has none yet. A blank ID would start the harness's default model. */
export function needsModel(seat: Seat): boolean {
  return seat.typed && seat.count > 0 && seat.model.trim() === '';
}

/** Return whether the seats start agents and every one of them is on call, so that no agent starts by itself. */
export function allOnCall(seats: readonly Seat[]): boolean {
  const chosen = seats.filter((seat) => seat.count > 0);
  return chosen.length > 0 && chosen.every((seat) => seat.onCall);
}

/** Return how many agents the seats start. */
export function agentCount(seats: readonly Seat[]): number {
  return seats.reduce((sum, seat) => sum + seat.count, 0);
}

/** A lab's budget in tokens and in US dollars. `null` means no budget of that kind. */
export interface Budget {
  readonly tokens: number | null;
  readonly dollars: number | null;
}

/** A lab without a budget. */
export const NO_BUDGET: Budget = { tokens: null, dollars: null };

/**
 * Return the request that starts a lab with the person's choices. `deliverables` is the text of the setup's field,
 * with one sentence on each line.
 */
export function startRequest(
  question: string,
  seats: readonly Seat[],
  autoMode: boolean,
  minutes: number | null,
  deliverables = '',
  budget: Budget = NO_BUDGET,
): StartRequest {
  const wanted = sentences(deliverables);
  return {
    question: question.trim(),
    agents: chosenAgents(seats),
    auto_mode: autoMode,
    ...(minutes ? { minutes } : {}),
    ...(budget.tokens ? { budget_tokens: budget.tokens } : {}),
    ...(budget.dollars ? { budget_dollars: budget.dollars } : {}),
    ...(wanted.length > 0 ? { deliverables: wanted } : {}),
  };
}

/** Return the deliverables that the setup's field holds: one sentence on each line that has text. */
export function sentences(text: string): readonly string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Return the person's choices on the setup screen as the choices that new labs start with. They hold no power of
 * the coordinator: the person switches a power on for one lab, and no saved choice does it for the next.
 */
export function setupChoices(
  seats: readonly Seat[],
  autoMode: boolean,
  minutes: number | null,
  budget: Budget = NO_BUDGET,
): SetupChoices {
  const saved = seats.map((seat) => ({ ...seat, powers: [] }));
  return {
    agents: chosenAgents(saved),
    auto_mode: autoMode,
    minutes,
    budget_tokens: budget.tokens,
    budget_dollars: budget.dollars,
  };
}

function chosenAgents(seats: readonly Seat[]): readonly AgentChoice[] {
  return seats.filter((seat) => seat.count > 0).map(seatChoice);
}

/** Return a seat as the server takes it. It leaves out what the person did not set. */
export function seatChoice(seat: Seat): AgentChoice {
  return {
    harness: seat.harness,
    count: seat.count,
    ...(seat.model.trim() ? { model: seat.model.trim() } : {}),
    ...(seat.effort.trim() ? { effort: seat.effort.trim() } : {}),
    ...(seat.mode.trim() ? { mode: seat.mode.trim() } : {}),
    ...(seat.role.trim() ? { role: seat.role.trim() } : {}),
    ...(seat.family.trim() ? { family: seat.family.trim() } : {}),
    ...(seat.onCall ? { on_call: true } : {}),
    ...(seat.coordinator ? { coordinator: true } : {}),
    ...(seat.coordinator && seat.powers.length > 0 ? { powers: seat.powers } : {}),
    ...(seat.desk ? { desk: true } : {}),
  };
}

/** Return what new labs start with, in words. */
export function defaultsLine(defaults: SetupDefaults, harnesses: readonly HarnessOption[]): string {
  const agents =
    defaults.agents === null
      ? 'One agent of each harness that this computer has'
      : defaults.agents.map((choice) => agentWords(choice, harnesses)).join('; ');
  const time =
    defaults.minutes === null ? 'No time limit' : `Time limit: ${duration(defaults.minutes)}`;
  const kinds = [
    defaults.budget_tokens ? `${tokens(defaults.budget_tokens)} tokens` : null,
    defaults.budget_dollars ? money(defaults.budget_dollars) : null,
  ].filter((kind) => kind !== null);
  const budget = kinds.length > 0 ? ` Budget: ${kinds.join(' and ')}.` : '';
  return `${agents}. ${defaults.auto_mode ? 'Auto mode' : 'No auto mode'}. ${time}.${budget}`;
}

function agentWords(choice: SavedChoice, harnesses: readonly HarnessOption[]): string {
  const title = harnesses.find((option) => option.name === choice.harness)?.title ?? choice.harness;
  const details = [
    choice.model,
    choice.effort ? `${choice.effort} effort` : null,
    choice.mode ? `${choice.mode} mode` : null,
    choice.family ? `${choice.family} family` : null,
    choice.role ? `role: ${choice.role}` : null,
    choice.coordinator ? 'coordinator' : null,
    choice.on_call ? 'on call' : null,
    choice.desk ? 'desk' : null,
  ].filter((detail) => detail !== null);
  const agents = `${title}: ${choice.count} ${choice.count === 1 ? 'agent' : 'agents'}`;
  return details.length > 0 ? `${agents} (${details.join(', ')})` : agents;
}

/** Return the two letters in a harness's avatar: the first letters of two words, or the ends of one word. */
export function initials(title: string): string {
  const words = title.split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`
      : `${title[0] ?? ''}${title.at(-1) ?? ''}`;
  return letters.toUpperCase();
}

/** The effort levels that a harness offers with one model, and the person's own level, when the harness said it. */
export interface Efforts {
  readonly values: readonly OptionValue[];
  readonly current: string | null;
}

/**
 * Return the effort levels that a harness offers with a pick's model. A blank model is the person's own model.
 *
 * The harness reports the person's own effort level only for their own model. A model that the harness didn't
 * switch to offers no levels, so the agent keeps the harness's default for it.
 */
export function effortsOf(offer: Offer, model: string): Efforts {
  if (!model || model === offer.model) return { values: offer.efforts, current: offer.effort };
  return {
    values: offer.models.find((option) => option.value === model)?.efforts ?? [],
    current: null,
  };
}

/** The value of the model menu's last entry, which lets the person type a model that the harness does not list. */
export const OTHER_MODEL = '\u0000other';

/**
 * Return the seat with another model, and without an effort level that the harness doesn't offer with it.
 * `OTHER_MODEL` starts a typed model, which is blank until the person types it.
 */
export function withModel(pick: Seat, offer: Offer, model: string): Seat {
  if (model === OTHER_MODEL) return { ...pick, model: '', typed: true, effort: '' };
  const kept = effortsOf(offer, model).values.some((option) => option.value === pick.effort);
  return { ...pick, model, typed: false, effort: kept ? pick.effort : '' };
}

/**
 * Return what a seat's menu says when it is closed: its model with the names that the harness offered, and its
 * facts, with its model family when that is not the harness's own.
 */
export function modelSummary(pick: Seat, offer: Offer | null, family = ''): string {
  // A family of the person's own shows, because it decides whether a rerun by this seat's model counts as
  // independent. `family` is the harness's own.
  const stated = pick.family.trim();
  const own = stated !== '' && stated.toLowerCase() !== family.trim().toLowerCase();
  const facts = [
    own ? `${stated} family` : '',
    pick.role.trim(),
    pick.coordinator ? 'coordinator' : '',
    pick.onCall ? 'on call' : '',
    pick.desk ? 'desk' : '',
  ].filter(Boolean);
  const model = modelLine(pick, offer);
  return facts.length > 0 ? `${model} · ${facts.join(', ')}` : model;
}

function modelLine(pick: Seat, offer: Offer | null): string {
  const mode = pick.mode ? `, ${nameOf(offer?.modes ?? [], pick.mode)} mode` : '';
  const chosen = pick.model.trim() || pick.effort.trim();
  if (offer === null) {
    if (!chosen) return `Your default model and effort${mode}`;
    const effort = pick.effort.trim() ? `${pick.effort.trim()} effort` : 'default effort';
    return `${pick.model.trim() || 'Your default model'}, ${effort}${mode}`;
  }
  const model = pick.model.trim() || offer.model;
  const efforts = effortsOf(offer, pick.model.trim());
  const effort = pick.effort.trim() || efforts.current;
  const parts = [
    model ? nameOf(offer.models, model) : 'Your default model',
    ...(effort
      ? [`${nameOf(efforts.values, effort)} effort`]
      : efforts.values.length > 0 || !model
        ? ['default effort']
        : []),
  ];
  return `${parts.join(', ')}${chosen ? '' : ' (your default)'}${mode}`;
}

/**
 * Return a menu of a harness's values: first the person's own value, which sends nothing, then the others.
 *
 * `current` is the person's own value, as the harness reported it. `chosen` is the pick's value: a saved one that
 * the harness doesn't offer now stays in the menu, so the menu shows what the lab would get.
 */
export function menuEntries(
  values: readonly OptionValue[],
  current: string | null,
  chosen = '',
): readonly MenuEntry[] {
  const kept = chosen !== '' && !values.some((option) => option.value === chosen);
  if (values.length === 0 && !kept) return [];
  return [
    { value: '', label: current ? `${nameOf(values, current)} (your default)` : 'Your default' },
    ...values
      .filter((option) => option.value !== current)
      .map((option) => ({ value: option.value, label: option.name })),
    ...(kept ? [{ value: chosen, label: chosen }] : []),
  ];
}

/** Return a menu of a harness's modes: first the answer to the auto mode question, then each mode. */
export function modeEntries(offer: Offer, chosen = ''): readonly MenuEntry[] {
  const kept = chosen !== '' && !offer.modes.some((mode) => mode.value === chosen);
  if (offer.modes.length === 0 && !kept) return [];
  return [
    { value: '', label: 'Your auto mode answer' },
    ...offer.modes.map((mode) => ({
      value: mode.value,
      label: mode.value === offer.mode ? `${mode.name} (your default)` : mode.name,
    })),
    ...(kept ? [{ value: chosen, label: chosen }] : []),
  ];
}

/** Return the name that a harness shows for `value`, or `value` itself when the harness offered no name for it. */
function nameOf(values: readonly OptionValue[], value: string): string {
  return values.find((option) => option.value === value)?.name ?? value;
}
