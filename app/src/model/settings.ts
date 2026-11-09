import type { AtExit, AtTimeLimit, Settings } from '../api/types.ts';

/** One answer to a setting: the value that it sends, and what the page says about it. */
export interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly detail: string;
}

/** The answers to `jobs.at_time_limit`. */
export const AT_TIME_LIMIT: readonly Choice<AtTimeLimit>[] = [
  { value: 'pause', label: 'Pause them', detail: 'They continue when you give the lab more time.' },
  { value: 'stop', label: 'Stop them', detail: 'Verifold ends them.' },
  { value: 'finish', label: 'Let them finish', detail: 'They run until they end.' },
];

/** The answers to `jobs.at_exit`. */
export const AT_EXIT: readonly Choice<AtExit>[] = [
  { value: 'stop', label: 'Stop them', detail: 'Verifold ends them.' },
  {
    value: 'keep',
    label: 'Keep them',
    detail: "The next verifold in this folder pauses or resumes them with the lab's time.",
  },
];

/** Return the value that a settings file holds for a key with dots, such as `jobs.at_exit`, if it holds one. */
export function valueAt(values: Readonly<Record<string, unknown>>, key: string): unknown {
  let found: unknown = values;
  for (const part of key.split('.')) {
    if (typeof found !== 'object' || found === null || Array.isArray(found)) return undefined;
    found = (found as Readonly<Record<string, unknown>>)[part];
  }
  return found;
}

/** Return the label of the choice with `value`. */
export function labelOf<T extends string>(choices: readonly Choice<T>[], value: T): string {
  return choices.find((choice) => choice.value === value)?.label ?? value;
}

/** Return what stopping the lab does to the processes that the agents left running. */
export function stopLine(settings: Settings): string {
  switch (settings.jobs.at_time_limit) {
    case 'pause':
      return 'Processes that the agents left running pause until you give the lab more time.';
    case 'stop':
      return 'Processes that the agents left running stop too.';
    case 'finish':
      return 'Processes that the agents left running continue until they end.';
  }
}
