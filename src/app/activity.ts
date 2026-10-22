import type {
  Step,
  StepCounts,
  StepKind,
  StepType,
  Turn,
} from '../protocol/api.ts';
import type { StepQuery } from './api.ts';
import { span } from './format.ts';

/** Each kind of tool call as a counted noun, in the order a turn's line names them. */
const nouns: readonly (readonly [StepKind, string, string])[] = [
  ['search', 'search', 'searches'],
  ['page', 'page', 'pages'],
  ['read', 'file read', 'files read'],
  ['command', 'command', 'commands'],
  ['edit', 'edit', 'edits'],
  ['run', 'run', 'runs'],
  ['post', 'post', 'posts'],
  ['helper', 'helper', 'helpers'],
  ['other', 'other tool call', 'other tool calls'],
];

/** What a turn's tool calls did, counted: ["9 commands", "1 run"]. Kinds with no calls are left out. */
export function counted(counts: StepCounts): string[] {
  return nouns
    .filter(([kind]) => counts[kind] > 0)
    .map(([kind, one, many]) =>
      counts[kind] === 1 ? `1 ${one}` : `${counts[kind]} ${many}`,
    );
}

/** Tool calls of all kinds in a turn. */
export function stepTotal(turn: Turn): number {
  return nouns.reduce((sum, [kind]) => sum + turn.counts[kind], 0);
}

/**
 * When a turn's steps must be read again: its revision moved (a step started
 * or ended, its output grew, or text arrived), or the turn ended. An older
 * server sends no revision: then a new tool call or new words move the key.
 */
export function refreshKey(turn: Turn): string {
  const rev =
    turn.rev ?? `${stepTotal(turn)}+${turn.message?.text.length ?? 0}`;
  return `${rev}|${turn.endedAt ?? ''}`;
}

/** How many tool calls an open fold reads and lists before "Open every step". */
export const foldSteps = 8;

/**
 * What an open fold reads: the turn's newest tool calls. An older server
 * takes no `limit` or `tools`, and sends no `rev` (see `TurnDetail`). From
 * it the fold reads the newest page, and the list keeps its tool calls.
 */
export function foldQuery(turn: Turn): StepQuery {
  return turn.rev === undefined ? {} : { limit: foldSteps, tools: true };
}

/**
 * A turn in one line, as the Claude Code and Codex apps fold their work:
 * "Worked 24 min · 9 commands · 1 run". While the turn runs:
 * "Working · 6 min · 3 commands".
 */
export function turnSummary(turn: Turn, now: number): string {
  const end = turn.endedAt ? Date.parse(turn.endedAt) : now;
  const took = span(end - Date.parse(turn.startedAt));
  return [
    turn.endedAt ? `Worked ${took}` : `Working · ${took}`,
    ...counted(turn.counts),
  ].join(' · ');
}

const done: Record<StepKind, string> = {
  search: 'Searched',
  page: 'Read',
  read: 'Read',
  command: 'Ran',
  edit: 'Edited',
  run: 'Ran',
  post: 'Posted',
  helper: 'Started',
  other: 'Used',
};

const running: Record<StepKind, string> = {
  search: 'Searching',
  page: 'Reading',
  read: 'Reading',
  command: 'Running',
  edit: 'Editing',
  run: 'Running',
  post: 'Posting',
  helper: 'Starting',
  other: 'Using',
};

const plain: Record<Exclude<StepType, 'tool'>, string> = {
  request: 'Message',
  text: 'Wrote',
  thinking: 'Thought',
  note: 'Note',
};

/** The verb of a step: past tense when it ended, present while it runs. */
export function stepVerb(step: Step): string {
  if (step.type !== 'tool') return plain[step.type];
  const kind = step.kind ?? 'other';
  return step.status === 'running' ? running[kind] : done[kind];
}

/** The first line of a text, at most 140 characters. */
function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

/** What a step acted on: the query, the page, the file, the command, or the first line of its words. */
export function stepWhat(step: Step): string {
  if (step.type !== 'tool') return firstLine(step.text?.text ?? '');
  const title = step.title?.trim() ?? '';
  switch (step.kind) {
    case 'search':
      return title ? `"${title}"` : 'the web';
    case 'helper':
      return title ? `a helper agent: ${title}` : 'a helper agent';
    case 'other':
    case null:
      return title ? `a tool: ${title}` : 'a tool';
    default:
      return title || step.words;
  }
}

/** A step whose "what" is a command line, shown in a fixed-width face. */
export function commandLike(step: Step): boolean {
  return step.type === 'tool' && step.kind === 'command';
}

/** How long a step took, when it ended: "19 min". */
export function stepTook(step: Step): string | null {
  return step.endedAt
    ? span(Date.parse(step.endedAt) - Date.parse(step.at))
    : null;
}

/** A command that ended well within this time is short. */
const shortMs = 10_000;

/** Short commands in a row fold into one line when there are at least this many. */
const foldMin = 3;

/**
 * A command that starts work in the background: Claude Code's Bash with
 * `run_in_background`, or a command line that starts with `nohup` or ends
 * with `&`. It ends at once, but its work goes on, so it is never short.
 */
function background(step: Step): boolean {
  const command = step.title?.trim() ?? '';
  return (
    /^nohup\b/.test(command) ||
    /(?:^|[^&])&$/.test(command) ||
    /"run_in_background"\s*:\s*true/.test(step.input?.text ?? '')
  );
}

function short(step: Step): boolean {
  return (
    commandLike(step) &&
    step.status === 'done' &&
    step.endedAt !== null &&
    Date.parse(step.endedAt) - Date.parse(step.at) < shortMs &&
    !background(step)
  );
}

/** A line of a step list: one step, or short commands in a row with the thoughts between them. */
export type StepLine =
  | { readonly step: Step }
  | { readonly steps: readonly Step[]; readonly commands: number };

/**
 * Steps as the lines of a list. Short commands in a row fold into one line,
 * "Ran 5 short commands", as on the v9 turn artboard. Thoughts between them
 * fold in with them. Any other step ends the row: a command that runs,
 * failed, took longer, or works in the background, words, and any other
 * tool call. `live`: the turn still runs, so the row that reaches its
 * newest step stays unfolded, as it can still grow.
 */
export function stepLines(steps: readonly Step[], live: boolean): StepLine[] {
  const shortAt = steps.map(short);
  const lines: StepLine[] = [];
  // The first step that is not on a line yet.
  let next = 0;
  for (const [at, step] of steps.entries()) {
    if (at < next) continue;
    if (!shortAt[at]) {
      lines.push({ step });
      continue;
    }
    // The row runs to its last short command. Thoughts after that one are not part of it.
    let last = at;
    let end = at;
    let commands = 0;
    while (
      end < steps.length &&
      (shortAt[end] || steps[end]?.type === 'thinking')
    ) {
      if (shortAt[end]) {
        last = end;
        commands += 1;
      }
      end += 1;
    }
    const row = steps.slice(at, last + 1);
    if (commands >= foldMin && !(live && end === steps.length))
      lines.push({ steps: row, commands });
    else lines.push(...row.map((entry) => ({ step: entry })));
    next = last + 1;
  }
  return lines;
}
