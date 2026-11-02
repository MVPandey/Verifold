import { createContext, useContext } from 'react';
import type {
  BoardPage,
  CollabPage,
  DirectionDiff,
  Harness,
  IdeaPage,
  Reach,
  RunDetail,
  ThreadPage,
  Work,
} from '../protocol/api.ts';
import { signedOut } from './actions.ts';
import {
  act,
  isBoardPage,
  isCollabPage,
  isDirectionDiff,
  isIdeaPage,
  isReach,
  isRunDetail,
  isThreadPage,
  load,
  loadFile,
  paths,
  type ActOutcome,
  type Loaded,
  type SentFile,
} from './api.ts';
import { newKey } from './intent.ts';
import { useAction, type Action } from './useAction.ts';

/** A direction that the person opens: its title, the harness of its agent, and its bar, which can be empty. */
export interface NewDirection {
  readonly title: string;
  readonly harness: Harness;
  readonly bar: string;
}

/** Where the person's words go, as `GET /api/v1/reach` takes it. */
export interface ReachQuery {
  readonly thread?: string | undefined;
  /** An agent ID, or `all`. */
  readonly to?: string | undefined;
  readonly replyTo?: string | undefined;
  /** The `@` names of the text. */
  readonly named?: string | undefined;
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
  /** Bring back an ended direction's agent. `thread`: the thread that it comes back to. */
  readonly reopenDirection: (
    direction: string,
    thread: string | null,
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
  /** A thread with its story, and its newest posts or those before a post. */
  readonly threadPage: (
    thread: string,
    before?: string,
    signal?: AbortSignal,
  ) => Promise<Loaded<ThreadPage>>;
  /** Ask for a thread's story. It needs no intent: a second ask changes nothing. */
  readonly askStory: (thread: string) => Promise<ActOutcome>;
  /** Write to a thread, as a post that replies to no post. */
  readonly writeThread: (
    thread: string,
    text: string,
    key: string,
  ) => Promise<ActOutcome>;
  /** Write to one agent, or with `all` to every agent. */
  readonly writeTo: (
    thread: string | null,
    to: string,
    text: string,
    key: string,
  ) => Promise<ActOutcome>;
  /** The person's objection to a post. */
  readonly object: (
    post: string,
    text: string,
    key: string,
  ) => Promise<ActOutcome>;
  readonly askCheck: (post: string, key: string) => Promise<ActOutcome>;
  readonly overturn: (thread: string, key: string) => Promise<ActOutcome>;
  readonly askCoordinator: (text: string, key: string) => Promise<ActOutcome>;
  readonly draw: (key: string) => Promise<ActOutcome>;
  readonly stopLongShots: (key: string) => Promise<ActOutcome>;
  /** Who the person's words reach, from the rule that wakes agents. */
  readonly reach: (
    query: ReachQuery,
    signal?: AbortSignal,
  ) => Promise<Loaded<Reach>>;
  readonly collab: (signal?: AbortSignal) => Promise<Loaded<CollabPage>>;
  readonly ideas: (signal?: AbortSignal) => Promise<Loaded<IdeaPage>>;
  /** The figure that a post cites, such as p-12.0: its bytes, as the post pinned them, and its name. */
  readonly figure: (
    proof: string,
    signal?: AbortSignal,
  ) => Promise<Loaded<SentFile>>;
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
    reopenDirection: (direction, thread, key) =>
      act(
        token,
        'lab-direction-reopen',
        { direction, ...(thread ? { thread } : {}) },
        key,
      ),
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
    threadPage: (thread, before, signal) =>
      load(token, paths.threadPage(thread, before), isThreadPage, signal),
    askStory: (thread) => act(token, 'lab-story', { thread }, newKey()),
    writeThread: (thread, text, key) =>
      act(token, 'lab-post', { text, thread }, key),
    writeTo: (thread, to, text, key) =>
      act(token, 'lab-post', { text, to, ...(thread ? { thread } : {}) }, key),
    object: (post, text, key) =>
      act(token, 'lab-post', { text, kind: 'objection', replyTo: post }, key),
    askCheck: (post, key) => act(token, 'lab-check', { post }, key),
    overturn: (thread, key) => act(token, 'lab-overturn', { thread }, key),
    askCoordinator: (text, key) => act(token, 'lab-ask', { text }, key),
    draw: (key) => act(token, 'lab-draw', {}, key),
    stopLongShots: (key) => act(token, 'lab-long-shots-stop', {}, key),
    reach: (query, signal) => load(token, paths.reach(query), isReach, signal),
    collab: (signal) => load(token, paths.collab, isCollabPage, signal),
    ideas: (signal) => load(token, paths.ideas, isIdeaPage, signal),
    figure: (proof, signal) => loadFile(token, paths.figure(proof), signal),
  };
}
