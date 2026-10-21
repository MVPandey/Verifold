import type { SearchResult } from '../protocol/api.ts';
import {
  act,
  isBringRead,
  isFileDiff,
  isPostThread,
  isTurnDetail,
  isTurnPage,
  load,
  paths,
  type ActOutcome,
  type Loaded,
} from './api.ts';
import { newKey } from './intent.ts';
import { isSearchResult, searchPath } from './search.ts';
import type { AnswerActions } from './screens/AnswerPage.tsx';
import type { AgentActions } from './screens/DirectionPage.tsx';
import type { LabActions } from './screens/LabHome.tsx';
import type { LabStart } from './screens/Notice.tsx';

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
      skip: signedOut,
      questions: signedOut,
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
    skip: (key) => act(token, 'lab-skip-questions', {}, key),
    questions: (answers, key) =>
      act(token, 'lab-questions-answer', { answers }, key),
  };
}

/**
 * The reads and writes of the direction, turn, and post pages. A message to
 * a direction is a plain post in it, which wakes its agent (Board.wakes).
 * Without a token, each one is refused at once.
 */
export function agentActions(token: string | null): AgentActions {
  if (!token)
    return { message: signedOut, turns: unread, turn: unread, thread: unread };
  return {
    message: (direction, text, key) =>
      act(token, 'lab-post', { text, direction }, key),
    turns: (agent, before, signal) =>
      load(token, paths.turns(agent, before), isTurnPage, signal),
    turn: (agent, turn, query, signal) =>
      load(token, paths.turn(agent, turn, query), isTurnDetail, signal),
    thread: (post, signal) =>
      load(token, paths.thread(post), isPostThread, signal),
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

/** The app's own reads and writes: the search, dismissing the time away, and the person's look. */
export interface AppActions {
  readonly search: (
    q: string,
    signal: AbortSignal,
  ) => Promise<Loaded<SearchResult>>;
  readonly dismissAway: (key: string) => Promise<ActOutcome>;
  /** The person looks at the lab now. It needs no intent: a look again is harmless. */
  readonly look: () => Promise<ActOutcome>;
  /** Start the project's lab on a question, with a time budget, as the desk's Start the lab does. */
  readonly startLab: (start: LabStart, key: string) => Promise<ActOutcome>;
}

export function appActions(token: string | null): AppActions {
  if (!token)
    return {
      search: unread,
      dismissAway: signedOut,
      look: signedOut,
      startLab: signedOut,
    };
  return {
    search: (q, signal) => load(token, searchPath(q), isSearchResult, signal),
    dismissAway: (key) => act(token, 'lab-away-dismiss', {}, key),
    look: () => act(token, 'lab-look', {}, newKey()),
    startLab: ({ question, hours }, key) =>
      act(token, 'lab-start', { question, hours }, key),
  };
}
