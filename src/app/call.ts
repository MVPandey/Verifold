import type { Call, CallOption, Effect, Lab } from '../protocol/api.ts';
import { harnessName, span, usd } from './format.ts';

/** "a", "a and b", "a, b and c". */
export function andList(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

const plural = (count: number, word: string): string =>
  `${count} ${count === 1 ? word : `${word}s`}`;

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

/** An option's cost and time: "$11.97 · about 3 h". */
export function costLine(option: CallOption): string {
  return [
    option.usd === null ? '' : usd(option.usd),
    option.minutes === null ? '' : `about ${span(option.minutes * 60_000)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Who asked, for the dialog's first line: "asked by claude-2 and codex-2", or "Verifold asks". */
export function askedBy(call: Call): string {
  return call.askers.length
    ? `asked by ${andList(call.askers.map((asker) => asker.handle))}`
    : 'Verifold asks';
}

function shells(names: readonly string[]): string {
  return names.length === 1
    ? `${names[0] ?? ''}'s shell`
    : `the shells of ${andList(names)}`;
}

/**
 * What an option does and what an undo does, in Verifold's words, as the
 * desk says them. An agent's label says what the agent means; this line
 * says what happens.
 */
export function effectLines(
  effect: Effect,
  call: Call,
  lab: Lab,
): { readonly does: string; readonly undo: string } {
  const title = (id: string): string =>
    lab.directions.find((entry) => entry.id === id)?.title ?? id;
  switch (effect.type) {
    case 'pod':
      return {
        does: `Starts a pod with ${effect.gpu} for ${plural(effect.hours, 'hour')}.`,
        undo: 'Undo ends the pod. The minutes billed so far stay billed.',
      };
    case 'hours':
      return {
        does: `Gives the lab ${plural(effect.hours, 'more hour')}.`,
        undo: 'Undo takes the hours back.',
      };
    case 'open':
      return {
        does: `Opens "${effect.title}" with a new ${harnessName(effect.harness)} agent.`,
        undo: 'Undo stops it. Its folder and branch stay.',
      };
    case 'stop':
      return {
        does: `Stops "${title(effect.direction)}". Its runs and pods end.`,
        undo: 'Undo opens it again with its agent. Runs and pods that ended do not come back.',
      };
    case 'domains': {
      // Each agent that asked gets the domains. Codex cannot limit them.
      const harness = (agent: string): string | undefined =>
        lab.agents.find((entry) => entry.id === agent)?.harness;
      const codex = call.askers
        .filter((asker) => harness(asker.agent) === 'codex')
        .map((asker) => asker.handle);
      const others = call.askers
        .filter((asker) => harness(asker.agent) !== 'codex')
        .map((asker) => asker.handle);
      const all = call.askers.map((asker) => asker.handle);
      const domains = effect.domains.join(', ');
      return {
        does: [
          others.length ? `Lets ${shells(others)} reach ${domains}.` : '',
          codex.length
            ? `Codex cannot limit the network to ${domains}, so ${shells(codex)} can reach any website.`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
        undo: `Undo takes these domains back. Either way, ${
          all.length === 1
            ? `${all[0] ?? ''} continues its conversation in a new process`
            : `${andList(all)} continue their conversations in new processes`
        }.`,
      };
    }
  }
}

/** A pod option that cannot start yet: the pod secrets that this computer does not store. */
export function missingLine(option: CallOption): string | null {
  const effect = option.effect;
  if (effect?.type !== 'pod' || !effect.missing) return null;
  return `Needs ${plural(effect.missing, 'pod secret')} stored in Compute first.`;
}

/**
 * The dialog's last line: how long an answer can be undone, and what an
 * undo of a pod costs, as the v9 canvas says it. An option's own line says
 * what it does; this line says how to take it back.
 */
export function undoSentence(call: Call): string {
  if (!call.undoMinutes)
    return "Your answer applies at once, and it has no undo. If you don't answer, nothing happens.";
  const pods = call.options.some((option) => option.effect?.type === 'pod');
  return pods
    ? `Undo within ${plural(call.undoMinutes, 'minute')} stops the GPU, and you pay only the minutes used. If you don't answer, nothing is bought.`
    : `Your answer applies at once. You can undo it for ${plural(call.undoMinutes, 'minute')}. If you don't answer, nothing happens.`;
}

/** Whole minutes left to undo an answer, or null when the answer has no undo now. */
export function undoLeft(call: Call, now: number): number | null {
  if (call.state !== 'answered' || !call.answer || !call.undoUntil) return null;
  const left = Date.parse(call.undoUntil) - now;
  return left > 0 ? Math.ceil(left / 60_000) : null;
}

/** What the dialog shows for a call: its question, or what became of it. */
export type CallView =
  | { readonly kind: 'open'; readonly call: Call }
  | { readonly kind: 'undoing'; readonly call: Call }
  | {
      readonly kind: 'chosen';
      readonly call: Call;
      readonly option: CallOption;
    }
  | { readonly kind: 'words'; readonly call: Call; readonly words: string }
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
  if (option) return { kind: 'chosen', call, option };
  if (call.words !== null) return { kind: 'words', call, words: call.words };
  return { kind: 'missing' };
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
