import type { HarnessName } from './harness.ts';
import { labLimits, type Check, type DirectionView } from './lab.ts';
import { hostName } from './session.ts';
import type { TranscriptEntry } from './transcript.ts';

/**
 * What an agent did, read from its harness's transcript: its turns, the
 * steps of each turn by kind, and one live line. All of it comes from
 * harness events. The model's own words show only as its messages, never
 * as its state.
 */

/** A shell command in plain words: the program that it runs, and the file that the program gets. */
function commandStep(command: string): string {
  const step = command
    .split(/\n|&&|\|\||;/)
    .map((part) => part.trim())
    .find((part) => part && !/^(cd|export|set|source)\b/.test(part));
  const [program = '', ...rest] = (step ?? '').split(/\s+/);
  const name = program.split('/').at(-1) ?? '';
  if (!/^[\w.+-]+$/.test(name) || /^(for|while|if|do|then|case)$/.test(name))
    return 'Running a command';
  // A script comes first, then any other file: `python -m cProfile -o out.prof bench.py` runs bench.py.
  const files = rest.filter((word) => /^[\w./-]+\.\w+$/.test(word));
  const script =
    files.find((word) => /\.(py|js|mjs|cjs|ts|sh|r|jl|rb|pl)$/i.test(word)) ??
    files[0];
  return `Running ${name}${script ? ` ${script.split('/').at(-1)}` : ''}`;
}

/** A tool call in plain words, for a Now line. The tool name and the full input stay in the transcript. */
export function toolStep(tool: string, action = ''): string {
  const path = action.split(', ')[0]?.split(/[\\/]/).filter(Boolean).at(-1);
  switch (tool.replace(/^mcp__\w+?__/, '')) {
    case 'Bash':
    case 'Command':
      return commandStep(action);
    case 'Read':
      return path ? `Reading ${path}` : 'Reading a file';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'File change':
      return path ? `Writing ${path}` : 'Writing a file';
    case 'Grep':
    case 'Glob':
      return 'Searching the files';
    case 'WebSearch':
    case 'Web search':
      return 'Searching the web';
    case 'WebFetch':
      return 'Reading a web page';
    case 'Task':
    case 'Agent':
      return 'Starting a helper agent';
    case 'verifold_post':
      return 'Writing a note';
    case 'verifold_block':
      return 'Asking for help';
    case 'verifold_object':
      return 'Raising an objection';
    case 'verifold_pod_run':
    case 'verifold_pod_job':
    case 'verifold_pod_copy':
      return 'Working on the GPU pod';
    default:
      return 'Working';
  }
}

/** What a tool call does, as a turn's summary counts it. */
export type StepKind =
  | 'search'
  | 'page'
  | 'read'
  | 'command'
  | 'edit'
  | 'run'
  | 'post'
  | 'helper'
  | 'other';

/** Tools by the kind of step, for both harnesses. Any other tool counts as `other`. */
const kindOfTool = new Map<string, StepKind>([
  ['WebSearch', 'search'],
  ['Web search', 'search'],
  ['WebFetch', 'page'],
  ['Read', 'read'],
  ['Grep', 'read'],
  ['Glob', 'read'],
  ['LS', 'read'],
  ['NotebookRead', 'read'],
  ['Bash', 'command'],
  ['Command', 'command'],
  ['BashOutput', 'command'],
  ['KillShell', 'command'],
  ['Write', 'edit'],
  ['Edit', 'edit'],
  ['MultiEdit', 'edit'],
  ['NotebookEdit', 'edit'],
  ['File change', 'edit'],
  ['verifold_run', 'run'],
  ['verifold_pod_run', 'run'],
  ['verifold_pod_job', 'run'],
  ['verifold_post', 'post'],
  ['verifold_plan', 'post'],
  ['verifold_direction', 'post'],
  ['verifold_ask_person', 'post'],
  ['verifold_object', 'post'],
  ['verifold_block', 'post'],
  ['Task', 'helper'],
  ['Agent', 'helper'],
  ['Agents', 'helper'],
]);

/** The kind of a tool call, by its name. Claude Code's MCP prefix and Codex's server name do not count. */
export function stepKind(tool: string): StepKind {
  const name = tool.replace(/^mcp__\w+?__/, '').replace(/^[\w-]+\.(?=\w)/, '');
  return kindOfTool.get(name) ?? 'other';
}

/** One turn of an agent: what started it, what it did, and what it said last. */
export interface ActivityTurn {
  /** The ID of the entry that started it. */
  readonly id: string;
  readonly startedAt: string;
  /** The newest change in the turn. */
  readonly lastAt: string;
  /** The message that started it: Verifold's prompt or the person's. Null for work before the first one. */
  readonly request: TranscriptEntry | null;
  /** Its entries in creation order, with the request and any subagent work. */
  readonly entries: readonly TranscriptEntry[];
  /** Tool calls by kind, subagent calls too. */
  readonly counts: Readonly<Record<StepKind, number>>;
  /** The agent's last message in the turn. A subagent's message does not count. */
  readonly message: string | null;
  /** The agent's newest tool call that still runs, or null. */
  readonly running: TranscriptEntry | null;
}

