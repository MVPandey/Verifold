import type { Call, CallOption, Effect, Lab } from '../protocol/api.ts';
import {
  costWords,
  effectWords,
  undoWords,
  type EffectWords,
} from '../ui/call-words.ts';

/**
 * The options in the order that the dialog shows them: the agents' pick
 * first, then the others in the agents' order. Each entry is the option's
 * index in the call, which is what an answer sends.
 */
export function optionOrder(call: Call): readonly number[] {
  const all = call.options.map((_, index) => index);
  const pick = call.pick;
  return pick === null || !call.options[pick]
    ? all
    : [pick, ...all.filter((index) => index !== pick)];
}

/**
 * The option that a number key picks: "1" is the first option shown. None
 * for any other key, or while the person types in a text box, where a
 * number is part of the text.
 */
export function optionForKey(
  key: string,
  order: readonly number[],
  typing: boolean,
): number | null {
  if (typing || !/^[1-9]$/.test(key)) return null;
  return order[Number(key) - 1] ?? null;
}

/** True when a key goes to a text box, where a number is part of the text. */
export function typing(target: unknown): boolean {
  const tag =
    typeof target === 'object' && target !== null && 'tagName' in target
      ? target.tagName
      : undefined;
  return tag === 'TEXTAREA' || tag === 'INPUT';
}

/** A direction by its title in quotes, as the app names directions, or its ID when the snapshot left it out. */
function titled(lab: Lab, id: string): string {
  const title = lab.directions.find((entry) => entry.id === id)?.title;
  return title ? `"${title}"` : id;
}

/** An effect, as the shared call words take it. */
function wordsOf(effect: Effect, lab: Lab): EffectWords {
  switch (effect.type) {
    case 'pod':
      return { type: 'pod', gpu: effect.gpu, hours: effect.hours };
    case 'hours':
      return { type: 'hours', hours: effect.hours };
    case 'open':
      return { type: 'open', title: effect.title, harness: effect.harness };
    case 'stop':
      return { type: 'stop', direction: titled(lab, effect.direction) };
    case 'domains':
      return { type: 'domains', domains: effect.domains };
  }
}

/** What an option does and what its undo does, in the words that the desk uses too. */
export function optionLines(
  option: CallOption,
  call: Call,
  lab: Lab,
): { readonly does: string; readonly undo: string } | null {
  if (!option.effect) return null;
  const direction = call.askers[0]?.direction;
  return effectWords(
    wordsOf(option.effect, lab),
    direction ? titled(lab, direction) : null,
    call.askers.map((asker) => ({
      handle: asker.handle,
      codex:
        lab.agents.find((agent) => agent.id === asker.agent)?.harness ===
        'codex',
    })),
  );
}

/** An option's cost and time: "About $11.97 · 3 h", "No cost · 9 h". */
export function costLine(option: CallOption): string {
  return costWords(option.usd, option.minutes);
}

/**
 * The dialog's last line: how an answer can be taken back, for the option
 * that the person chose, or the agents' pick before an answer.
 */
export function footLine(call: Call, lab: Lab): string {
  const index = call.answer?.option ?? call.pick;
  const effect = index === null ? null : call.options[index]?.effect;
  return undoWords(call.undoMinutes, effect ? wordsOf(effect, lab) : null);
}

/** A pod option that cannot start yet: the pod secrets that this computer does not store. */
export function missingLine(option: CallOption): string | null {
  const effect = option.effect;
  if (effect?.type !== 'pod' || !effect.missing) return null;
  return `Needs ${effect.missing} pod ${effect.missing === 1 ? 'secret' : 'secrets'} that this computer does not store yet.`;
}

/**
 * The last seconds of an undo window count as closed: a click then could
 * reach Verifold after the window, and the page never offers an undo that
 * Verifold refuses.
 */
const undoMargin = 2_000;

/** Milliseconds left to undo an answer, or null when it has no undo now. */
export function undoLeft(call: Call, now: number): number | null {
  if (call.state !== 'answered' || !call.answer || !call.undoUntil) return null;
  const left = Date.parse(call.undoUntil) - now - undoMargin;
  return left > 0 ? left : null;
}

/** An answer or an undo that failed after Verifold accepted it. */
export interface CallFailure {
  readonly kind: 'answer' | 'undo';
  readonly text: string;
}

/**
 * Why the person's last answer or undo of a call failed, from the lab's
 * background work: an answer's failure while the call is open again, an
 * undo's while the answer stands. A later try replaces the failure.
 */
