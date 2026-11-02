import type { Helper } from '../protocol/api.ts';

const counted = (count: number): string =>
  `${count} ${count === 1 ? 'helper' : 'helpers'}`;

/**
 * An agent's helpers in one line: the ones that stopped with no result, or
 * else the ones that run. Null: nothing to say.
 */
export function helperLine(helpers: readonly Helper[]): string | null {
  const lost = helpers.filter((helper) => helper.state === 'lost').length;
  if (lost) return `${counted(lost)} stopped with no result`;
  const running = helpers.filter((helper) => helper.state === 'running').length;
  return running ? counted(running) : null;
}
