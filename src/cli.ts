#!/usr/bin/env node
import { stdin, stdout, stderr } from 'node:process';
import { runCli } from './cli/commands.ts';
import { paragraph } from './cli/terminal.ts';
import { TerminalSession } from './cli/terminal-session.ts';
import { LabTerminal } from './cli/terminal-view.ts';
import { stripVTControlCharacters } from 'node:util';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// A diagnostic report leaves out the environment, which can hold keys.
process.report.excludeEnv = true;
const controller = new AbortController();
const cancel = (): void => {
  controller.abort();
};
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
// The background owner has no terminal. A hangup does not stop the team.
if (process.argv[2] === 'owner') process.on('SIGHUP', () => {});
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

/**
 * Start `verifold owner` for a project in its own session, so the signals of
 * this terminal do not reach it. Its only input is `input`, which holds the
 * control key, so the key is in no command line or environment. Errors of the
 * process go to .verifold/owner.log.
 */
async function startOwner(root: string, input: string): Promise<void> {
  const log = await open(join(root, '.verifold', 'owner.log'), 'a', 0o600);
  try {
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        'owner',
        '--workspace',
        root,
      ],
      { cwd: root, detached: true, stdio: ['pipe', 'ignore', log.fd] },
    );
    await once(child, 'spawn');
    child.stdin?.end(`${input}\n`);
    child.unref();
  } finally {
    await log.close();
  }
}

/** All of stdin, up to `limit` characters. */
function readInput(limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > limit) {
        stdin.destroy();
        reject(new Error(`The input exceeds ${limit / 1024} KB.`));
      }
    });
    stdin.once('end', () => resolve(text));
    stdin.once('error', reject);
  });
}

/** Read a secret: hidden input on a terminal, or all of stdin (up to 4 KB). It is never echoed. */
function readSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY) return readInput(4096);
  return new Promise((resolve, reject) => {
    let text = '';
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
// The live view of a lab needs color and cursor movement, so NO_COLOR and TERM=dumb get plain lines.
const lab = terminal
  ? new LabTerminal({
      streams: { input: stdin, output: stderr },
      color,
      draws: color,
      cancel,
      print: (value) => terminal.progress(value),
    })
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
      background: {
        keys: join(homedir(), '.verifold', 'credentials', 'owners'),
        start: startOwner,
        input: () => readInput(65_536),
      },
      // Harness tool events belong in the desk, so the terminal skips them.
      progress: (value, source) => {
        if (source !== 'tool') lab?.progress(value);
      },
      ...(lab
        ? {
            // Menus are finished before this starts. Plain mode reads lines as the shell gives them.
            listen: (onLine: (line: string) => void, signal: AbortSignal) =>
              lab.listen(onLine, signal),
            screens: { show: lab.show.bind(lab) },
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
