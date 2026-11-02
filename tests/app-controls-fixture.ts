import type { LabControls } from '../src/app/controls.ts';

const ok = (): Promise<{ ok: true }> => Promise.resolve({ ok: true });
const unread = (): Promise<{ error: string }> =>
  Promise.resolve({ error: 'not in this test' });

/** The lab's controls of a page in a test: each action is taken, and nothing reads. */
export const controls: LabControls = {
  addDirection: ok,
  stopDirection: ok,
  reopenDirection: ok,
  restartAgent: ok,
  cancelRun: ok,
  moreTime: ok,
  dismiss: ok,
  reply: ok,
  run: unread,
  diff: unread,
  board: unread,
  threadPage: unread,
  askStory: ok,
  writeThread: ok,
  writeTo: ok,
  object: ok,
  askCheck: ok,
  overturn: ok,
  askCoordinator: ok,
  draw: ok,
  stopLongShots: ok,
  reach: unread,
  collab: unread,
  ideas: unread,
  figure: unread,
};
