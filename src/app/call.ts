import type { Call, CallOption, Effect, Lab } from '../protocol/api.ts';
import {
  costWords,
  effectWords,
  undoWords,
  type EffectWords,
} from '../ui/call-words.ts';
import {
  href,
  parseRoute,
  replaceRoute,
  type Opener,
  type PageRoute,
} from './route.ts';

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

/**
 * A pod option that cannot start yet: how many pod secrets this computer
 * does not store, and their names when Verifold sends them. Null: none is
 * missing, or Verifold cannot tell.
 */
export function missingSecrets(option: CallOption): {
  readonly count: number;
  readonly names: readonly string[] | null;
} | null {
  const effect = option.effect;
  if (effect?.type !== 'pod' || !effect.missing) return null;
  return {
    count: effect.missing,
    names: effect.missingNames?.length ? effect.missingNames : null,
  };
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

/** This load of the app. A reload starts a new one, whose history entries are new too. */
const thisLoad = performance.timeOrigin;

/**
 * The history state of a call that a page of the app opened: that page's
 * address, so the call shows over it and its Close goes back to it, and
 * this load of the app.
 */
export function openedFrom(hash: string): {
  readonly from: string;
  readonly load: number;
} {
  return { from: hash || href.lab, load: thisLoad };
}

/**
 * The page that opened the call, from the history state. A reload keeps
 * that state. Null for a call that came from anywhere else, such as a
 * notification or an address typed in: it shows over the lab home.
 */
export function callOpener(state: unknown): Opener | null {
  if (
    typeof state !== 'object' ||
    state === null ||
    !('from' in state) ||
    typeof state.from !== 'string'
  )
    return null;
  // The build before this one wrote { from: 'lab' }, and its Close went Back, which leaves no second lab entry.
  if (state.from === 'lab')
    return { hash: href.lab, route: { page: 'lab' }, back: true };
  const route = parseRoute(state.from);
  if (
    route.page === 'call' ||
    route.page === 'setup' ||
    route.page === 'ask' ||
    route.page === 'unknown'
  )
    return null;
  // After a reload, Back would load the app again, so Close replaces the call's entry instead.
  return {
    hash: state.from,
    route,
    back: 'load' in state && state.load === thisLoad,
  };
}

/** Open a call over this page, so that its Close comes back here. */
export function openCall(id: string): void {
  history.pushState(openedFrom(location.hash), '', href.call(id));
  dispatchEvent(new HashChangeEvent('hashchange'));
}

/**
 * Leave the call's address without a new history entry: back to the page
 * that opened it, so Back cannot reopen the call. A call from anywhere else
 * leaves for the lab home. `post`: "See the thread", which leaves for that
 * post on the lab home.
 */
export function leaveCall(opener: Opener | null, post: string | null): void {
  if (opener?.back && (opener.route.page === 'lab' || !post)) history.back();
  else replaceRoute(post ? href.board(post) : (opener?.hash ?? href.lab));
}

/** The settled call's way out, which names the page under the call. */
export function backLabel(under: PageRoute | null, lab: Lab): string {
  if (!under || under.page === 'lab') return 'Back to the lab';
  switch (under.page) {
    case 'direction': {
      const direction = lab.directions.find(
        (entry) => entry.id === under.direction,
      );
      const agent = lab.agents.find((entry) => entry.id === direction?.agent);
      return agent
        ? `Back to ${agent.handle}'s direction`
        : 'Back to the direction';
    }
    case 'answer':
      return 'Back to the answer';
    case 'post':
      return 'Back to the post';
    case 'figure':
      return 'Back to the figure';
    case 'run':
      return `Back to run ${under.id}`;
    case 'settings':
      return 'Back to Settings';
    case 'history':
    case 'history-run':
      return 'Back to History';
    default:
      return 'Back';
  }
}

/** The lab home's Decide link, where focus goes after a call when the page has no heading. */
export const decideId = 'needs-decide';

/** An element that `returnFocus` can focus. */
interface Focusable {
  focus(options?: { readonly preventScroll?: boolean }): void;
  setAttribute(name: string, value: string): void;
}

/** The parts of a document that `returnFocus` reads, so a test can pass a stand-in. */
export interface FocusDocument {
  readonly activeElement: unknown;
  readonly body: unknown;
  getElementById(id: string): Focusable | null;
  querySelector(selector: string): Focusable | null;
}

/**
 * After the dialog closes the browser returns focus to where it was before.
 * When that was nowhere, as when the Decide link that opened the call is
 * gone, or the page opened on the call's address, focus goes to the
 * heading of the page under the call, or else to the lab home's Decide
 * link. The page does not scroll for it.
 */
export function returnFocus(doc: FocusDocument): void {
  if (doc.activeElement && doc.activeElement !== doc.body) return;
  const heading = doc.querySelector('main h1');
  // A heading takes focus only from a script, and keeps out of the Tab order.
  heading?.setAttribute('tabindex', '-1');
  (heading ?? doc.getElementById(decideId))?.focus({ preventScroll: true });
}
