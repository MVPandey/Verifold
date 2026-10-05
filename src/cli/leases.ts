import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { ComputeSettings } from './compute.ts';
import { RunPodError, type GpuOffer, type Pod, type RunPod } from './runpod.ts';
import { SessionActionError } from './session.ts';

/**
 * A lease is one RunPod pod for named tasks: one GPU type, one image, a
 * maximum number of hours, and the rate that its cost is counted at.
 * `requested` waits for the person. `starting`, `ready`, and `stopped` are
 * open: the pod exists. `denied`, `ended`, and `failed` are closed.
 */
export type LeaseState =
  | 'requested'
  | 'denied'
  | 'starting'
  | 'ready'
  | 'stopped'
  | 'ended'
  | 'failed';

/** Who or what stopped or ended a pod. */
export type Cause =
  | 'person'
  | 'coordinator'
  | 'deadline'
  | 'idle'
  | 'limit'
  | 'exit'
  | 'runpod'
  | 'recovery'
  | 'failure';

/** A time in which the pod could bill, at the rate that applied. */
export interface Interval {
  readonly start: string;
  readonly end: string | null;
  /** USD per hour for compute. */
  readonly rate: number;
}

export interface Lease {
  readonly schemaVersion: 1;
  /** `lease-1`, `lease-2`, … */
  readonly id: string;
  readonly state: LeaseState;
  readonly requestedBy: 'person' | 'coordinator';
  /** Why the pod is needed. A model claim when the coordinator wrote it. */
  readonly reason: string;
  readonly tasks: readonly string[];
  /** A RunPod GPU type ID. */
  readonly gpu: string;
  readonly image: string;
  readonly diskGb: number;
  /** The most hours that the lease can last, from the first create. */
  readonly hours: number;
  /** USD per hour: the list price at the request, then the rate that RunPod bills. */
  readonly rate: number;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  /** The pod name. It belongs to this project and this lease, so recovery can find the pod. */
  readonly podName: string;
  readonly podId: string | null;
  /** When the lease ends: the first create plus `hours`. A restart does not move it. */
  readonly deadline: string | null;
  readonly ssh: { readonly host: string; readonly port: number } | null;
  readonly intervals: readonly Interval[];
  /** What RunPod billed, from its hourly records. */
  readonly billedUsd: number | null;
  readonly billedAt: string | null;
  /** The last status that Verifold read. */
  readonly seen: {
    readonly at: string;
    readonly status: string;
    readonly gpuUtil: number | null;
  } | null;
  /** The last job on the pod, or when it became ready. The idle stop counts from it. */
  readonly activeAt: string | null;
  /** Something that the person should know. Needs you lists it until the person dismisses it. */
  readonly notice: string | null;
  readonly history: readonly {
    readonly at: string;
    readonly by: Cause | 'verifold';
    readonly text: string;
  }[];
  readonly end: {
    readonly at: string;
    readonly by: Cause;
    readonly reason: string;
  } | null;
}

export const leaseLimits = {
  /** Requests that wait for the person at the same time. */
  waiting: 3,
  tasks: 4,
  reason: 1000,
  history: 200,
  /** A pod that is not ready after this time is a bad machine draw. */
  startMs: 10 * 60_000,
  /** Before the spend limit, Verifold keeps this much running time in reserve. */
  marginMs: 5 * 60_000,
  billingMs: 15 * 60_000,
} as const;

function fail(message: string): never {
  throw new SessionActionError(message);
}

export function isOpen(lease: Lease): boolean {
  return (
    lease.state === 'starting' ||
    lease.state === 'ready' ||
    lease.state === 'stopped'
  );
}

export function isRunning(lease: Lease): boolean {
  return lease.state === 'starting' || lease.state === 'ready';
}

/** USD per hour for the container disk of a running pod: $0.10 per GB-month of 730 hours. */
export function diskRate(gb: number): number {
  return (gb * 0.1) / 730;
}

