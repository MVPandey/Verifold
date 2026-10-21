import {
  firstRanked,
  type LabScreen,
  type ScreenDirection,
} from '../server/screen.ts';
import { usd } from '../ui/call-words.ts';
import {
  directionLine,
  moneyLine,
  verdictLabels,
  type ShownVerdict,
} from '../ui/lab-lines.ts';
import { muted, tint, type Tone } from './terminal.ts';
import { fitText, visibleWidth } from './terminal-layout.ts';

/** How the view draws. */
export interface ViewOptions {
  readonly columns: number;
  readonly rows: number;
  readonly color: boolean;
  readonly now: number;
  /** Verifold's newest message, under the view. */
  readonly notice?: string | null;
}

/** The message line: its prompt, and the words that it shows while it is empty. */
export const prompt = {
  text: '  › ',
  empty: 'write to the lab, or @mention an agent',
} as const;

/** The rows of the view besides the directions and the notice, with the message line. */
const fixedRows = 9;

const hint =
  '/help: commands · ctrl+c: close this window (the lab keeps working)';

function bold(text: string, color: boolean): string {
  return color ? `\u001b[1m${text}\u001b[22m` : text;
}

/** `text` with spaces after it, to `width` cells. */
function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}

/** A row's mark and the colors of its mark and of its line. */
function markOf(direction: ScreenDirection): {
  readonly mark: string;
  readonly tone: Tone | 'muted' | null;
  readonly line: Tone | 'muted' | null;
} {
  if (direction.live?.state === 'waiting')
    return { mark: '!', tone: 'amber', line: 'amber' };
  if (direction.live?.state === 'working')
    return { mark: '●', tone: 'lavender', line: null };
  const marks: Record<
    ShownVerdict,
    {
      readonly mark: string;
      readonly tone: Tone | 'muted';
      readonly line: Tone | 'muted' | null;
    }
  > = {
    holds: { mark: '✓', tone: 'mint', line: 'mint' },
    disputed: { mark: '!', tone: 'amber', line: 'amber' },
    'ruled-out': { mark: '✗', tone: 'muted', line: 'muted' },
    leading: { mark: '↑', tone: 'lavender', line: null },
    open: { mark: '○', tone: 'muted', line: null },
    stopped: { mark: '–', tone: 'muted', line: 'muted' },
  };
  return marks[direction.shown];
}

function paint(
  text: string,
  tone: Tone | 'muted' | null,
  color: boolean,
): string {
  if (tone === null) return text;
  return tone === 'muted' ? muted(text, color) : tint(text, color, tone);
}

/**
 * What a direction's row says after its title, in the app's words: the live
 * step while its agent works, otherwise the verdict and its evidence, or a
 * wait for the person.
 */
