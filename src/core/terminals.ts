import { randomBytes } from 'node:crypto';
import { childEnvironment } from './harness.ts';
import { SessionActionError } from './session.ts';

/**
 * Native terminals: a harness TUI in a PTY. Each terminal has one input owner,
 * a view that holds an input lease, so two views and Verifold cannot type into
 * one terminal at the same time. Output goes into a bounded history that a view
 * reads from an offset, so a reload replays recent output without a new process.
 */

/** Recent output that a new or reloaded view can replay. */
const historyLimit = 256 * 1024;
/** One input write from a view. */
const inputLimit = 64 * 1024;

function fail(message: string): never {
  throw new SessionActionError(message);
}

/** The PTY library is optional. Without it, or on Windows, terminals are not available. */
interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): void;
}

interface PtyLibrary {
  readonly spawn: (
    file: string,
    args: readonly string[],
    options: {
      readonly name: string;
      readonly cols: number;
      readonly rows: number;
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
    },
  ) => PtyProcess;
}

let library: Promise<PtyLibrary | string> | undefined;

/** The PTY library, or why terminals are not available here. Loaded once, on first use. */
export function ptyLibrary(): Promise<PtyLibrary | string> {
  library ??= (async () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux')
      return 'Terminal panes work on macOS and Linux only.';
    try {
      const loaded = (await import('@lydell/node-pty')) as unknown as {
        spawn?: PtyLibrary['spawn'];
        default?: PtyLibrary;
      };
      const spawn = loaded.spawn ?? loaded.default?.spawn;
      return spawn
        ? { spawn }
        : 'The terminal library has no spawn function. Reinstall Verifold.';
    } catch {
      return 'The terminal library is missing. Reinstall Verifold with its optional dependencies.';
    }
  })();
  return library;
}

export interface TerminalOutput {
  /** The offset after the returned data. Ask again with it. */
  readonly next: number;
  readonly data: string;
  /** Older output left the history, so this view missed some. */
  readonly cut: boolean;
  readonly exited: { readonly code: number } | null;
  /** The lease that holds input, or null. A view compares it with its own. */
  readonly owner: string | null;
}

/** A lease is a random ID that one browser view creates. */
export function validLease(lease: unknown): lease is string {
  return typeof lease === 'string' && /^[a-f0-9]{16,64}$/.test(lease);
}

export class Terminal {
  readonly id = randomBytes(8).toString('hex');
  private readonly pty: PtyProcess;
  private history = '';
  /** The offset of the first character in the history. */
  private start = 0;
  private owner: string | null;
  private exit: { readonly code: number } | null = null;
  private readonly waiters = new Set<() => void>();
  private readonly onExit: (code: number) => void;

  constructor(pty: PtyProcess, owner: string, onExit: (code: number) => void) {
    this.pty = pty;
    this.owner = owner;
    this.onExit = onExit;
    pty.onData((data) => {
      this.history += data;
      if (this.history.length > historyLimit) {
        const drop = this.history.length - historyLimit;
        this.history = this.history.slice(drop);
        this.start += drop;
      }
      this.wake();
    });
    pty.onExit(({ exitCode }) => {
      this.exit = { code: exitCode };
      this.owner = null;
      this.wake();
      this.onExit(exitCode);
    });
  }

  get pid(): number {
    return this.pty.pid;
  }

  get exited(): boolean {
    return this.exit !== null;
  }

  get inputOwner(): string | null {
    return this.owner;
  }

  /** Output after `after`. Waits up to `wait` ms when nothing is new. */
  async read(after: number, wait: number): Promise<TerminalOutput> {
    const end = this.start + this.history.length;
    if (after >= end && !this.exit && wait > 0)
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, wait);
        this.waiters.add(done);
      });
    const from = Math.max(after, this.start);
    const total = this.start + this.history.length;
    return {
      next: total,
      data: this.history.slice(from - this.start),
      cut: after < this.start,
      exited: this.exit,
      owner: this.owner,
    };
  }

  /** Type into the terminal. Only the input owner can. */
  write(lease: unknown, data: unknown): void {
    if (this.exit) fail('The terminal has ended.');
    if (lease !== this.owner)
      fail(
        'Another view holds input for this terminal. Take input here first.',
      );
    if (typeof data !== 'string' || data.length > inputLimit)
      fail('Send at most 64 KB of input at a time.');
    this.pty.write(data);
  }

  resize(lease: unknown, cols: unknown, rows: unknown): void {
    if (this.exit || lease !== this.owner) return;
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      (cols as number) < 20 ||
      (cols as number) > 500 ||
      (rows as number) < 5 ||
      (rows as number) > 200
    )
      fail('Use a terminal size from 20x5 to 500x200.');
    this.pty.resize(cols as number, rows as number);
  }

  /** Move input to this view. The view that held it becomes read-only and sees the change. */
  take(lease: unknown): void {
    if (this.exit) fail('The terminal has ended.');
    if (!validLease(lease)) fail('The view sent an invalid input lease.');
    this.owner = lease;
    this.wake();
  }

  /** End the process. The exit callback runs when it has exited. */
  close(): void {
    if (!this.exit) this.pty.kill('SIGTERM');
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}

/** Start a terminal. `owner` is the view that opened it. */
export async function openTerminal(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly owner: string;
  readonly onExit: (code: number) => void;
  /** Variables that the harness needs in addition to its usual environment. */
  readonly env?: Readonly<Record<string, string>>;
}): Promise<Terminal> {
  if (!validLease(input.owner)) fail('The view sent an invalid input lease.');
  const pty = await ptyLibrary();
  if (typeof pty === 'string') fail(pty);
  const process = pty.spawn(input.command, input.args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: input.cwd,
    env: { ...childEnvironment(), ...input.env, TERM: 'xterm-256color' },
  });
  return new Terminal(process, input.owner, input.onExit);
}
