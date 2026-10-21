import { createContext } from 'react';
import type {
  BoardPage,
  DirectionDiff,
  Harness,
  RunDetail,
} from '../protocol/api.ts';
import {
  act,
  isBoardPage,
  isDirectionDiff,
  isRunDetail,
  load,
  paths,
  type ActOutcome,
  type Loaded,
} from './api.ts';

/** A direction that the person opens: its title, the harness of its agent, and its bar, which can be empty. */
export interface NewDirection {
  readonly title: string;
  readonly harness: Harness;
  readonly bar: string;
}

/**
 * The lab's controls and its reads in depth: open a direction, stop it,
 * start its agent again, cancel a run, give the lab more time, dismiss the
 * background actions that failed, reply to a post, and read a run, a
 * direction's diff, or older posts of the board. They run the actions that
 * the desk runs for the same buttons, with each key of the person's intent
 * (see intent.ts). The app provides them. A page rendered without them, as
 * in a test, shows none of the controls.
 */
export interface LabControls {
  readonly addDirection: (
    direction: NewDirection,
    key: string,
  ) => Promise<ActOutcome>;
  readonly stopDirection: (
    direction: string,
    key: string,
  ) => Promise<ActOutcome>;
  readonly restartAgent: (agent: string, key: string) => Promise<ActOutcome>;
  readonly cancelRun: (run: string, key: string) => Promise<ActOutcome>;
  /** More hours after the time budget ended. */
  readonly moreTime: (hours: number, key: string) => Promise<ActOutcome>;
  /** Clear every background action that failed. */
  readonly dismiss: (key: string) => Promise<ActOutcome>;
  readonly reply: (
    post: string,
    text: string,
    key: string,
  ) => Promise<ActOutcome>;
  readonly run: (
    id: string,
    signal?: AbortSignal,
  ) => Promise<Loaded<RunDetail>>;
  readonly diff: (
    direction: string,
    query: { readonly file?: string; readonly proof?: string },
    signal?: AbortSignal,
  ) => Promise<Loaded<DirectionDiff>>;
  /** The page of the board before a post. */
  readonly board: (
    before: string,
    signal?: AbortSignal,
  ) => Promise<Loaded<BoardPage>>;
}

export const ControlsContext = createContext<LabControls | null>(null);

export function labControls(token: string): LabControls {
  return {
    addDirection: ({ title, harness, bar }, key) =>
      act(
        token,
        'lab-direction-add',
        { title, harness, ...(bar ? { bar } : {}) },
        key,
      ),
    stopDirection: (direction, key) =>
      act(token, 'lab-direction-stop', { direction }, key),
    restartAgent: (agent, key) =>
      act(token, 'lab-agent-restart', { agent }, key),
    cancelRun: (run, key) => act(token, 'lab-run-cancel', { run }, key),
    moreTime: (hours, key) => act(token, 'lab-budget', { hours }, key),
    dismiss: (key) => act(token, 'lab-dismiss', {}, key),
    reply: (post, text, key) =>
      act(token, 'lab-post', { text, replyTo: post }, key),
    run: (id, signal) => load(token, paths.run(id), isRunDetail, signal),
    diff: (direction, query, signal) =>
      load(token, paths.diff(direction, query), isDirectionDiff, signal),
    board: (before, signal) =>
      load(token, paths.board(before), isBoardPage, signal),
  };
}
