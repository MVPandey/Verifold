import { act } from './api.ts';
import type { LabActions } from './screens/LabHome.tsx';

const signedOut = (): Promise<{ readonly refused: string }> =>
  Promise.resolve({ refused: 'This tab has no access key.' });

/**
 * The lab actions that the app's pages send, each with the key of the
 * person's intent (see intent.ts). They are the actions that the desk runs
 * for the same buttons. Without a token, each one is refused at once.
 */
export function labActions(token: string | null): LabActions {
  if (!token)
    return {
      post: signedOut,
      pause: signedOut,
      answer: signedOut,
      words: signedOut,
      undo: signedOut,
    };
  return {
    post: (text, key) => act(token, 'lab-post', { text }, key),
    pause: (pause, key) =>
      act(token, pause ? 'lab-pause' : 'lab-resume', {}, key),
    answer: (call, option, key) =>
      act(token, 'lab-call-answer', { call, option }, key),
    words: (call, text, key) =>
      act(token, 'lab-call-words', { call, text }, key),
    undo: (call, key) => act(token, 'lab-call-undo', { call }, key),
  };
}