/** What a lease cost by `now`, counted from its intervals. */
export function accrued(lease: Lease, now: number): number {
  return lease.intervals.reduce((sum, interval) => {
    const start = Date.parse(interval.start);
    const end = interval.end ? Date.parse(interval.end) : now;
    return (
      sum +
      ((interval.rate + diskRate(lease.diskGb)) * Math.max(0, end - start)) /
        3_600_000
    );
  }, 0);
}

/** The larger of Verifold's count and RunPod's bill. */
export function spent(lease: Lease, now: number): number {
  return Math.max(accrued(lease, now), lease.billedUsd ?? 0);
}

/** What an open lease can still cost before its deadline. */
export function reserved(lease: Lease, now: number): number {
  if (!isOpen(lease)) return 0;
  const hours = lease.deadline
    ? Math.max(0, Date.parse(lease.deadline) - now) / 3_600_000
    : lease.hours;
  return (lease.rate + diskRate(lease.diskGb)) * hours;
}

/** The most that a new lease can cost: its rate and disk for all its hours. */
export function maxCost(rate: number, diskGb: number, hours: number): number {
  return (rate + diskRate(diskGb)) * hours;
}

export interface Budget {
  readonly limit: number | null;
  readonly spent: number;
  readonly reserved: number;
  /** The limit less what is spent and reserved. Null without a limit. */
  readonly left: number | null;
  /** USD per hour of the pods that run now. */
  readonly rate: number;
}

export function budget(
  leases: readonly Lease[],
  limit: number | null,
  now: number,
): Budget {
  const used = leases.reduce((sum, lease) => sum + spent(lease, now), 0);
  const held = leases.reduce((sum, lease) => sum + reserved(lease, now), 0);
  return {
    limit,
    spent: used,
    reserved: held,
    left: limit === null ? null : limit - used - held,
    rate: leases
      .filter(isRunning)
      .reduce((sum, lease) => sum + lease.rate + diskRate(lease.diskGb), 0),
  };
}

/** USD with cents. */
export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export interface LeaseHooks {
  /** A RunPod client with the stored key. It fails when no key is stored. */
  readonly client: () => Promise<RunPod>;
  readonly settings: () => ComputeSettings;
  /** The price and stock of a GPU type now, from the catalog. */
  readonly offer: (gpu: string) => Promise<GpuOffer | null>;
  /** One line for the terminal and the coordinator when a lease changes. */
  readonly onChange?: (lease: Lease, line: string) => void;
  /** Tests use a clock that they move. */
  readonly now?: () => number;
}

/**
 * The leases of one project, in `.verifold/compute/leases/`. Every change goes
 * through one queue and is saved before and after each RunPod call, so a crash
 * leaves a record that recovery can finish: the pod name finds a pod whose
 * create reply was lost.
 */
