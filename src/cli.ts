#!/usr/bin/env node
import { stdin, stdout, stderr } from 'node:process';
import { runCli } from './cli/commands.ts';
import { paragraph } from './cli/terminal.ts';
import { TerminalSession } from './cli/terminal-session.ts';
import { stripVTControlCharacters } from 'node:util';
import { createInterface } from 'node:readline';
const controller = new AbortController();
const cancel = (): void => {
  controller.abort();
};
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') {
    controller.abort();
    process.exitCode = 0;
  } else {
    stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
});
const interactive = Boolean(stdin.isTTY && stderr.isTTY);

/** Read a secret: hidden input on a terminal, or all of stdin (up to 4 KB). It is never echoed. */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    if (!stdin.isTTY) {
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk: string) => {
        text += chunk;
        if (text.length > 4096) {
          stdin.destroy();
          reject(new Error('The input exceeds 4 KB.'));
        }
      });
      stdin.once('end', () => resolve(text));
      stdin.once('error', reject);
      return;
    }
    const finish = (error?: Error): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
      if (error) reject(error);
      else resolve(text);
    };
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') return finish();
        if (char === '\u0003') {
          controller.abort();
          return finish(new Error('Cancelled.'));
        }
        if (char === '\u007f' || char === '\b') text = text.slice(0, -1);
        else if (char >= ' ') text += char;
        if (text.length > 4096)
          return finish(new Error('The input exceeds 4 KB.'));
      }
    };
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}
const color =
  interactive &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb';
const terminal = interactive
  ? new TerminalSession(
      controller,
      color,
      color && process.env.VERIFOLD_REDUCED_MOTION !== '1',
    )
  : null;
try {
  if (
    terminal &&
    (process.argv.length === 2 ||
      ['init', 'research'].includes(process.argv[2] ?? '')) &&
    !process.argv.includes('--help')
  )
    await terminal.welcome();
  await runCli(
    process.argv.slice(2),
    process.cwd(),
    {
      interactive: terminal !== null,
      ask: async (question) => {
        if (!terminal) throw new Error('Interactive terminal required.');
        return terminal.ask(question);
      },
      ...(terminal && process.env.TERM !== 'dumb'
        ? {
            select: terminal.select.bind(terminal),
            busy: terminal.busy.bind(terminal),
          }
        : {}),
      readSecret,
      // Harness tool events belong in the desk, so the terminal skips them.
      progress: (value, source) => {
        if (source !== 'tool') terminal?.progress(value);
      },
      ...(terminal
        ? {
            listen: (onLine: (line: string) => void, signal: AbortSignal) => {
              // Line mode keeps shell editing and Ctrl+C. Menus are finished before this starts.
              const input = createInterface({ input: stdin, terminal: false });
              input.on('line', onLine);
              signal.addEventListener('abort', () => input.close(), {
                once: true,
              });
            },
          }
        : {}),
      out: (value) => {
        stdout.write(
          `${terminal && stdout.isTTY && ['init', 'research'].includes(process.argv[2] ?? '') ? paragraph(value, stdout.columns) : value}\n`,
        );
      },
    },
    controller.signal,
  );
} catch (error) {
  stderr.write(
    `Verifold: ${controller.signal.aborted ? 'Cancelled.' : error instanceof Error ? stripVTControlCharacters(error.message) : 'Command failed.'}\n`,
  );
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
