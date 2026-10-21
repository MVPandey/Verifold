import {
  act,
  isBringRead,
  isFileDiff,
  isTurnDetail,
  isTurnPage,
  load,
  paths,
} from './api.ts';
import type { AnswerActions } from './screens/AnswerPage.tsx';
import type { AgentActions } from './screens/DirectionPage.tsx';
import type { LabActions } from './screens/LabHome.tsx';

const signedOut = (): Promise<{ readonly refused: string }> =>
  Promise.resolve({ refused: 'This tab has no access key.' });

const unread = (): Promise<{ readonly error: string }> =>
  Promise.resolve({ error: 'This tab has no access key.' });

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

/**
 * The reads and writes of the direction and turn pages. A message to a
 * direction is a plain post in it, which wakes its agent (Board.wakes).
 * Without a token, each one is refused at once.
 */
export function agentActions(token: string | null): AgentActions {
  if (!token) return { message: signedOut, turns: unread, turn: unread };
  return {
    message: (direction, text, key) =>
      act(token, 'lab-post', { text, direction }, key),
    turns: (agent, before, signal) =>
      load(token, paths.turns(agent, before), isTurnPage, signal),
    turn: (agent, turn, query, signal) =>
      load(token, paths.turn(agent, turn, query), isTurnDetail, signal),
  };
}

/**
 * The answer and bring-in pages' actions and reads: the desk's sign-off,
 * look, and bring-in, with all of the desk's checks. Without a token, each
 * one is refused at once.
 */
export function answerActions(token: string | null): AnswerActions {
  if (!token)
    return {
      signOff: signedOut,
      look: signedOut,
      bring: signedOut,
      read: unread,
      diff: unread,
    };
  return {
    signOff: (note, key) =>
      act(token, 'lab-signoff', note ? { note } : {}, key),
    look: (direction, key) => act(token, 'lab-bring-look', { direction }, key),
    bring: (direction, commit, files, key) =>
      act(token, 'lab-bring', { direction, commit, files }, key),
    read: (direction, signal) =>
      load(token, paths.bring(direction), isBringRead, signal),
    diff: (direction, file, commit, signal) =>
      load(token, paths.bringDiff(direction, file, commit), isFileDiff, signal),
  };
}
