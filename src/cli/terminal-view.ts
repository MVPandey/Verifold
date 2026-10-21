import { createInterface, type Interface } from 'node:readline';
import type { LabScreen } from '../server/screen.ts';
import { enterLine, plainLines, prompt, viewLines } from './lab-view.ts';
import { muted, terminalMessage, tint } from './terminal.ts';
import { fitText, visibleWidth } from './terminal-layout.ts';

/** The terminal's streams. Tests pass their own. */
export interface ViewStreams {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream & {
    readonly columns?: number;
    readonly rows?: number;
  };
}

/**
 * Start a watch of the lab's screens, which gives each one to `show`.
 * Returns the function that stops the watch.
 */
export type FollowScreens = (
  show: (screen: LabScreen | null) => void,
) => () => void;

/** The view needs this many columns and rows. A smaller terminal gets plain lines. */
export const viewColumns = 60;
const viewRows = 12;

/** At most five redraws a second. */
const drawMs = 200;

/** Move the cursor to `column` of its row. A move of 0 would move one. */
export function toColumn(column: number): string {
  return column > 0 ? `\r\u001b[${column}C` : '\r';
}

/**
 * The person's terminal on a project: a live view of its lab that redraws
 * in place, or plain lines one by one. It owns the terminal's input. Plain
 * mode reads whole lines, as the shell gives them. While the view shows, a
 * message line under it keeps line editing, and Enter on an empty line opens
 * the call that waits.
 */
export class LabTerminal {
  private readonly input: ViewStreams['input'];
  private readonly output: ViewStreams['output'];
  private readonly color: boolean;
  private readonly draws: boolean;
  private readonly cancel: () => void;
  private readonly print: (text: string) => void;
  private readonly now: () => number;
  private handler: ((line: string) => void) | null = null;
  /** The newest screen. Undefined before the first one. */
  private screen: LabScreen | null | undefined;
  /** Ctrl+C only detaches this terminal from a background owner. */
  private detaches = true;
  /** Stops the watch of the lab, when this terminal's own desk serves it. */
  private unfollow: (() => void) | undefined;
  /** Line by line, while the view does not show. */
  private reader: Interface | null = null;
  /** The message line, while the view shows. */
  private line: Interface | null = null;
  /** The lines of the last frame, above the message line. */
  private frame: readonly string[] = [];
  /** Rows of a sent message above the cursor. Readline moved down past them. */
  private sent = 0;
  private notice: string | null = null;
  private empty = false;
  /** A message that wraps waits, and so does the view. */
  private held = false;
  private timer: NodeJS.Timeout | undefined;
  private clock: NodeJS.Timeout | undefined;
  private last = 0;
  private closing = false;
  private closed = false;

  /**
   * `draws`: the terminal can show the view, with color and cursor
   * movement. `cancel`: what Ctrl+C does. `print`: a message the
   * line-by-line way.
   */
  constructor(options: {
    readonly streams: ViewStreams;
    readonly color: boolean;
    readonly draws: boolean;
    readonly cancel: () => void;
    readonly print: (text: string) => void;
    readonly now?: () => number;
  }) {
    this.input = options.streams.input;
    this.output = options.streams.output;
    this.color = options.color;
    this.draws = options.draws;
    this.cancel = options.cancel;
    this.print = options.print;
    this.now = options.now ?? Date.now;
  }

  /** The view shows now. */
  get viewing(): boolean {
    return this.line !== null;
  }

  /** Read the person's lines until `signal` aborts. Then the terminal is clean, and its watch of the lab stops. */
  listen(onLine: (line: string) => void, signal: AbortSignal): void {
    if (signal.aborted) return;
    this.closed = false;
    this.handler = onLine;
    this.output.removeListener('resize', this.resized);
    this.output.on('resize', this.resized);
    signal.addEventListener('abort', () => this.close(), { once: true });
    this.update();
  }

  /**
   * The desk of this process serves the project: watch its lab until this
   * terminal closes. Ctrl+C here stops Verifold.
   */
  serve(follow: FollowScreens): void {
    this.unfollow?.();
    this.unfollow = follow((screen) => this.show(screen, false));
  }

  /**
   * A new screen of the lab. Null: the project has no lab. `detaches`:
   * Ctrl+C only detaches this terminal, and the lab works on.
   */
  show(screen: LabScreen | null, detaches: boolean): void {
    const before = this.screen ?? null;
    this.screen = screen;
    this.detaches = detaches;
    if (!this.line && screen && !this.fits())
      for (const line of plainLines(before, screen, this.now()))
        this.print(line);
    this.update();
  }

  /**
   * A message for the person. While the view shows, a short message from
   * Verifold becomes the line under it, until a newer one comes. A longer
   * one, a reply such as the help, and a line of the person's own session
   * (`keep`) print above the view, where they stay in the scrollback.
   */
  progress(text: string, keep = false): void {
    if (!this.line) {
      this.print(text);
      return;
    }
    const row = (this.output.columns ?? 80) - 3;
    if (keep || text.includes('\n') || visibleWidth(text) > row)
      this.draw(text);
    else {
      this.notice = text;
      this.later();
    }
  }

  /** The view fits this terminal and has a lab to show. */
  private fits(): boolean {
    return (
      this.draws &&
      Boolean(this.screen) &&
      (this.output.columns ?? 80) >= viewColumns &&
      (this.output.rows ?? 24) >= viewRows
    );
  }

