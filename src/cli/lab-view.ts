import {
  firstRanked,
  type LabScreen,
  type ScreenDirection,
} from '../server/screen.ts';
import { usd } from '../ui/call-words.ts';
import {
  directionLine,
  moneyLine,
  noDirectionsLine,
  plannerEndLine,
  verdictLabels,
  type PlannerState,
  type ShownVerdict,
} from '../ui/lab-lines.ts';
import { muted, strong, tint, type Tone } from './terminal.ts';
import { fitText, visibleWidth } from './terminal-layout.ts';

/** How the view draws. */
export interface ViewOptions {
  readonly columns: number;
  readonly rows: number;
  readonly color: boolean;
  readonly now: number;
  /** Ctrl+C only detaches this terminal, and the lab works on in a background owner. */
  readonly detaches: boolean;
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

/** The keys line. Ctrl+C stops Verifold, unless the terminal only detaches from a background owner. */
function keysLine(detaches: boolean): string {
  return `/help: commands · ctrl+c: ${detaches ? 'close this window (the lab keeps working)' : 'stop Verifold'}`;
}

/** `text` with spaces after it, to `width` cells. */
function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
}

/** A row's mark, and the colors of the mark and of the row's line. */
interface Mark {
  readonly mark: string;
  readonly tone: Tone | 'muted' | null;
  readonly line: Tone | 'muted' | null;
}

const waitingMark: Mark = { mark: '!', tone: 'amber', line: 'amber' };
const workingMark: Mark = { mark: '●', tone: 'lavender', line: null };
const marks: Readonly<Record<ShownVerdict, Mark>> = {
  holds: { mark: '✓', tone: 'mint', line: 'mint' },
  disputed: { mark: '!', tone: 'amber', line: 'amber' },
  'ruled-out': { mark: '✗', tone: 'muted', line: 'muted' },
  leading: { mark: '↑', tone: 'lavender', line: null },
  open: { mark: '○', tone: 'muted', line: null },
  stopped: { mark: '–', tone: 'muted', line: 'muted' },
};

