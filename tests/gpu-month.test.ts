import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  lutimes,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveAgencyFile } from '../src/core/agency.ts';
import { profileMoneyDefaults } from '../src/core/compute.ts';
import {
  GpuMonth,
  monthFolder,
  monthLimits,
  monthRecord,
  profileMonthLimit,
  readMonth,
  type MonthRecord,
} from '../src/core/gpu-month.ts';
import {
  diskRate,
  leaseStart,
  monthKey,
  monthSpend,
  type Lease,
} from '../src/core/leases.ts';

async function folder(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'verifold-month-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A lease with only the fields that the month counts. Rate $0.27 an hour on a 50 GB disk. Open unless `fields` ends it. */
function lease(id: string, start: number, fields: Partial<Lease> = {}): Lease {
  return {
    id,
    state: 'ready',
    rate: 0.27,
    diskGb: 50,
    hours: 4,
    billedUsd: null,
    requestedAt: new Date(start - 60_000).toISOString(),
    decidedAt: new Date(start).toISOString(),
    deadline: new Date(start + 4 * 3_600_000).toISOString(),
    intervals: [
      { start: new Date(start).toISOString(), end: null, rate: 0.27 },
    ],
    ...fields,
  } as unknown as Lease;
}

/** A lease that ran for `hours` from `start`, then ended. */
function ended(id: string, start: number, hours: number): Lease {
  const end = new Date(start + hours * 3_600_000).toISOString();
  return lease(id, start, {
    state: 'ended',
    intervals: [{ start: new Date(start).toISOString(), end, rate: 0.27 }],
  });
}

/** One record of another project, as its owner writes it. */
function record(value: MonthRecord): string {
  return `${JSON.stringify({ schemaVersion: 1, project: '/elsewhere', writtenAt: new Date().toISOString(), ...value })}\n`;
}

/** Write a record as its owner did at `at`, so its time matches the test's clock, not the real one. */
async function write(path: string, text: string, at: number): Promise<void> {
  await writeFile(path, text);
  await utimes(path, new Date(at), new Date(at));
}

const hourly = 0.27 + diskRate(50);
const hour = 3_600_000;

await test('an open pod counts in the month of now, also when it started in the month before, and an ended one in the month it started', () => {
  const october = new Date(2026, 9, 31, 23, 0).getTime();
  const november = new Date(2026, 10, 1, 0, 30).getTime();
  assert.equal(monthKey(october), '2026-10');
  assert.equal(monthKey(november), '2026-11');
  const running = lease('lease-1', october);
  assert.equal(leaseStart(running), new Date(october).toISOString());
  // Without a pod yet, the request's time counts.
  assert.equal(
    leaseStart(lease('lease-2', october, { intervals: [], decidedAt: null })),
    new Date(october - 60_000).toISOString(),
  );
  // Ninety minutes later it is November: the pod that runs counts in November, with its whole spend and its hold.
  const now = monthSpend([running], november);
  assert.ok(Math.abs(now.spentUsd - hourly * 1.5) < 1e-9);
  assert.ok(Math.abs(now.heldUsd - hourly * 2.5) < 1e-9);
  // A pod that ran in October and ended counts in October only.
  const done = ended('lease-3', october - 5 * hour, 2);
  assert.deepEqual(monthSpend([done], november), { spentUsd: 0, heldUsd: 0 });
  assert.ok(Math.abs(monthSpend([done], october).spentUsd - hourly * 2) < 1e-9);
});

await test("a project's record is compact, lists only its open leases, and stays under the read limit with 1,000 leases", async (t) => {
  const dir = await folder(t);
  const agency = join(dir, 'agency');
  const root = join(dir, 'project');
  await mkdir(root);
  const now = new Date(2026, 9, 12, 14, 0).getTime();
  const month = new GpuMonth({
    agency,
    root,
    limit: () => Promise.resolve(100),
  });
  // 1,000 leases: 997 ended this month for an hour each, one from September, one waiting, and one that runs.
  const leases = [
    ...Array.from({ length: 997 }, (_, index) =>
      ended(`lease-${(index + 1).toString()}`, now - 10 * 24 * hour, 1),
    ),
    ended('lease-998', new Date(2026, 8, 20).getTime(), 1),
    lease('lease-999', now, { state: 'requested', intervals: [] }),
    lease('lease-1000', now - 2 * hour),
  ];
  await month.record(leases, now);
  const name = `${createHash('sha256')
    .update(await realpath(root))
    .digest('hex')
    .slice(0, 16)}.json`;
  const path = join(monthFolder(agency), name);
  const text = await readFile(path, 'utf8');
  assert.ok(
    Buffer.byteLength(text) < monthLimits.bytes / 10,
    String(text.length),
  );
  // Compact: one line, no indent.
  assert.equal(text.trim().split('\n').length, 1);
  const saved = JSON.parse(text) as Record<string, unknown>;
  assert.equal(saved.project, await realpath(root));
  assert.equal(saved.month, '2026-10');
  // The ended leases of October fold into one total, rounded up to the cent. September's stays out.
  assert.equal(saved.endedUsd, Math.ceil(hourly * 997 * 100) / 100);
  assert.deepEqual(saved.open, [
    {
      id: 'lease-1000',
      spentUsd: Math.ceil(hourly * 2 * 100) / 100,
      heldUsd: Math.ceil(hourly * 2 * 100) / 100,
      endsAt: new Date(now + 2 * hour).toISOString(),
    },
  ]);
  // The profile folder keeps its marker, and the record is private.
  assert.equal(
    await readFile(join(agency, '.verifold-agency'), 'utf8'),
    'Verifold agency v1\n',
  );
  assert.equal((await stat(monthFolder(agency))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  // Another project reads it whole.
  const read = await readMonth(monthFolder(agency), now);
  assert.equal(read.unknown, null);
  assert.ok(Math.abs(read.spentUsd - saved.endedUsd - hourly * 2) < 0.02);
  // Its own record is not one of the other projects.
  assert.deepEqual(await month.others(now), {
    limitUsd: 100,
    spentUsd: 0,
    heldUsd: 0,
    problem: null,
  });
  // More open leases than a record lists fold into its last entry.
  const many = Array.from({ length: monthLimits.open + 50 }, (_, index) =>
    lease(`lease-${(index + 1).toString()}`, now - hour),
  );
  const big = monthRecord(many, now);
  assert.equal(big?.open.length, monthLimits.open);
  assert.equal(big?.open.at(-1)?.id, 'more');
  assert.ok(
    Math.abs(
      (big?.open.at(-1)?.spentUsd ?? 0) - (51 * Math.ceil(hourly * 100)) / 100,
    ) < 0.02,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(big)) < monthLimits.bytes / 2);
});

await test('the other projects count ended spend in its month and open pods until they end; a record without a last read stops new pods', async (t) => {
  const dir = await folder(t);
  const gpu = join(dir, 'gpu');
  const now = new Date(2026, 10, 12, 14, 0).getTime();
  const novemberStart = new Date(2026, 10, 1).getTime();
  assert.deepEqual(await readMonth(gpu, now), {
    spentUsd: 0,
    heldUsd: 0,
    unknown: null,
    problem: null,
  });
  await mkdir(gpu);
  await write(
    join(gpu, 'aaaaaaaaaaaaaaaa.json'),
    record({
      month: '2026-11',
      endedUsd: 3,
      open: [
        // Runs until tomorrow: its spend counts, and it holds the rest.
        {
          id: 'lease-4',
          spentUsd: 1,
          heldUsd: 2,
          endsAt: new Date(now + hour).toISOString(),
        },
        // Reached its end, though its owner did not write again: it holds nothing.
        {
          id: 'lease-5',
          spentUsd: 0.5,
          heldUsd: 4,
          endsAt: new Date(now - 1).toISOString(),
        },
      ],
    }),
    now,
  );
  await write(
    join(gpu, 'bbbbbbbbbbbbbbbb.json'),
    record({
      month: '2026-10',
      // October's ended spend does not count in November.
      endedUsd: 50,
      open: [
        // Ran past midnight into November: it counts now.
        {
          id: 'lease-1',
          spentUsd: 2,
          heldUsd: 1,
          endsAt: new Date(novemberStart + hour).toISOString(),
        },
        // Ended before November began.
        {
          id: 'lease-2',
          spentUsd: 9,
          heldUsd: 1,
          endsAt: new Date(novemberStart - hour).toISOString(),
        },
      ],
    }),
    now,
  );
  // Names that are not records are left out.
  await writeFile(join(gpu, 'notes.json'), 'not a record');
  const known = new Map<string, MonthRecord>();
  assert.deepEqual(await readMonth(gpu, now, known), {
    spentUsd: 6.5,
    heldUsd: 2,
    unknown: null,
    problem: null,
  });
  // The reader's own record is left out.
  assert.equal(
    (await readMonth(gpu, now, new Map(), 'bbbbbbbbbbbbbbbb.json')).spentUsd,
    4.5,
  );
  // A record that its owner last wrote well before this month is not read at all.
  const old = new Date(2026, 8, 1);
  await writeFile(join(gpu, 'cccccccccccccccc.json'), 'broken');
  await utimes(join(gpu, 'cccccccccccccccc.json'), old, old);
  assert.equal((await readMonth(gpu, now, known)).unknown, null);
  // A broken record counts as the last content that this process read, and the problem says so.
  await write(join(gpu, 'aaaaaaaaaaaaaaaa.json'), '{ not json', now);
  assert.deepEqual(await readMonth(gpu, now, known), {
    spentUsd: 6.5,
    heldUsd: 2,
    unknown: null,
    problem:
      "Verifold can't read the GPU record of 1 other project now, so it counts the spend that it read last.",
  });
  // Without a last read, Verifold cannot tell that project's spend, so no new pod starts. The line names the file and the way out.
  const fresh = await readMonth(gpu, now);
  assert.equal(fresh.spentUsd, 0);
  assert.equal(
    fresh.unknown,
    `Verifold can't read ${join(gpu, 'aaaaaaaaaaaaaaaa.json')}, the GPU record of another project, so it can't tell what that project spent, and no new pod starts. If that project no longer exists, remove the file. If it does, open Verifold in that project, so it writes the file again.`,
  );
  // A link is never followed, even to a good record.
  await write(
    join(gpu, 'aaaaaaaaaaaaaaaa.json'),
    record({ month: '2026-11', endedUsd: 0, open: [] }),
    now,
  );
  await writeFile(
    join(dir, 'outside.json'),
    record({ month: '2026-11', endedUsd: 9, open: [] }),
  );
  await symlink(join(dir, 'outside.json'), join(gpu, 'dddddddddddddddd.json'));
  await lutimes(
    join(gpu, 'dddddddddddddddd.json'),
    new Date(now),
    new Date(now),
  );
  assert.match(
    (await readMonth(gpu, now)).unknown ?? '',
    /dddddddddddddddd\.json, the GPU record of another project/,
  );
  // A gpu folder that is a file is not Verifold's.
  await rm(gpu, { recursive: true });
  await writeFile(gpu, 'a file');
  assert.match(
    (await readMonth(gpu, now)).unknown ?? '',
    /is not a folder, so Verifold can't tell what your projects spent on GPUs this month, and no new pod starts/,
  );
});

await test('more recent records than a check reads stop new pods', async (t) => {
  const dir = await folder(t);
  const gpu = join(dir, 'gpu');
  const now = new Date(2026, 9, 12, 14, 0).getTime();
  await mkdir(gpu);
  for (let index = 0; index <= monthLimits.files; index++)
    await writeFile(
      join(gpu, `${index.toString(16).padStart(16, '0')}.json`),
      record({ month: '2026-10', endedUsd: 1, open: [] }),
    );
  assert.equal(
    (await readMonth(gpu, now)).unknown,
    `${gpu} holds the GPU records of ${(monthLimits.files + 1).toString()} projects from this month, more than the ${monthLimits.files.toString()} that Verifold reads, so no new pod starts. Remove the records of projects that no longer exist.`,
  );
});

await test('the limit comes from the profile at each check, and a profile that Verifold cannot read stops new pods', async (t) => {
  const dir = await folder(t);
  const agency = join(dir, 'agency');
  const root = join(dir, 'project');
  await mkdir(root);
  const now = new Date(2026, 9, 12, 14, 0).getTime();
  // No profile, or a profile without GPU limits or without a monthly field: no monthly limit.
  assert.equal(await profileMonthLimit(agency), null);
  const month = new GpuMonth({ agency, root });
  assert.equal(await month.others(now), null);
  const older: Record<string, unknown> = { ...profileMoneyDefaults };
  delete older.monthUsd;
  await saveAgencyFile(
    agency,
    'settings.json',
    JSON.stringify({ host: 'claude', money: older }),
  );
  assert.equal(await profileMonthLimit(agency), null);
  await saveAgencyFile(
    agency,
    'settings.json',
    JSON.stringify({
      host: 'claude',
      money: { ...profileMoneyDefaults, monthUsd: 40 },
    }),
  );
  assert.equal(await profileMonthLimit(agency), 40);
  const counted = await month.others(now);
  assert.ok(counted && 'limitUsd' in counted && counted.limitUsd === 40);
  // GPU limits that cannot be read stop new pods, although the first run shows the defaults.
  await saveAgencyFile(
    agency,
    'settings.json',
    JSON.stringify({
      host: 'claude',
      money: { ...profileMoneyDefaults, monthUsd: -1 },
    }),
  );
  assert.deepEqual(await month.others(now), {
    unknown:
      "Your GPU limits in the profile can't be read. Set them again under GPU money.",
  });
  // A profile that cannot be read at all stops new pods too, also before any limit was read.
  await saveAgencyFile(agency, 'settings.json', '{ not json');
  const unread = await new GpuMonth({ agency, root }).others(now);
  assert.match(
    unread && 'unknown' in unread ? unread.unknown : '',
    /^Verifold can't read your profile, so no new pod starts until it can check your monthly GPU limit: /,
  );
});

await test('a project folder that cannot be found stops new pods until it can, and a removed profile folder comes back with its marker', async (t) => {
  const dir = await folder(t);
  const agency = join(dir, 'agency');
  const root = join(dir, 'project');
  const now = new Date(2026, 9, 12, 14, 0).getTime();
  const month = new GpuMonth({
    agency,
    root,
    limit: () => Promise.resolve(50),
  });
  // The project's folder is not there yet: the failure is not kept.
  const missing = await month.others(now);
  assert.match(
    missing && 'unknown' in missing ? missing.unknown : '',
    /^Verifold can't find this project's folder, so it can't count its GPU spend, and no new pod starts: /,
  );
  await mkdir(root);
  assert.deepEqual(await month.others(now), {
    limitUsd: 50,
    spentUsd: 0,
    heldUsd: 0,
    problem: null,
  });
  // No pods this month: no profile folder is made.
  await month.record([], now);
  await assert.rejects(stat(agency), /ENOENT/);
  await month.record([lease('lease-1', now - hour)], now);
  // The person removes the profile folder. The next record makes it again, with its marker.
  await rm(agency, { recursive: true });
  await month.record([lease('lease-1', now - hour)], now);
  assert.equal(
    await readFile(join(agency, '.verifold-agency'), 'utf8'),
    'Verifold agency v1\n',
  );
  // In November the October pods ended and count no more, so the record goes.
  await month.record(
    [ended('lease-1', now - hour, 1)],
    new Date(2026, 10, 2).getTime(),
  );
  assert.deepEqual(
    (await readdir(monthFolder(agency))).filter((name) =>
      name.endsWith('.json'),
    ),
    [],
  );
  // A folder that holds other files is not a Verifold profile, so no record goes there.
  const stray = join(dir, 'stray');
  await mkdir(stray);
  await writeFile(join(stray, 'notes.txt'), 'mine');
  await assert.rejects(
    new GpuMonth({
      agency: stray,
      root,
      limit: () => Promise.resolve(10),
    }).record([lease('lease-1', now - hour)], now),
    /Choose an empty agency directory or an existing Verifold agency/,
  );
});
