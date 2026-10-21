import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { KeepAwake } from '../src/server/awake.ts';

/** A fake caffeinate that writes its arguments, then waits until it is stopped. */
async function fake(): Promise<{ program: string; log: string; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'verifold-awake-'));
  const program = join(dir, 'caffeinate');
  const log = join(dir, 'log');
  await writeFile(
    program,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n'); process.on('SIGTERM', () => { require('node:fs').appendFileSync(${JSON.stringify(log)}, 'stopped\\n'); process.exit(0); }); setInterval(() => {}, 1000);`,
  );
  await chmod(program, 0o700);
  return { program, log, dir };
}

async function lines(log: string, count: number): Promise<string[]> {
  for (let tries = 0; tries < 200; tries++) {
    const text = await readFile(log, 'utf8').catch(() => '');
    const found = text.split('\n').filter(Boolean);
    if (found.length >= count) return found;
    await delay(10);
  }
  return [];
}

await test('a Mac stays awake while agents work, once, and sleeps again after', async (t) => {
  const { program, log, dir } = await fake();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const awake = new KeepAwake({ platform: 'darwin', program });
  awake.set(true);
  awake.set(true);
  assert.equal(awake.held, true);
  assert.deepEqual(await lines(log, 1), [`-i -w ${process.pid}`]);
  awake.set(false);
  assert.equal(awake.held, false);
  assert.deepEqual(await lines(log, 2), [`-i -w ${process.pid}`, 'stopped']);
});

await test('other systems and a missing caffeinate change nothing', async () => {
  const linux = new KeepAwake({ platform: 'linux', program: '/absent' });
  linux.set(true);
  assert.equal(linux.held, false);
  const missing = new KeepAwake({
    platform: 'darwin',
    program: join(tmpdir(), 'verifold-no-caffeinate'),
  });
  missing.set(true);
  for (let tries = 0; tries < 100 && missing.held; tries++) await delay(10);
  assert.equal(missing.held, false);
});