function markOf(direction: ScreenDirection): Mark {
  if (direction.live?.state === 'waiting') return waitingMark;
  if (direction.live?.state === 'working') return workingMark;
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
 * artboard: the project, the money line, a planner that ended before the
 * plan, one row per direction, the call that waits, Verifold's newest
 * message, and the keys. The message line
 * comes after these. Each line fits in `columns - 1` cells, and the view
 * leaves a free row on a screen of `rows`, so it never scrolls itself away.
 */
export function viewLines(screen: LabScreen, options: ViewOptions): string[] {
  const { color, now } = options;
  // The view needs at least 60 columns: a narrower terminal gets plain lines.
  const width = options.columns - 1;
  const notice = options.notice ? 1 : 0;
  const origin = `· ${screen.origin}`;
  const name = fitText(
    screen.project,
    Math.max(8, width - 2 - 'verifold'.length - 4 - visibleWidth(origin)),
  );
  const lines = [
    '',
    fitLine(
      `  ${strong(tint('verifold', color, 'lavender'), color)}  ${strong(name, color)}  ${muted(origin, color)}`,
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
  // A planner that ended before the plan gets its line above the directions.
  const ended =
    screen.planner && screen.planner !== 'missing' ? screen.planner : null;
  if (ended)
    lines.push(
      `  ${paint(fitText(plannerLine(ended), width - 2), 'amber', color)}`,
    );
  // The rows that fit. "and N more" takes one of them when some do not.
  const room = Math.max(
    1,
    options.rows - 1 - fixedRows - notice - (ended ? 1 : 0),
  );
  let rows = screen.directions;
  let more = screen.more;
  if (rows.length + (more ? 1 : 0) > room) {
    rows = firstRanked(rows, room - 1);
    more += screen.directions.length - rows.length;
  }
  if (!screen.directions.length && !more)
    lines.push(
      screen.planner === 'missing'
        ? `  ${paint(fitText(plannerLine('missing'), width - 2), 'amber', color)}`
        : `  ${muted(fitText(noDirectionsLine(false, true), width - 2), color)}`,
    );
  const agentWidth = Math.min(
    12,
    Math.max(0, ...rows.map((entry) => visibleWidth(entry.agent ?? ''))),
  );
  // Indent, mark, and the gaps around the title and the agent.
  const both = width - 7 - (agentWidth ? agentWidth + 2 : 0);
  const shown = rows.map((direction) => ({
    direction,
    text: rowText(direction, now),
  }));
  // A title gets the room that the lines do not need, and at least half.
  const widest = (texts: readonly string[]): number =>
    Math.max(0, ...texts.map((text) => visibleWidth(fitText(text, 400))));
  const titleWidth = Math.min(
    widest(rows.map((entry) => entry.title)),
    Math.max(
      12,
      Math.floor(both / 2),
      both - widest(shown.map((entry) => entry.text)),
    ),
  );
  for (const { direction, text } of shown) {
    const { mark, tone, line } = markOf(direction);
    const agent = agentWidth
      ? `${paint(pad(fitText(direction.agent ?? '', agentWidth), agentWidth), 'lavender', color)}  `
      : '';
    lines.push(
      `  ${paint(mark, tone, color)}  ${pad(fitText(direction.title, titleWidth), titleWidth)}  ${agent}${paint(
        fitText(text, Math.max(1, both - titleWidth)),
        line,
        color,
      )}`,
    );
  }
  if (more) lines.push(`  ${muted(`and ${more} more`, color)}`);
  lines.push('', needsLine(screen, width, color), '');
  if (options.notice)
    lines.push(`  ${muted(fitText(options.notice, width - 2), color)}`);
  lines.push(
    `  ${muted(fitText(keysLine(options.detaches), width - 2), color)}`,
  );
  return lines;
}

/** The line about a planner that does not make the plan. The person acts on it in the app. */
function plannerLine(state: PlannerState): string {
  return state === 'missing'
    ? noDirectionsLine(true, true)
    : plannerEndLine(state, true);
}

/** A styled line, or its plain text cut to `width` when the styled one does not fit. */
function fitLine(styled: string, plain: string, width: number): string {
  return visibleWidth(plain) <= width ? styled : fitText(plain, width);
}

/** The calls that wait while the snapshot leaves out their questions: a large lab's smallest snapshot only counts them. */
function hidden(screen: LabScreen | null): number {
  return screen && !screen.call ? screen.calls : 0;
}

/** "1 call needs you." or "3 calls need you." */
function callCount(count: number): string {
  return `${count} ${count === 1 ? 'call needs' : 'calls need'} you.`;
}

/**
 * The call that waits, or what the lab does without one. The line fits in
 * `width` cells: when the question would get fewer than 10, the keys go,
 * then the count of the other calls.
 */
function needsLine(screen: LabScreen, width: number, color: boolean): string {
  const call = screen.call;
  if (!call) {
    const [status, tone]: [string, Tone | 'muted'] = hidden(screen)
      ? [callCount(screen.calls), 'amber']
      : screen.paused
        ? [
            screen.paused === 'deadline'
              ? 'The time budget ended, so the lab is paused.'
              : 'Paused. Agents start no new turns until you resume.',
            'muted',
          ]
        : ['Nothing needs you.', 'mint'];
    const keys = '   enter: open the lab';
    const room = width - 2 - keys.length;
    return room >= visibleWidth(status)
      ? `  ${paint(status, tone, color)}${muted(keys, color)}`
      : `  ${paint(fitText(status, width - 2), tone, color)}`;
  }
  const label = 'Needs you';
  const price = call.usd === null ? '' : ` ${usd(call.usd)}`;
  const others = screen.calls - 1;
  let after =
    others > 0 ? ` · ${others} more ${others === 1 ? 'call' : 'calls'}` : '';
  let keys = '   enter: open it';
  const room = (): number =>
    width - 4 - label.length - price.length - after.length - keys.length;
  if (room() < 10) keys = '';
  if (room() < 10) after = '';
  const question = fitText(call.question, Math.max(1, room()));
  const line = `  ${strong(tint(label, color, 'amber'), color)}  ${question}${price}${after ? muted(after, color) : ''}${keys ? muted(keys, color) : ''}`;
  return fitLine(line, `  ${label}  ${question}${price}${after}${keys}`, width);
}

/**
 * The line that Enter on an empty message line sends: open the oldest call
 * that waits in the app, or the lab, or the old desk when the package has no
 * app. /open opens the old desk in a terminal that started with --desk.
 */
export function enterLine(screen: LabScreen): string {
  return screen.app && screen.call ? `/open ${screen.call.id}` : '/open';
}

/** A direction's state for plain lines: its verdict, and whether it waits for the person. */
function stateOf(direction: ScreenDirection): string {
  return `${direction.shown}${direction.live?.state === 'waiting' ? '!' : ''}`;
}

/**
 * Plain lines for a terminal without the view: one line for each direction
 * whose verdict, or wait for the person, differs from its last line, one
 * when the planner did not make the plan, and one for a new call. The live
 * steps of the agents do not print.
 *
 * `printed` holds the state of each direction's last line, by ID, and gets
 * the states of the new lines. It is not the screen before, because a large
 * lab's screen leaves directions out: a direction that comes back unchanged
 * prints nothing. `before` tells a new call.
 */
export function plainLines(
  before: LabScreen | null,
  after: LabScreen,
  now: number,
  printed: Map<string, string>,
): string[] {
  const lines: string[] = [];
  for (const direction of after.directions) {
    const state = stateOf(direction);
    if (printed.get(direction.id) === state) continue;
    printed.set(direction.id, state);
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
  if (after.planner && after.planner !== before?.planner)
    lines.push(plannerLine(after.planner));
  const call = after.call;
  if (call && call.id !== before?.call?.id)
    lines.push(
      `Needs you: ${fitText(call.question, 300)}${call.usd === null ? '' : ` ${usd(call.usd)}`}. Press Enter on an empty line to open it.`,
    );
  else if (hidden(after) && hidden(after) !== hidden(before))
    lines.push(
      `${callCount(hidden(after))} Press Enter on an empty line to open the lab.`,
    );
  return lines;
}