export class Leases {
  private readonly root: string;
  private readonly hooks: LeaseHooks;
  private leases: Lease[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  /** The last RunPod problem in a poll, for the view. */
  private problem: { readonly at: string; readonly text: string } | null = null;

  constructor(root: string, hooks: LeaseHooks) {
    this.root = root;
    this.hooks = hooks;
  }

  private now(): number {
    return this.hooks.now?.() ?? Date.now();
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private get folder(): string {
    return join(this.root, '.verifold', 'compute', 'leases');
  }

  /** Run one change after the earlier ones. */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  list(): readonly Lease[] {
    return this.leases;
  }

  lastProblem(): { readonly at: string; readonly text: string } | null {
    return this.problem;
  }

  get(id: unknown): Lease {
    return (
      this.leases.find((lease) => lease.id === id) ??
      fail(`No lease is named ${String(id).slice(0, 40)}.`)
    );
  }

  budget(): Budget {
    return budget(this.leases, this.hooks.settings().limitUsd, this.now());
  }

  /** Read the saved leases. An unreadable record is left out. */
  async load(): Promise<void> {
    const names = await readdir(this.folder).catch(() => []);
    const leases: Lease[] = [];
    for (const name of names) {
      if (!/^lease-\d{1,6}\.json$/.test(name)) continue;
      try {
        const path = join(this.folder, name);
        const stats = await lstat(path);
        if (!stats.isFile() || stats.size > 1_000_000) continue;
        const value = JSON.parse(await readFile(path, 'utf8')) as Lease;
        if (value.schemaVersion === 1 && `${value.id}.json` === name)
          leases.push(value);
      } catch {
        /* An unreadable record. */
      }
    }
    this.leases = leases.sort((a, b) => number(a.id) - number(b.id));
  }

  private async save(lease: Lease): Promise<Lease> {
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.folder)).isDirectory())
      fail('.verifold/compute/leases must be a folder, not a link.');
    const temporary = join(this.folder, `.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(lease, null, 2)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(this.folder, `${lease.id}.json`));
    } finally {
      await rm(temporary, { force: true });
    }
    this.leases = [
      ...this.leases.filter((entry) => entry.id !== lease.id),
      lease,
    ].sort((a, b) => number(a.id) - number(b.id));
    return lease;
  }

  /** Save a change, with a line in its history, and report it. */
  private async change(
    lease: Lease,
    patch: Partial<Lease>,
    by: Cause | 'verifold',
    text: string,
  ): Promise<Lease> {
    const next = await this.save({
      ...lease,
      ...patch,
      history: [...lease.history, { at: this.stamp(), by, text }].slice(
        -leaseLimits.history,
      ),
    });
    this.hooks.onChange?.(next, `${next.id}: ${text}`);
    return next;
  }

  /** Close the open interval, if any, at `at`. */
  private closed(lease: Lease, at: string): Interval[] {
    return lease.intervals.map((interval) =>
      interval.end ? interval : { ...interval, end: at },
    );
  }

  /**
   * Ask for a lease. Nothing is created or billed until the person approves.
   * Verifold refuses a request that does not fit the person's limits.
   */
  request(input: {
    readonly by: 'person' | 'coordinator';
    readonly gpu: unknown;
    readonly hours: unknown;
    readonly tasks: unknown;
    readonly reason: unknown;
    readonly image?: unknown;
  }): Promise<Lease> {
    return this.serial(async () => {
      const settings = this.hooks.settings();
      if (settings.limitUsd === null)
        fail('Pods are off: the person has not set a spend limit in Compute.');
      if (
        typeof input.gpu !== 'string' ||
        !settings.gpuTypes.includes(input.gpu)
      )
        fail(
          settings.gpuTypes.length
            ? `Ask for an allowed GPU type: ${settings.gpuTypes.join(', ')}.`
            : 'The person has allowed no GPU type in Compute yet.',
        );
      const hours = input.hours;
      if (
        typeof hours !== 'number' ||
        !Number.isInteger(hours) ||
        hours < 1 ||
        hours > settings.maxHoursPerLease
      )
        fail(`Ask for 1 to ${settings.maxHoursPerLease} hours.`);
      const tasks = Array.isArray(input.tasks) ? input.tasks : [];
      if (
        !tasks.length ||
        tasks.length > leaseLimits.tasks ||
        !tasks.every(
          (task) => typeof task === 'string' && /^task-\d{1,6}$/.test(task),
        )
      )
        fail(`Name 1 to ${leaseLimits.tasks} tasks that need the pod.`);
      const image =
        input.image === undefined ? settings.images[0] : input.image;
      if (typeof image !== 'string' || !settings.images.includes(image))
        fail(`Use an allowed image: ${settings.images.join(', ')}.`);
      const reason =
        typeof input.reason === 'string' && input.reason.trim()
          ? input.reason.trim().slice(0, leaseLimits.reason)
          : fail('Give a short reason. The person reads it.');
      if (
        this.leases.filter((lease) => lease.state === 'requested').length >=
        leaseLimits.waiting
      )
        fail(
          `${leaseLimits.waiting} requests already wait for the person. Wait for a decision.`,
        );
      const offer = await this.hooks.offer(input.gpu);
      if (!offer)
        fail(`RunPod does not offer ${input.gpu} on Secure Cloud now.`);
      if (offer.stock === 'NONE')
        fail(
          `RunPod has no ${input.gpu} in stock now. Ask for another allowed type.`,
        );
      if (offer.price > settings.maxUsdPerHour)
        fail(
          `${input.gpu} costs ${usd(offer.price)} per hour, above the cap of ${usd(settings.maxUsdPerHour)}.`,
        );
      const cost = maxCost(offer.price, settings.diskGb, hours);
      const left = this.budget().left ?? 0;
      if (cost > left)
        fail(
          `The lease can cost ${usd(cost)}, but only ${usd(Math.max(0, left))} of the limit is left.`,
        );
      const id = `lease-${(this.leases.reduce((top, lease) => Math.max(top, number(lease.id)), 0) + 1).toString()}`;
      const tag = createHash('sha256')
        .update(this.root)
        .digest('hex')
        .slice(0, 8);
      const lease: Lease = {
        schemaVersion: 1,
        id,
        state: 'requested',
        requestedBy: input.by,
        reason,
        tasks: [...new Set(tasks as string[])],
        gpu: input.gpu,
        image,
        diskGb: settings.diskGb,
        hours,
        rate: offer.price,
        requestedAt: this.stamp(),
        decidedAt: null,
        podName: `vf-${tag}-${id}-${randomBytes(2).toString('hex')}`,
        podId: null,
        deadline: null,
        ssh: null,
        intervals: [],
        billedUsd: null,
        billedAt: null,
        seen: null,
        activeAt: null,
        notice: null,
        history: [],
        end: null,
      };
      return this.change(
        lease,
        {},
        input.by,
        `${input.by === 'person' ? 'You' : 'The coordinator'} asked for a ${input.gpu} pod for ${hours} ${hours === 1 ? 'hour' : 'hours'} at ${usd(offer.price)} per hour, at most ${usd(cost)}.`,
      );
    });
  }

  /** The person approves a request. Verifold creates the pod, and RunPod bills from now on. */
  approve(id: unknown): Promise<Lease> {
    return this.serial(async () => {
      let lease = this.get(id);
      if (lease.state !== 'requested')
        fail(`${lease.id} does not wait for approval.`);
      const settings = this.hooks.settings();
      if (settings.limitUsd === null)
        fail('Set a spend limit in Compute first.');
      if (
        !settings.gpuTypes.includes(lease.gpu) ||
        !settings.images.includes(lease.image)
      )
        fail(
          `Your limits no longer allow ${lease.gpu} with ${lease.image}. Deny the request.`,
        );
      if (lease.rate > settings.maxUsdPerHour)
        fail(
          `The rate is above your cap of ${usd(settings.maxUsdPerHour)}. Deny the request.`,
        );
      if (this.leases.filter(isRunning).length >= settings.maxRunningPods)
        fail(
          `${settings.maxRunningPods} ${settings.maxRunningPods === 1 ? 'pod runs' : 'pods run'} already, your limit. Stop one first.`,
        );
      const cost = maxCost(lease.rate, lease.diskGb, lease.hours);
      const left = this.budget().left ?? 0;
      if (cost > left)
        fail(
          `The lease can cost ${usd(cost)}, but only ${usd(Math.max(0, left))} of your limit is left.`,
        );
      const client = await this.hooks.client();
      // The record says `starting` before the create, so a crash during it leaves the pod name to recover by.
      lease = await this.change(
        lease,
        { state: 'starting', decidedAt: this.stamp() },
        'person',
        'You approved the lease. Verifold asks RunPod for the pod.',
      );
      let pod: Pod | null = null;
      try {
        pod = await client.createPod({
          name: lease.podName,
          image: lease.image,
          gpu: lease.gpu,
          diskGb: lease.diskGb,
        });
      } catch (error) {
        // A lost reply can still have created the pod, so look for it by name.
        if (
          !(error instanceof RunPodError) ||
          error.status === null ||
          error.status >= 500
        )
          pod =
            (await client.pods().catch(() => [])).find(
              (entry) => entry.name === lease.podName,
            ) ?? null;
        if (!pod)
          return this.change(
            lease,
            {
              state: 'failed',
              end: {
                at: this.stamp(),
                by: 'failure',
                reason:
                  error instanceof Error
                    ? error.message
                    : 'RunPod did not create the pod.',
              },
              notice:
                `RunPod did not create the pod for ${lease.id}. ${error instanceof Error ? error.message : ''}`.trim(),
            },
            'failure',
            `RunPod did not create the pod. ${error instanceof Error ? error.message : ''}`.trim(),
          );
      }
      const at = this.stamp();
      return this.change(
        lease,
        {
          podId: pod.id,
          deadline: new Date(
            this.now() + lease.hours * 3_600_000,
          ).toISOString(),
          intervals: [
            {
              start: at,
              end: null,
              rate: pod.cost && pod.cost > 0 ? pod.cost : lease.rate,
            },
          ],
          rate: pod.cost && pod.cost > 0 ? pod.cost : lease.rate,
        },
        'verifold',
        `RunPod created pod ${pod.id}. It starts now.`,
      );
    });
  }

  /** The person denies a request. */
  deny(id: unknown): Promise<Lease> {
    return this.serial(async () => {
      const lease = this.get(id);
      if (lease.state !== 'requested')
        fail(`${lease.id} does not wait for approval.`);
      return this.change(
        lease,
        { state: 'denied', decidedAt: this.stamp() },
        'person',
        'You denied the lease.',
      );
    });
  }

  /** Stop the pod of a lease. RunPod erases its container disk. The lease stays open until its deadline. */
  stop(id: unknown, by: Cause, reason: string): Promise<Lease> {
    return this.serial(() => this.stopNow(this.get(id), by, reason));
  }

  private async stopNow(
    lease: Lease,
    by: Cause,
    reason: string,
  ): Promise<Lease> {
    if (!isRunning(lease) || !lease.podId)
      fail(`The pod of ${lease.id} does not run.`);
    await (await this.hooks.client()).action(lease.podId, 'stop');
    const at = this.stamp();
    return this.change(
      lease,
      { state: 'stopped', intervals: this.closed(lease, at), ssh: null },
      by,
      `Stopped the pod: ${reason}`,
    );
  }

  /** Start the stopped pod of an open lease again, inside the person's limits. */
  start(id: unknown, by: Cause, reason: string): Promise<Lease> {
    return this.serial(async () => {
      const lease = this.get(id);
      if (lease.state !== 'stopped' || !lease.podId)
        fail(`${lease.id} has no stopped pod.`);
      const settings = this.hooks.settings();
      if (settings.limitUsd === null)
        fail('Pods are off: no spend limit is set.');
      if (this.leases.filter(isRunning).length >= settings.maxRunningPods)
        fail(
          `${settings.maxRunningPods} ${settings.maxRunningPods === 1 ? 'pod runs' : 'pods run'} already.`,
        );
      if (lease.deadline && Date.parse(lease.deadline) <= this.now())
        fail(`${lease.id} reached its end. Ask for a new lease.`);
      await (await this.hooks.client()).action(lease.podId, 'start');
      return this.change(
        lease,
        {
          state: 'starting',
          intervals: [
            ...lease.intervals,
            { start: this.stamp(), end: null, rate: lease.rate },
          ],
        },
        by,
        `Started the pod again: ${reason}`,
      );
    });
  }

  /** End a lease now: Verifold deletes its pod. */
  end(id: unknown, by: Cause, reason: string): Promise<Lease> {
    return this.serial(() => this.endNow(this.get(id), by, reason));
  }

  private async endNow(
    lease: Lease,
    by: Cause,
    reason: string,
    notice: string | null = lease.notice,
  ): Promise<Lease> {
    if (lease.state === 'requested')
      return this.change(
        lease,
        { state: 'denied', decidedAt: this.stamp() },
        by,
        `Withdrew the request: ${reason}`,
      );
    if (!isOpen(lease)) fail(`${lease.id} has ended.`);
    if (lease.podId) await (await this.hooks.client()).terminate(lease.podId);
    const at = this.stamp();
    return this.change(
      lease,
      {
        state: 'ended',
        intervals: this.closed(lease, at),
        ssh: null,
        end: { at, by, reason },
        notice,
      },
      by,
      `Ended the lease and deleted the pod: ${reason}`,
    );
  }

  /** Remove the notice of a lease from Needs you. */
  dismiss(id: unknown): Promise<Lease> {
    return this.serial(async () => {
      const lease = this.get(id);
      return lease.notice ? this.save({ ...lease, notice: null }) : lease;
    });
  }

  /**
   * Read each open pod, and apply the person's limits: the end of each lease,
   * the idle stop, the rate cap, and the spend limit. A RunPod problem stops
   * the poll and shows in the view.
   */
  poll(): Promise<void> {
    return this.serial(async () => {
      const openLeases = this.leases.filter(isOpen);
      if (!openLeases.length) return;
      const settings = this.hooks.settings();
      let client: RunPod;
      try {
        client = await this.hooks.client();
      } catch (error) {
        this.problem = {
          at: this.stamp(),
          text: error instanceof Error ? error.message : 'No RunPod key.',
        };
        return;
      }
      try {
        for (const start of openLeases) {
          let lease = this.get(start.id);
          if (lease.deadline && Date.parse(lease.deadline) <= this.now()) {
            await this.endNow(
              lease,
              'deadline',
              `the lease reached its ${lease.hours} ${lease.hours === 1 ? 'hour' : 'hours'}.`,
            );
            continue;
          }
          if (!lease.podId) continue;
          const pod = await client.pod(lease.podId);
          const at = this.stamp();
          if (!pod || pod.status === 'TERMINATED') {
            await this.change(
              lease,
              {
                state: 'ended',
                intervals: this.closed(lease, at),
                ssh: null,
                end: {
                  at,
                  by: 'runpod',
                  reason: 'RunPod no longer has the pod.',
                },
                notice: `RunPod no longer has the pod of ${lease.id}, so the lease ended.`,
              },
              'runpod',
              'RunPod no longer has the pod.',
            );
            continue;
          }
          lease = await this.save({
            ...lease,
            seen: { at, status: pod.status, gpuUtil: pod.gpuUtil },
          });
          if (pod.status === 'ERROR') {
            await this.endNow(
              lease,
              'failure',
              'the pod reported an error.',
              `The pod of ${lease.id} reported an error, so Verifold deleted it.`,
            );
            continue;
          }
          if (pod.status === 'EXITED' && isRunning(lease)) {
            await this.change(
              lease,
              {
                state: 'stopped',
                intervals: this.closed(lease, at),
                ssh: null,
                notice: `The pod of ${lease.id} stopped outside Verifold.`,
              },
              'runpod',
              'The pod stopped outside Verifold.',
            );
            continue;
          }
          if (pod.status === 'RUNNING' && isRunning(lease)) {
            // A rate above the person's cap stops the lease at once.
            if (pod.cost && pod.cost > settings.maxUsdPerHour) {
              await this.endNow(
                lease,
                'limit',
                `RunPod bills ${usd(pod.cost)} per hour, above the cap.`,
                `RunPod billed ${usd(pod.cost)} per hour for ${lease.id}, above your cap, so Verifold deleted the pod.`,
              );
              continue;
            }
            const open = lease.intervals.at(-1);
            if (
              pod.cost &&
              pod.cost > 0 &&
              open &&
              !open.end &&
              Math.abs(open.rate - pod.cost) > 0.001
            )
              lease = await this.save({
                ...lease,
                rate: pod.cost,
                intervals: [
                  ...this.closed(lease, at),
                  { start: at, end: null, rate: pod.cost },
                ],
              });
            if (lease.state === 'starting' && pod.ssh)
              lease = await this.change(
                lease,
                { state: 'ready', ssh: pod.ssh, activeAt: at },
                'verifold',
                `The pod runs, with SSH at ${pod.ssh.host}:${pod.ssh.port}.`,
              );
          }
          const begun = lease.intervals.at(-1)?.start;
          if (
            lease.state === 'starting' &&
            begun &&
            this.now() - Date.parse(begun) > leaseLimits.startMs
          ) {
            await this.endNow(
              lease,
              'failure',
              'the pod did not start in 10 minutes.',
              `The pod of ${lease.id} did not start in 10 minutes, so Verifold deleted it. Ask for the lease again.`,
            );
            continue;
          }
          if (
            lease.state === 'ready' &&
            lease.activeAt &&
            this.now() - Date.parse(lease.activeAt) >=
              settings.idleMinutes * 60_000 &&
            (pod.gpuUtil === null || pod.gpuUtil < 5)
          ) {
            await this.stopNow(
              lease,
              'idle',
              `no job ran for ${settings.idleMinutes} minutes.`,
            );
            continue;
          }
          if (
            lease.podId &&
            (!lease.billedAt ||
              this.now() - Date.parse(lease.billedAt) >=
                leaseLimits.billingMs) &&
            lease.intervals[0]
          ) {
            const billed = await client.billed(
              lease.podId,
              lease.intervals[0].start,
            );
            await this.save({
              ...this.get(lease.id),
              billedUsd: billed,
              billedAt: this.stamp(),
            });
          }
        }
        // The spend limit: with the running pods' next minutes counted, every pod stops and every lease ends.
        const limit = settings.limitUsd;
        const now = this.now();
        const running = this.leases.filter(isRunning);
        if (
          limit !== null &&
          running.length &&
          this.leases.reduce((sum, lease) => sum + spent(lease, now), 0) +
            this.budget().rate * (leaseLimits.marginMs / 3_600_000) >=
            limit
        )
          for (const lease of running)
            await this.endNow(
              lease,
              'limit',
              'the project spend limit is reached.',
              `Verifold ended ${lease.id}: the project spend limit of ${usd(limit)} is reached.`,
            );
        this.problem = null;
      } catch (error) {
        this.problem = {
          at: this.stamp(),
          text:
            error instanceof Error ? error.message : 'RunPod did not answer.',
        };
      }
    });
  }

  /** A job ran on the pod of a lease, so the idle time starts again. */
  active(id: string): Promise<void> {
    return this.serial(async () => {
      const lease = this.leases.find((entry) => entry.id === id);
      if (lease?.state === 'ready')
        await this.save({ ...lease, activeAt: this.stamp() });
    });
  }

  /**
   * Verifold stops: stop every running pod, so billing stops. Returns a line
   * for each pod that Verifold could not stop.
   */
  close(): Promise<string[]> {
    return this.serial(async () => {
      const failed: string[] = [];
      for (const lease of this.leases.filter(isRunning))
        try {
          await this.stopNow(lease, 'exit', 'Verifold stopped.');
        } catch {
          failed.push(
            `Verifold could not stop the pod of ${lease.id} (${lease.podId ?? 'no ID'}). Stop it at https://console.runpod.io/pods.`,
          );
        }
      return failed;
    });
  }

  /**
   * After a start: finish what a crash or a stop left open. A lease whose
   * create reply was lost adopts its pod by name. A pod that runs although
   * Verifold was not running is stopped, and the person learns the cost.
   */
  recover(): Promise<void> {
    return this.serial(async () => {
      const openLeases = this.leases.filter(isOpen);
      if (!openLeases.length) return;
      let client: RunPod;
      try {
        client = await this.hooks.client();
      } catch (error) {
        this.problem = {
          at: this.stamp(),
          text: `Verifold could not check the open leases: ${error instanceof Error ? error.message : 'no key.'}`,
        };
        return;
      }
      for (const start of openLeases) {
        let lease = this.get(start.id);
        try {
          if (!lease.podId) {
            const pod = (await client.pods()).find(
              (entry) => entry.name === lease.podName,
            );
            if (!pod) {
              await this.change(
                lease,
                {
                  state: 'failed',
                  end: {
                    at: this.stamp(),
                    by: 'recovery',
                    reason: 'Verifold stopped before RunPod created the pod.',
                  },
                },
                'recovery',
                'Verifold stopped before RunPod created the pod.',
              );
              continue;
            }
            const at = this.stamp();
            lease = await this.change(
              lease,
              {
                podId: pod.id,
                deadline: new Date(
                  this.now() + lease.hours * 3_600_000,
                ).toISOString(),
                intervals: [{ start: at, end: null, rate: lease.rate }],
              },
              'recovery',
              `Found pod ${pod.id}, which RunPod created while Verifold stopped.`,
            );
          }
          if (!lease.podId) continue;
          const pod = await client.pod(lease.podId);
          const at = this.stamp();
          if (!pod || pod.status === 'TERMINATED') {
            await this.change(
              lease,
              {
                state: 'ended',
                intervals: this.closed(lease, at),
                ssh: null,
                end: {
                  at,
                  by: 'runpod',
                  reason: 'RunPod no longer has the pod.',
                },
              },
              'recovery',
              'RunPod no longer has the pod.',
            );
            continue;
          }
          if (lease.deadline && Date.parse(lease.deadline) <= this.now()) {
            await this.endNow(
              lease,
              'deadline',
              'the lease ended while Verifold stopped.',
            );
            continue;
          }
          if (
            pod.status === 'RUNNING' ||
            pod.status === 'PROVISIONING' ||
            pod.status === 'STARTING'
          ) {
            // Pods stop when Verifold stops. This one ran, so Verifold crashed, or someone started it.
            // The gap counts from the last time that Verifold saw the pod: an over-estimate is the safe side.
            const since = lease.seen?.at ?? lease.intervals.at(-1)?.start ?? at;
            const intervals = isRunning(lease)
              ? this.closed(lease, at)
              : [
                  ...lease.intervals,
                  { start: since, end: at, rate: lease.rate },
                ];
            const gap =
              ((lease.rate + diskRate(lease.diskGb)) *
                Math.max(0, this.now() - Date.parse(since))) /
              3_600_000;
            await client.action(lease.podId, 'stop');
            await this.change(
              lease,
              {
                state: 'stopped',
                intervals,
                ssh: null,
                notice: `The pod of ${lease.id} ran while Verifold was not running, so Verifold stopped it.${gap >= 0.01 ? ` That time cost about ${usd(gap)}.` : ''}`,
              },
              'recovery',
              'Stopped the pod, which ran while Verifold was not running.',
            );
            continue;
          }
          if (isRunning(lease))
            await this.change(
              lease,
              {
                state: 'stopped',
                intervals: this.closed(lease, at),
                ssh: null,
              },
              'recovery',
              'The pod stopped while Verifold was not running.',
            );
        } catch (error) {
          this.problem = {
            at: this.stamp(),
            text: `Verifold could not check ${lease.id}: ${error instanceof Error ? error.message : 'RunPod did not answer.'}`,
          };
        }
      }
    });
  }
}

function number(id: string): number {
  return Number(id.slice(6)) || 0;
}
