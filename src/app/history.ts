import { createContext } from 'react';
import type {
  FileDiff,
  HistoryEntry,
  HistoryList,
  HistoryRun,
  HistoryTask,
  HistoryTurns,
} from '../protocol/api.ts';
import {
  act,
  isFileDiff,
  isHistoryList,
  isHistoryRun,
  isHistoryTask,
  isHistoryTurns,
  load,
  paths,
  type ActOutcome,
  type Loaded,
} from './api.ts';

/**
 * History's reads, and Start over. The app provides them. A page rendered
 * without them, as in a test, reads nothing and offers no Start over.
 */
export interface HistoryTools {
  readonly list: (signal?: AbortSignal) => Promise<Loaded<HistoryList>>;
  readonly run: (
    id: string,
    signal?: AbortSignal,
  ) => Promise<Loaded<HistoryRun>>;
  readonly task: (
    id: string,
    task: string,
    signal?: AbortSignal,
  ) => Promise<Loaded<HistoryTask>>;
  /** The turns of `attempt:<id>` or `session:<id>` in a run. */
  readonly turns: (
    id: string,
    source: string,
    signal?: AbortSignal,
  ) => Promise<Loaded<HistoryTurns>>;
  readonly diff: (
    id: string,
    task: string,
    version: number,
    file: string,
    signal?: AbortSignal,
  ) => Promise<Loaded<FileDiff>>;
  /** Archive the current run. Nothing starts after it: the person starts a lab on the question. */
  readonly startOver: (key: string) => Promise<ActOutcome>;
}

export const HistoryContext = createContext<HistoryTools | null>(null);

export function historyTools(token: string | null): HistoryTools | null {
  if (!token) return null;
  return {
    list: (signal) => load(token, paths.history, isHistoryList, signal),
    run: (id, signal) =>
      load(token, paths.historyRun(id), isHistoryRun, signal),
    task: (id, task, signal) =>
      load(token, paths.historyTask(id, task), isHistoryTask, signal),
    turns: (id, source, signal) =>
      load(token, paths.historyTurns(id, source), isHistoryTurns, signal),
    diff: (id, task, version, file, signal) =>
      load(
        token,
        paths.historyDiff(id, task, version, file),
        isFileDiff,
        signal,
      ),
    startOver: (key) => act(token, 'start-over', { lab: true }, key),
  };
}

/** What Start over keeps for the next run. */
export const startOverKeeps: readonly string[] = [
  'the question, which you can change before the lab starts',
  "the project's settings, such as its agents and GPU limits",
  'the project memory, which notes that a run ended',
  'the files in the project folder',
];

/** What Start over moves into the archive. */
export const startOverMoves: readonly string[] = [
  'the lab: its plan, directions, board, runs, and checks',
  "the agents' sessions and their transcripts",
  'research attempts, tasks, messages, and results of the earlier research flow, if the run has them',
];

/** "A lab's run" or "A research-flow run", as History names the kind. */
export function kindName(entry: Pick<HistoryEntry, 'kind'>): string {
  return entry.kind === 'lab'
    ? "A lab's run"
    : 'A run of the earlier research flow';
}

/** A time in History, such as "Oct 21, 14:05", in this computer's time zone. */
export function archivedAt(at: string): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/** "1 command" or "3 commands". */
export function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A research step's phase in plain words. */
export const phaseNames: Readonly<Record<string, string>> = {
  'needs-plan': 'Planning',
  'awaiting-plan-review': 'Plan for your review',
  'needs-research': 'Research',
  directions: 'Directions',
};