export function failureOf(lab: Lab, call: Call): CallFailure | null {
  const work = [...lab.works]
    .reverse()
    .find(
      (entry) =>
        entry.call === call.id &&
        entry.error !== null &&
        (entry.action === 'lab-call-answer' ||
          entry.action === 'lab-call-undo'),
    );
  if (!work?.error) return null;
  if (work.action === 'lab-call-undo')
    return call.state === 'answered'
      ? { kind: 'undo', text: `The undo did not go through: ${work.error}` }
      : null;
  if (call.state !== 'open') return null;
  const option =
    work.option === undefined ? undefined : call.options[work.option];
  return {
    kind: 'answer',
    text:
      option?.effect?.type === 'pod'
        ? `The pod did not start: ${work.error}`
        : `Your answer did not go through: ${work.error}`,
  };
}

/** While Verifold applies an answer: what it does, never a final "You chose". */
export function applyingText(option: CallOption): string {
  return option.effect?.type === 'pod'
    ? `Starting the pod for “${option.label}”…`
    : `Applying “${option.label}”…`;
}

/** What the dialog shows for a call: its question, or what became of it. */
export type CallView =
  | { readonly kind: 'open'; readonly call: Call }
  | {
      readonly kind: 'applying';
      readonly call: Call;
      readonly option: CallOption;
    }
  | {
      readonly kind: 'chosen';
      readonly call: Call;
      readonly option: CallOption;
    }
  | { readonly kind: 'words'; readonly call: Call; readonly words: string }
  | { readonly kind: 'undoing'; readonly call: Call }
  | { readonly kind: 'withdrawn'; readonly call: Call }
  | { readonly kind: 'missing' };

export function callView(lab: Lab, id: string): CallView {
  const call =
    lab.needsYou.find((entry) => entry.id === id) ??
    lab.answered.find((entry) => entry.id === id);
  if (!call) return { kind: 'missing' };
  if (call.state === 'open') return { kind: 'open', call };
  if (call.state === 'undoing') return { kind: 'undoing', call };
  if (call.state === 'withdrawn') return { kind: 'withdrawn', call };
  const option = call.answer ? call.options[call.answer.option] : undefined;
  if (option)
    return call.applying
      ? { kind: 'applying', call, option }
      : { kind: 'chosen', call, option };
  if (call.words !== null) return { kind: 'words', call, words: call.words };
  return { kind: 'missing' };
}

/** The label over a call that no longer waits, by its state. An unknown call has none. */
export function settledLabel(
  view: CallView,
): { readonly text: string; readonly tone: 'done' | 'busy' | 'quiet' } | null {
  switch (view.kind) {
    case 'applying':
      return { text: 'Applying your answer', tone: 'busy' };
    case 'chosen':
    case 'words':
      return { text: 'Answered', tone: 'done' };
    case 'undoing':
      return { text: 'Undoing your answer', tone: 'busy' };
    case 'withdrawn':
      return { text: 'Withdrawn', tone: 'quiet' };
    case 'open':
    case 'missing':
      return null;
  }
}

/** True while an answer is applied or can be undone, so the page counts the seconds. */
export function needsTick(lab: Lab | null | undefined, now: number): boolean {
  return Boolean(
    lab?.answered.some(
      (call) => call.applying === true || undoLeft(call, now) !== null,
    ),
  );
}

/** Whether a post is on the board page that the lab home shows. */
export function onBoard(lab: Lab, post: string): boolean {
  return lab.board.posts.some((entry) => entry.id === post);
}

/** The history state of a call opened from the lab home. */
export const fromLab = { from: 'lab' } as const;

/**
 * How closing the dialog leaves its address without a new history entry:
 * back, when the lab home opened the call, so Back cannot reopen it; else,
 * as for a link from elsewhere, the call's entry becomes the lab's.
 */
export function closeHow(state: unknown): 'back' | 'replace' {
  return typeof state === 'object' &&
    state !== null &&
    'from' in state &&
    state.from === fromLab.from
    ? 'back'
    : 'replace';
}

/** Where focus goes after the dialog closes, when it went nowhere: the needs-you line's Decide link. */
export const decideId = 'needs-decide';

/** The parts of a document that `returnFocus` reads, so a test can pass a stand-in. */
export interface FocusDocument {
  readonly activeElement: unknown;
  readonly body: unknown;
  getElementById(id: string): { focus(): void } | null;
}

/**
 * After the dialog closes the browser returns focus to where it was before.
 * When that was nowhere, as when the page opened on the call's address,
 * focus goes to the Decide link.
 */
export function returnFocus(doc: FocusDocument): void {
  if (doc.activeElement && doc.activeElement !== doc.body) return;
  doc.getElementById(decideId)?.focus();
}