/**
 * The turns of a transcript, oldest first. A turn starts at a message to the
 * agent, Verifold's prompt or the person's, and holds everything up to the
 * next one. A message that comes before the agent did anything belongs to
 * the same turn, so a prompt and a quick steer make one turn.
 */
export function turnsOf(entries: readonly TranscriptEntry[]): ActivityTurn[] {
  const groups: TranscriptEntry[][] = [];
  for (const entry of [...entries].sort((a, b) => a.order - b.order)) {
    const current = groups.at(-1);
    const opens =
      entry.kind === 'request' &&
      entry.parent === null &&
      current?.some((item) => item.kind !== 'request' && item.kind !== 'note');
    if (!current || opens) groups.push([entry]);
    else current.push(entry);
  }
  return groups.map((group) => {
    const counts: Record<StepKind, number> = {
      search: 0,
      page: 0,
      read: 0,
      command: 0,
      edit: 0,
      run: 0,
      post: 0,
      helper: 0,
      other: 0,
    };
    let message: string | null = null;
    let running: TranscriptEntry | null = null;
    let lastAt = '';
    for (const entry of group) {
      const at = entry.updatedAt ?? entry.at;
      if (at > lastAt) lastAt = at;
      if (entry.kind === 'tool') {
        counts[stepKind(entry.name ?? '')] += 1;
        if (entry.parent === null && entry.status === 'running')
          running = entry;
      }
      if (entry.kind === 'text' && entry.parent === null)
        message = entry.text ?? null;
    }
    const first = group[0];
    return {
      id: first?.id ?? '',
      startedAt: first?.at ?? '',
      lastAt,
      request:
        first?.kind === 'request' && first.parent === null ? first : null,
      entries: group,
      counts,
      message,
      running,
    };
  });
}

/**
 * `working`: a turn runs. `waiting`: it waits for the person, a free slot,
 * a usage window, or its next turn. `idle`: between turns, or paused.
 * `ended`: its direction or its check ended.
 */
export type LiveState = 'working' | 'waiting' | 'idle' | 'ended';

/** One line about an agent now, and when that state or step began. */
export interface Live {
  readonly state: LiveState;
  readonly text: string;
  readonly since: string | null;
}

/** The step that runs now in a turn, in plain words. */
function working(turn: ActivityTurn | null): Live {
  const step = turn?.running;
  if (step)
    return {
      state: 'working',
      text: toolStep(step.name ?? '', step.title ?? ''),
      since: step.at,
    };
  const last = turn?.entries.findLast((entry) => entry.parent === null);
  return {
    state: 'working',
    text:
      last?.kind === 'thinking'
        ? 'Thinking'
        : last?.kind === 'text'
          ? 'Writing'
          : 'Working',
    since: last?.updatedAt ?? last?.at ?? turn?.startedAt ?? null,
  };
}

/**
 * An agent's live line, from its state in the lab and its newest turn. A
 * direction's agent has the states of `DirectionView`, and a checker those
 * of its check. `asked`: when the agent asked the person a call that still
 * waits. `until`: the end of a wait, which the app shows next to the line.
 */
export function liveOf(input: {
  readonly status: DirectionView['status'] | Check['state'];
  readonly harness: HarnessName;
  readonly turn: ActivityTurn | null;
  readonly asked: string | null;
}): Live {
  const since = input.turn?.lastAt ?? null;
  switch (input.status) {
    case 'working':
    case 'running':
      return working(input.turn);
    case 'starting':
      return { state: 'working', text: 'Starting', since };
    case 'terminal':
      return { state: 'working', text: 'You hold its terminal', since };
    case 'idle':
      return input.asked
        ? { state: 'waiting', text: 'Waiting for you', since: input.asked }
        : { state: 'idle', text: 'Between turns', since };
    case 'plan':
      return { state: 'idle', text: 'Starts with the plan', since: null };
    case 'paused':
      return { state: 'idle', text: 'Paused', since };
    case 'slot':
      return { state: 'waiting', text: 'Waits for a free agent slot', since };
    case 'usage':
      return {
        state: 'waiting',
        text: `Waits for ${hostName(input.harness)}'s usage window`,
        since,
      };
    case 'turns':
      return {
        state: 'waiting',
        text: `Waits for its next turn: ${labLimits.wakeupsPerHour} turns an hour`,
        since,
      };
    case 'queued':
      return { state: 'waiting', text: 'Waits to start its check', since };
    case 'stopped':
      return { state: 'ended', text: 'Stopped', since };
    case 'closed':
      return { state: 'ended', text: 'Closed by its agent', since };
    case 'crashed':
      return { state: 'ended', text: 'Stopped by itself too often', since };
    case 'done':
      return { state: 'ended', text: 'Check done', since };
    case 'failed':
      return { state: 'ended', text: 'Check failed', since };
    case 'dropped':
      return { state: 'ended', text: 'Check dropped', since };
  }
}
