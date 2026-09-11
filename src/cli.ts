#!/usr/bin/env node
import { stdin, stdout, stderr } from 'node:process';
import { runCli } from './cli/commands.ts';
import { paragraph } from './cli/terminal.ts';
import { TerminalSession } from './cli/terminal-session.ts';
import { stripVTControlCharacters } from 'node:util';
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
    ['init', 'research'].includes(process.argv[2] ?? '') &&
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
      progress: (value) => {
        terminal?.progress(value);
      },
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