export function rowText(direction: ScreenDirection, now: number): string {
  const line = directionLine(direction.evidence, direction.live, now);
  if (line.working) return line.text;
  return [
    direction.shown === 'open' ? '' : verdictLabels[direction.shown],
    line.text,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The live view of a lab, line by line, as in the "14 The terminal"
 * artboard: the project, the money line, one row per direction, the call
 * that waits, Verifold's newest message, and the keys. The message line
 * comes after these. Each line fits in `columns - 1` cells, and the view
 * leaves a free row on a screen of `rows`, so it never scrolls itself away.
 */
export function viewLines(screen: LabScreen, options: ViewOptions): string[] {
  const { color, now } = options;
  const width = Math.max(20, options.columns - 1);
  const notice = options.notice ? 1 : 0;
  const origin = `· ${screen.origin}`;
  const name = fitText(
    screen.project,
    Math.max(8, width - 2 - 'verifold'.length - 4 - visibleWidth(origin)),
  );
  const lines = [
    '',
    fitLine(
      `  ${bold(tint('verifold', color, 'lavender'), color)}  ${bold(name, color)}  ${muted(origin, color)}`,
      `  verifold  ${name}  ${origin}`,
      width,
    ),
    `  ${muted(
      fitText(
        moneyLine(screen.money, screen.deadline, now)
          .map((part) => part.map((piece) => piece.text).join(' '))
          .join(' · '),
        width - 2,
      ),
      color,
    )}`,
    '',
  ];
  // The rows that fit. "and N more" takes one of them when some do not.
  const room = Math.max(1, options.rows - 1 - fixedRows - notice);
  let rows = screen.directions;
  let more = screen.more;
  if (rows.length + (more ? 1 : 0) > room) {
    rows = firstRanked(rows, room - 1);
    more += screen.directions.length - rows.length;
  }
  if (!screen.directions.length && !more)
    lines.push(
      `  ${muted(fitText('The planner is reading. Directions show here when the plan is ready.', width - 2), color)}`,
    );
  const agentWidth = Math.min(
    12,
    Math.max(0, ...rows.map((entry) => visibleWidth(entry.agent ?? ''))),
  );
  // Indent, mark, and the gaps around the title and the agent.
  const both = width - 7 - (agentWidth ? agentWidth + 2 : 0);
  // A title gets the room that the lines do not need, and at least half.
  const widest = (texts: readonly string[]): number =>
    Math.max(0, ...texts.map((text) => visibleWidth(fitText(text, 400))));
  const titleWidth = Math.min(
    widest(rows.map((entry) => entry.title)),
    Math.max(
      12,
      Math.floor(both / 2),
      both - widest(rows.map((entry) => rowText(entry, now))),
    ),
  );
  for (const direction of rows) {
    const { mark, tone, line } = markOf(direction);
    const agent = agentWidth
      ? `${paint(pad(fitText(direction.agent ?? '', agentWidth), agentWidth), 'lavender', color)}  `
      : '';
    lines.push(
      `  ${paint(mark, tone, color)}  ${pad(fitText(direction.title, titleWidth), titleWidth)}  ${agent}${paint(
        fitText(rowText(direction, now), Math.max(1, both - titleWidth)),
        line,
        color,
      )}`,
    );
  }
  if (more) lines.push(`  ${muted(`and ${more} more`, color)}`);
  lines.push('', needsLine(screen, width, color), '');
  if (options.notice)
    lines.push(`  ${muted(fitText(options.notice, width - 2), color)}`);
  lines.push(`  ${muted(fitText(hint, width - 2), color)}`);
  return lines;
}

/** A styled line, or its plain text cut to `width` when the styled one does not fit. */
function fitLine(styled: string, plain: string, width: number): string {
  return visibleWidth(plain) <= width ? styled : fitText(plain, width);
}

/** The call that waits, or what the lab does without one. */
function needsLine(screen: LabScreen, width: number, color: boolean): string {
  const call = screen.call;
  if (!call) {
    const status = screen.paused
      ? screen.paused === 'deadline'
        ? 'The time budget ended, so the lab is paused.'
        : 'Paused. Agents start no new turns until you resume.'
      : 'Nothing needs you.';
    const keys = '   enter: open the lab';
    return `  ${paint(fitText(status, width - 2 - keys.length), screen.paused ? 'muted' : 'mint', color)}${muted(keys, color)}`;
  }
  const price = call.usd === null ? '' : ` ${usd(call.usd)}`;
  const others = screen.calls - 1;
  const after =
    others > 0 ? ` · ${others} more ${others === 1 ? 'call' : 'calls'}` : '';
  const keys = '   enter: open it';
  const room = width - 2 - 'Needs you'.length - 2 - price.length - after.length;
  return `  ${bold(tint('Needs you', color, 'amber'), color)}  ${fitText(call.question, Math.max(10, room - keys.length))}${price}${after ? muted(after, color) : ''}${muted(keys, color)}`;
}

/**
 * The line that Enter on an empty message line sends: open the oldest call
 * that waits in the app, or the lab, or the desk when the package has no
 * app.
 */
export function enterLine(screen: LabScreen): string {
  if (!screen.app) return '/open';
  return screen.call ? `/app ${screen.call.id}` : '/app';
}

/** A direction's state for plain lines: its verdict, and whether it waits for the person. */
function stateOf(direction: ScreenDirection): string {
  return `${direction.shown}${direction.live?.state === 'waiting' ? '!' : ''}`;
}

/**
 * Plain lines for a terminal without the view: one line for each direction
 * whose verdict, or wait for the person, changed since `before`, and one for
 * a new call. The live steps of the agents do not print.
 */
export function plainLines(
  before: LabScreen | null,
  after: LabScreen,
  now: number,
): string[] {
  const known = new Map(
    (before?.directions ?? []).map((entry) => [entry.id, stateOf(entry)]),
  );
  const lines: string[] = [];
  for (const direction of after.directions) {
    if (known.get(direction.id) === stateOf(direction)) continue;
    const line = directionLine(direction.evidence, direction.live, now);
    lines.push(
      `${fitText(direction.title, 200)}${direction.agent ? ` (${direction.agent})` : ''}: ${[
        verdictLabels[direction.shown],
        line.working ? '' : line.text,
      ]
        .filter(Boolean)
        .join(' · ')}`,
    );
  }
  const call = after.call;
  if (call && call.id !== before?.call?.id)
    lines.push(
      `Needs you: ${fitText(call.question, 300)}${call.usd === null ? '' : ` ${usd(call.usd)}`}. Press Enter on an empty line to open it.`,
    );
  return lines;
}
