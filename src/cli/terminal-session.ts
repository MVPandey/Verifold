import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents, type Key } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { stdin, stderr } from 'node:process';
import type { Choice } from './choices.ts';
import {
  muted,
  paragraph,
  terminalBanner,
  terminalMenu,
  terminalMessage,
  tint,
} from './terminal.ts';
import { visibleWidth } from './terminal-layout.ts';

/** Redraw only the active component. Completed work remains in scrollback. */
class LiveRegion {
  private lines: readonly string[] = [];

  clear(): void {
    const width = Math.max(1, stderr.columns || 80);
    const rows = this.lines.reduce(
      (sum, line) => sum + Math.max(1, Math.ceil(visibleWidth(line) / width)),
      0,
    );
    if (rows)
      stderr.write(
        `\r\u001b[${Math.min(rows, Math.max(1, (stderr.rows || 24) - 1))}A\u001b[0J`,
      );
    this.lines = [];
  }

  draw(value: string): void {
    this.clear();
    this.lines = value.replace(/\n$/, '').split('\n');
    stderr.write(`${this.lines.join('\n')}\n`);
  }
}

/** Terminal input, repainting, and animation have one lifecycle owner. */
export class TerminalSession {
  private readonly signal: AbortSignal;
  private readonly cancel: () => void;
  private readonly color: boolean;
  private readonly motion: boolean;
  private activity: LiveRegion | undefined;
  constructor(controller: AbortController, color: boolean, motion: boolean) {
    this.signal = controller.signal;
    this.cancel = () => controller.abort();
    this.color = color;
    this.motion = motion;
  }

  async welcome(): Promise<void> {
    const region = new LiveRegion();
    const fits = (): boolean =>
      terminalBanner(true, !this.color, stderr.columns).split('\n').length <=
      (stderr.rows || 24) - 1;
    if (this.motion && fits()) {
      for (const frame of [0, 1, 2]) {
        if (!fits()) break;
        region.draw(terminalBanner(true, !this.color, stderr.columns, frame));
        await delay(65, undefined, { signal: this.signal });
      }
    } else stderr.write(terminalBanner(true, !this.color, stderr.columns));
  }

  progress(value: string): void {
    this.activity?.clear();
    stderr.write(`${terminalMessage(value, this.color, stderr.columns)}\n\n`);
  }

  async ask(question: string): Promise<string> {
    this.signal.throwIfAborted();
    stderr.write(`${paragraph(question.trim(), stderr.columns)}\n`);
    const input = createInterface({ input: stdin, output: stderr });
    input.on('SIGINT', this.cancel);
    input.on('close', this.cancel);
    try {
      return await input.question(tint('  › ', this.color, 'sky'), {
        signal: this.signal,
      });
    } finally {
      input.removeListener('SIGINT', this.cancel);
      input.removeListener('close', this.cancel);
      input.close();
      stderr.write('\n');
    }
  }

  async select(
    question: string,
    choices: readonly Choice[],
    initial: string,
  ): Promise<string> {
    this.signal.throwIfAborted();
    if (!choices.length)
      throw new Error('A menu requires at least one choice.');
    let index = Math.max(
      0,
      choices.findIndex((choice) => choice.value === initial),
    );
    let accepted = false;
    const region = new LiveRegion();
    const render = (): void =>
      region.draw(
        terminalMenu(
          question,
          choices,
          index,
          this.color,
          stderr.columns,
          stderr.rows,
        ),
      );
    const wasRaw = stdin.isRaw;
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stderr.write('\u001b[?25l');
    try {
      return await new Promise<string>((resolve, reject) => {
        const cleanup = (): void => {
          stdin.removeListener('keypress', keypress);
          stdin.removeListener('end', abort);
          stderr.removeListener('resize', render);
          this.signal.removeEventListener('abort', abort);
        };
        const abort = (): void => {
          cleanup();
          reject(new DOMException('Cancelled.', 'AbortError'));
        };
        const keypress = (_text: string, key: Key): void => {
          if (
            key.name === 'escape' ||
            (key.ctrl && (key.name === 'c' || key.name === 'd'))
          ) {
            this.cancel();
          } else if (key.name === 'return') {
            accepted = true;
            cleanup();
            resolve(choices[index]?.value ?? initial);
          } else {
            if (key.name === 'up')
              index = (index + choices.length - 1) % choices.length;
            if (key.name === 'down') index = (index + 1) % choices.length;
            const number = Number(key.sequence);
            if (
              Number.isInteger(number) &&
              number >= 1 &&
              number <= choices.length
            )
              index = number - 1;
            render();
          }
        };
        stdin.on('keypress', keypress);
        stdin.once('end', abort);
        stderr.on('resize', render);
        this.signal.addEventListener('abort', abort, { once: true });
        render();
      });
    } finally {
      region.clear();
      stderr.write('\u001b[?25h');
      stdin.setRawMode(wasRaw);
      stdin.pause();
      if (accepted) this.progress(`✓ ${choices[index]?.label ?? ''}`);
    }
  }

  async busy<T>(label: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const frames = ['▱▱▱', '▰▱▱', '▰▰▱', '▰▰▰', '▱▰▰', '▱▱▰'];
    const region = new LiveRegion();
    this.activity = region;
    let frame = 0;
    const content = (): string =>
      [
        tint(
          paragraph(
            `${frames[frame++ % frames.length]} ${label}`,
            stderr.columns,
          ),
          this.color,
        ),
        muted(
          paragraph(
            `${Math.floor((Date.now() - started) / 1000)}s elapsed · ctrl+c to cancel`,
            stderr.columns,
          ),
          this.color,
        ),
      ].join('\n');
    const render = (): void => {
      const value = content();
      if (value.split('\n').length <= (stderr.rows || 24) - 1)
        region.draw(value);
    };
    const animate =
      this.motion && content().split('\n').length <= (stderr.rows || 24) - 1;
    if (animate) render();
    else this.progress(label);
    const timer = animate ? setInterval(render, 160) : undefined;
    try {
      const result = await work();
      region.clear();
      this.progress(`✓ ${label} · response received`);
      return result;
    } finally {
      clearInterval(timer);
      region.clear();
      this.activity = undefined;
    }
  }
}
