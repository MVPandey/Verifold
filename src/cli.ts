#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { runCli } from './cli/commands.ts';
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
const terminal =
  stdin.isTTY && stderr.isTTY
    ? createInterface({ input: stdin, output: stderr })
    : null;
try {
  await runCli(process.argv.slice(2), process.cwd(), {
    interactive: terminal !== null,
    ask: async (question) => {
      if (!terminal) throw new Error('Interactive terminal required.');
      return terminal.question(question, { signal: controller.signal });
    },
    out: (value) => {
      stdout.write(`${value}\n`);
    },
  });
} catch (error) {
  stderr.write(
    `Verifold: ${controller.signal.aborted ? 'Cancelled.' : error instanceof Error ? error.message : 'Command failed.'}\n`,
  );
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  terminal?.close();
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
