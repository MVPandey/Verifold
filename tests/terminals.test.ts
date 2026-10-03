import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  openTerminal,
  ptyLibrary,
  type Terminal,
} from '../src/cli/terminals.ts';

/** A fake TUI: echoes each line, reports its size on resize, floods on FLOOD, exits on EXIT. */
const fakeTui = `process.stdin.setRawMode?.(true);
process.stdout.write('\\x1b[1mfake tui\\x1b[0m ready\\r\\n');
process.stdout.on('resize', () => process.stdout.write('size ' + process.stdout.columns + 'x' + process.stdout.rows + '\\r\\n'));
let line = '';
process.stdin.on('data', (chunk) => {
  for (const char of chunk.toString()) {
    if (char !== '\\r') { line += char; continue; }
    if (line === 'EXIT') process.exit(3);
    if (line === 'FLOOD') process.stdout.write('y'.repeat(400 * 1024) + '\\r\\nflood done\\r\\n');
    else process.stdout.write('echo ' + line + '\\r\\n');
    line = '';
  }
});`;

const available = typeof (await ptyLibrary()) !== 'string';

async function start(
  t: test.TestContext,
): Promise<{ terminal: Terminal; exits: number[] }> {
  const folder = await mkdtemp(join(tmpdir(), 'vf-terminal-'));
  const script = join(folder, 'tui.cjs');
  await writeFile(script, fakeTui);
  const exits: number[] = [];
  const terminal = await openTerminal({
    command: process.execPath,
    args: [script],
    cwd: folder,
    owner: 'a'.repeat(16),
    onExit: (code) => exits.push(code),
  });
  t.after(async () => {
    terminal.close();
    await rm(folder, { recursive: true, force: true });
  });
  return { terminal, exits };
}

async function until(
  terminal: Terminal,
  pattern: RegExp,
  from = 0,
): Promise<{ text: string; next: number }> {
  let text = '';
  let next = from;
  const deadline = Date.now() + 10_000;
  while (!pattern.test(text) && Date.now() < deadline) {
    const output = await terminal.read(next, 200);
    text += output.data;
    next = output.next;
  }
  assert.ok(
    pattern.test(text),
    `The terminal did not show ${String(pattern)}.`,
  );
  return { text, next };
}

await test(
  'one view holds input, another must take it, and the size follows the owner',
  { skip: !available && 'no PTY library on this platform' },
  async (t) => {
    const { terminal } = await start(t);
    const first = 'a'.repeat(16);
    const second = 'b'.repeat(16);
    let seen = await until(terminal, /fake tui.*ready/);
    // Escape sequences stay in the data. The page renders them in a terminal, never as HTML.
    assert.ok(seen.text.includes('\u001b[1m'));
    terminal.write(first, 'hello\r');
    seen = await until(terminal, /echo hello/, seen.next);
    assert.throws(
      () => terminal.write(second, 'intruder\r'),
      /Another view holds input/,
    );
    assert.throws(() => terminal.take('not a lease'), /invalid input lease/);
    terminal.take(second);
    assert.equal(terminal.inputOwner, second);
    assert.throws(
      () => terminal.write(first, 'late\r'),
      /Another view holds input/,
    );
    assert.equal((await terminal.read(seen.next, 0)).owner, second);
    // Only the owner resizes.
    terminal.resize(first, 120, 40);
    terminal.resize(second, 90, 20);
    seen = await until(terminal, /size 90x20/, seen.next);
    assert.doesNotMatch(seen.text, /size 120x40/);
    assert.throws(() => terminal.resize(second, 5, 5), /20x5 to 500x200/);
  },
);

await test(
  'the history keeps the last 256 KB, a reload replays it, and exit ends input',
  { skip: !available && 'no PTY library on this platform' },
  async (t) => {
    const { terminal, exits } = await start(t);
    const owner = 'a'.repeat(16);
    let seen = await until(terminal, /ready/);
    terminal.write(owner, 'FLOOD\r');
    seen = await until(terminal, /flood done/, seen.next);
    // A view that starts again from 0 gets the cut history, not the whole burst.
    const replay = await terminal.read(0, 0);
    assert.equal(replay.cut, true);
    assert.ok(replay.data.length <= 256 * 1024);
    assert.match(replay.data, /flood done/);
    // Waiting with nothing new returns after the wait, with no data.
    const quiet = await terminal.read(seen.next, 100);
    assert.equal(quiet.data, '');
    terminal.write(owner, 'EXIT\r');
    for (let tries = 0; tries < 50 && !exits.length; tries++) await delay(50);
    assert.deepEqual(exits, [3]);
    const ended = await terminal.read(seen.next, 0);
    assert.deepEqual(ended.exited, { code: 3 });
    assert.equal(ended.owner, null);
    assert.throws(() => terminal.write(owner, 'more\r'), /terminal has ended/);
  },
);