  /** Start or stop the view as the screen and the size allow, and keep a reader. */
  private update(): void {
    if (this.closed || !this.handler) return;
    if (this.fits()) {
      if (this.line) this.later();
      else this.open();
      return;
    }
    if (this.line) {
      this.stop();
      // The lab as it is now, then a line for each change.
      if (this.screen) {
        this.print(
          'The terminal is too small for the live view. Verifold prints a line for each change until it is larger.',
        );
        for (const line of plainLines(null, this.screen, this.now()))
          this.print(line);
      }
    }
    if (!this.reader) {
      this.reader = createInterface({ input: this.input, terminal: false });
      this.reader.on('line', (text) => this.take(text));
    }
  }

  /** Start the view: a message line with editing, under the frame. */
  private open(): void {
    this.reader?.close();
    this.reader = null;
    const line = createInterface({
      input: this.input,
      output: this.output,
      terminal: true,
      prompt: this.promptText(),
      historySize: 50,
    });
    this.line = line;
    line.on('line', (text) => {
      // Readline moved the cursor to the row under the message that it sent.
      this.sent = Math.max(
        1,
        Math.ceil(
          visibleWidth(prompt.text + text) / (this.output.columns ?? 80),
        ),
      );
      this.take(text);
      this.draw();
    });
    line.on('SIGINT', this.cancel);
    line.on('close', () => {
      // Ctrl+D on an empty line closes the message line: the terminal leaves, as with Ctrl+C.
      if (!this.closing) this.cancel();
    });
    this.input.on('keypress', this.typed);
    this.clock = setInterval(() => this.later(), 30_000).unref();
    this.frame = [];
    this.sent = 0;
    this.draw();
  }

  /** Stop the view. The last frame stays, and the cursor goes to a clean line under it. */
  private stop(): void {
    const line = this.line;
    if (!line) return;
    clearTimeout(this.timer);
    clearInterval(this.clock);
    this.timer = undefined;
    this.input.removeListener('keypress', this.typed);
    // The message line goes. The frame above it stays as the last view.
    const rows = this.sent || line.getCursorPos().rows;
    this.output.write(`\r${rows ? `\u001b[${rows}A` : ''}\u001b[0J`);
    this.closing = true;
    line.close();
    this.closing = false;
    this.line = null;
    this.frame = [];
    this.sent = 0;
  }

  /** Stop reading, and stop the watch of the lab. The terminal is clean afterwards. */
  private close(): void {
    this.stop();
    this.reader?.close();
    this.reader = null;
    this.handler = null;
    this.closed = true;
    this.output.removeListener('resize', this.resized);
    this.unfollow?.();
    this.unfollow = undefined;
  }

  /** A line from the person. An empty line opens the call that waits, or the lab. */
  private take(text: string): void {
    const handler = this.handler;
    if (!handler) return;
    handler(!text.trim() && this.screen ? enterLine(this.screen) : text);
  }

  private promptText(): string {
    return `${prompt.text.slice(0, -2)}${tint('›', this.color, 'lavender')} `;
  }

  /** Draw again soon: at most five times a second. */
  private later(): void {
    if (!this.line || this.timer) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.draw();
      },
      Math.max(0, drawMs - (this.now() - this.last)),
    );
    this.timer.unref();
  }

  /**
   * Draw the frame and the message line in place of the last ones. `above`:
   * a message to print above the frame, where it stays.
   */
  private draw(above?: string): void {
    const line = this.line;
    const screen = this.screen;
    if (!line || !screen) return;
    const columns = this.output.columns ?? 80;
    // A message that wraps stays as readline drew it, until it fits on one row or goes.
    this.held =
      !above &&
      !this.sent &&
      visibleWidth(prompt.text + line.line) >= columns - 1;
    if (this.held) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.last = this.now();
    const frame = viewLines(screen, {
      columns,
      rows: this.output.rows ?? 24,
      color: this.color,
      now: this.last,
      detaches: this.detaches,
      notice: this.notice,
    });
    // The old frame wraps again when the terminal got narrower.
    const up =
      this.frame.reduce(
        (sum, text) =>
          sum + Math.max(1, Math.ceil(visibleWidth(text) / columns)),
        0,
      ) + (this.sent || line.getCursorPos().rows);
    this.empty = line.line === '';
    const message = this.empty
      ? muted(
          fitText(prompt.empty, columns - 2 - visibleWidth(prompt.text)),
          this.color,
        )
      : line.line;
    const cursor = this.empty
      ? visibleWidth(prompt.text)
      : line.getCursorPos().cols;
    this.output.write(
      [
        // Terminals that know it show the whole change at once.
        '\u001b[?2026h\r',
        up ? `\u001b[${up}A` : '',
        '\u001b[0J',
        above ? `${terminalMessage(above, this.color, columns)}\n` : '',
        `${frame.join('\n')}\n`,
        this.promptText(),
        message,
        toColumn(cursor),
        '\u001b[?2026l',
      ].join(''),
    );
    this.frame = frame;
    this.sent = 0;
  }

  /** After each key that readline took: the empty line's words go or come back, and a held view draws. */
  private readonly typed = (): void => {
    const line = this.line;
    if (!line) return;
    const columns = this.output.columns ?? 80;
    if (this.empty && line.line !== '') {
      this.empty = false;
      this.output.write('\u001b[0K');
    } else if (!this.empty && line.line === '') {
      this.empty = true;
      this.output.write(
        `${muted(fitText(prompt.empty, columns - 2 - visibleWidth(prompt.text)), this.color)}${toColumn(visibleWidth(prompt.text))}`,
      );
    }
    if (this.held && visibleWidth(prompt.text + line.line) < columns - 1)
      this.later();
  };

  private readonly resized = (): void => {
    // Readline draws its line again on a resize too. The view draws after it.
    if (this.line && this.fits()) this.later();
    else this.update();
  };
}
