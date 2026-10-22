import { createContext, useContext } from 'react';
import type {
  BoardPage,
  DirectionDiff,
  Harness,
  RunDetail,
  Work,
} from '../protocol/api.ts';
import { signedOut } from './actions.ts';
import {
  act,
  isBoardPage,
  isDirectionDiff,
  isRunDetail,
  load,
  loadBlob,
  paths,
  type ActOutcome,
  type Loaded,
} from './api.ts';
import { useAction, type Action } from './useAction.ts';

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
  /** Clear the background actions that failed and that the page shows, by their action and start. */
  readonly dismiss: (
    works: readonly Pick<Work, 'action' | 'at'>[],
    key: string,
  ) => Promise<ActOutcome>;
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
  /** The figure that a post cites, such as p-12.0: its bytes, as the post pinned them. */
  readonly figure: (
    proof: string,
    signal?: AbortSignal,
  ) => Promise<Loaded<Blob>>;
}

export const ControlsContext = createContext<LabControls | null>(null);

/**
 * A control on a page: the lab's controls, and the action that runs `run`
 * with them, with each key of the person's intent. On a page without the
 * controls, as in a test, `controls` is null: the page shows no control,
 * and the action is refused.
 */
export function useControl<T>(
  run: (controls: LabControls, value: T, key: string) => Promise<ActOutcome>,
  same?: (a: T, b: T) => boolean,
): { readonly controls: LabControls | null; readonly action: Action<T> } {
  const controls = useContext(ControlsContext);
  const action = useAction<T>(
    (value, key) => (controls ? run(controls, value, key) : signedOut()),
    same,
  );
  return { controls, action };
}

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
    dismiss: (works, key) =>
      act(
        token,
        'lab-dismiss',
        { works: works.map(({ action, at }) => ({ action, at })) },
        key,
      ),
    reply: (post, text, key) =>
      act(token, 'lab-post', { text, replyTo: post }, key),
    run: (id, signal) => load(token, paths.run(id), isRunDetail, signal),
    diff: (direction, query, signal) =>
      load(token, paths.diff(direction, query), isDirectionDiff, signal),
    board: (before, signal) =>
      load(token, paths.board(before), isBoardPage, signal),
    figure: (proof, signal) => loadBlob(token, paths.figure(proof), signal),
  };
}
