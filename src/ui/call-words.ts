/**
 * Verifold's words for a call: what an option costs, what it does, and what
 * an undo does. The desk and the app both say a call this way, so the person
 * reads the same words on either. It takes plain values, not the desk's or
 * the protocol's records, and imports nothing.
 */

/** "a", "a and b", "a, b and c". */
export function andList(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

const plural = (count: number, word: string): string =>
  `${count} ${count === 1 ? word : `${word}s`}`;

/** Dollars: whole amounts without cents, others with two decimals: "$25", "$11.97". */
export function usd(value: number): string {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

/** A span of minutes, such as "45 min" or "3 h 20 min". */
export function minutesText(minutes: number): string {
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}

/**
 * What an option costs and takes: "About $11.97 · 3 h", or "No cost · 9 h".
 * An unknown cost or time, or a time of 0, says nothing.
 */
export function costWords(
  dollars: number | null,
  minutes: number | null,
): string {
  return [
    dollars === null ? '' : dollars === 0 ? 'No cost' : `About ${usd(dollars)}`,
    minutes ? minutesText(minutes) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * An option's effect, in the values its words need. `stop.direction` and
 * the `direction` of `effectWords` are the names to show, such as an ID or
 * a title in quotes.
 */
export type EffectWords =
  | { readonly type: 'pod'; readonly gpu: string; readonly hours: number }
  | { readonly type: 'hours'; readonly hours: number }
  | {
      readonly type: 'open';
      readonly title: string;
      readonly harness: 'claude' | 'codex';
    }
  | { readonly type: 'stop'; readonly direction: string }
  | { readonly type: 'domains'; readonly domains: readonly string[] };

/** An agent that asked: its handle, and whether it runs in Codex, which cannot limit the network to domains. */
export interface AskerWords {
  readonly handle: string;
  readonly codex: boolean;
}

/** "an H100", "a B200": letter names read as "aitch", "en" and so on take "an". */
function withArticle(name: string): string {
  return `${/^[AEFHILMNORSX]/.test(name) ? 'an' : 'a'} ${name}`;
}

function shells(names: readonly string[]): string {
  return names.length === 1
    ? `${names[0] ?? ''}'s shell`
    : `the shells of ${andList(names)}`;
}

/**
 * What an option does and what an undo does. An agent's label says what the
 * agent means; these lines say what happens. `direction`: the direction a
 * pod is for.
 */
export function effectWords(
  effect: EffectWords,
  direction: string | null,
  askers: readonly AskerWords[],
): { readonly does: string; readonly undo: string } {
  switch (effect.type) {
    case 'pod':
      return {
        does: `Starts ${withArticle(effect.gpu)} pod for ${plural(effect.hours, 'hour')} for ${direction ?? 'the direction'}.`,
        undo: 'Undo ends the pod. The minutes billed so far stay billed.',
      };
    case 'hours':
      return {
        does: `Gives the lab ${plural(effect.hours, 'more hour')}.`,
        undo: 'Undo takes the hours back.',
      };
    case 'open':
      return {
        does: `Opens "${effect.title}" with a new ${effect.harness === 'claude' ? 'Claude Code' : 'Codex'} agent.`,
        undo: 'Undo stops it. Its folder and branch stay.',
      };
    case 'stop':
      return {
        does: `Stops ${effect.direction}. Its runs and pods end.`,
        undo: 'Undo opens it again with its agent. Runs and pods that ended do not come back.',
      };
    case 'domains': {
      // Each agent that asked gets the domains. Codex cannot limit them.
      const codex = askers.filter((asker) => asker.codex);
      const others = askers.filter((asker) => !asker.codex);
      const all = askers.map((asker) => asker.handle);
      const domains = effect.domains.join(', ');
      return {
        does: [
          others.length
            ? `Lets ${shells(others.map((asker) => asker.handle))} reach ${domains}.`
            : '',
          codex.length
            ? `Codex: any website. Codex cannot limit the network to ${domains}, so ${shells(codex.map((asker) => asker.handle))} can reach any website.`
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

/**
 * The line under a call's options: how long an answer can be undone, said
 * for one option: the one the person picked, or the agents' pick before an
 * answer. `undoMinutes` undefined: Verifold did not say, so the line says
 * only what no answer does.
 */
export function undoWords(
  undoMinutes: number | undefined,
  effect: EffectWords | null,
): string {
  if (undoMinutes === undefined) return "If you don't answer, nothing happens.";
  if (!undoMinutes)
    return "Your answer applies at once, and it has no undo. If you don't answer, nothing happens.";
  return effect?.type === 'pod'
    ? `Undo within ${plural(undoMinutes, 'minute')} stops the GPU, and you pay only the minutes used. If you don't answer, nothing is bought.`
    : `Your answer applies at once. You can undo it for ${plural(undoMinutes, 'minute')}. If you don't answer, nothing happens.`;
}
