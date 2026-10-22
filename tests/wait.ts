import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Wait until `check` holds, for at most `ms`. A test waits for the state it
 * means, such as a saved file or a sent wakeup, not for a fixed time that a
 * busy computer can pass. The limit only ends a test that is stuck.
 */
export async function until(
  check: () => boolean | Promise<boolean>,
  ms = 10_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end)
      throw new Error(`The condition did not hold in ${ms} ms.`);
    await delay(10);
  }
}

/**
 * The JSON lines of a fake harness's log. A fake can be in the middle of
 * writing a line, so only lines that end with a newline count.
 */
export async function jsonLines<T>(path: string): Promise<T[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line) as T);
}

/**
 * The lab's queue, as a test gives it to a run ledger, and a wait for the
 * work in it, such as the saves after a run ends.
 */
export function labQueue(): {
  readonly serial: <T>(work: () => T | Promise<T>) => Promise<T>;
  readonly settled: () => Promise<void>;
} {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    serial: <T>(work: () => T | Promise<T>): Promise<T> => {
      const next = queue.then(work, work);
      queue = next.catch(() => {});
      return next;
    },
    settled: async () => {
      await queue;
    },
  };
}
