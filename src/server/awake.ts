import { spawn, type ChildProcess } from 'node:child_process';

export interface KeepAwakeOptions {
  /** Tests use another platform or a fake program. */
  readonly platform?: NodeJS.Platform;
  readonly program?: string;
}

/**
 * Keeps a Mac awake while agents work. `caffeinate -i` holds off idle sleep,
 * and `-w` ends it when Verifold exits, also after a crash. On other systems,
 * or without `caffeinate`, nothing changes.
 */
export class KeepAwake {
  private readonly options: KeepAwakeOptions;
  private child: ChildProcess | null = null;

  constructor(options: KeepAwakeOptions = {}) {
    this.options = options;
  }

  /** Whether Verifold holds the computer awake now. */
  get held(): boolean {
    return this.child !== null;
  }

  /** Hold the computer awake while `working` is true. Release it when it is false. */
  set(working: boolean): void {
    if ((this.options.platform ?? process.platform) !== 'darwin') return;
    if (working && !this.child) {
      const child = spawn(
        this.options.program ?? 'caffeinate',
        ['-i', '-w', String(process.pid)],
        { stdio: 'ignore', shell: false },
      );
      // A Mac without caffeinate sleeps as before.
      const gone = (): void => {
        if (this.child === child) this.child = null;
      };
      child.on('error', gone);
      child.on('exit', gone);
      child.unref();
      this.child = child;
    } else if (!working && this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}
