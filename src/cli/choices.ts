import type { CliIO } from './commands.ts';

export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

/** Keep numbered input available for simple terminals and embedded callers. */
export async function choose(
  io: CliIO,
  question: string,
  choices: readonly Choice[],
  initial: string,
): Promise<string> {
  if (io.select) return io.select(question, choices, initial);
  const menu = choices
    .map(
      (choice, index) =>
        `  ${index + 1}. ${choice.label} — ${choice.description}`,
    )
    .join('\n');
  for (;;) {
    const answer = (await io.ask(`${question} [${initial}]\n${menu}\nChoice: `))
      .trim()
      .toLowerCase();
    if (!answer) return initial;
    const selected = choices.find(
      (choice, index) =>
        choice.value === answer || String(index + 1) === answer,
    );
    if (selected) return selected.value;
    io.progress?.('Choose a listed number or name.');
  }
}

/** Presentation wraps a real operation; the host still owns its execution. */
export function withActivity<T>(
  io: CliIO,
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  if (io.busy) return io.busy(label, work);
  io.progress?.(label);
  return work();
}
