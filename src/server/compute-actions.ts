import type { Compute } from '../core/compute.ts';
import { validAgents } from '../core/contracts.ts';
import { SessionActionError } from '../core/session.ts';
import { changeWorkspace } from '../core/storage.ts';
import type { Work } from '../protocol/api.ts';

/**
 * The project's compute actions, for the desk and for API v1. The key and
 * secret values come only in a request body, and no reply or record holds
 * them. Returns 400 for an action that is not one of them.
 */
export async function computeAction(
  compute: Compute,
  body: Record<string, unknown>,
): Promise<number> {
  switch (body.action) {
    case 'compute-key-save':
      await compute.setKey(body.key, body.file);
      return 200;
    case 'compute-key-check':
      await compute.checkKey();
      return 200;
    case 'compute-key-remove':
      await compute.removeKey();
      return 200;
    case 'compute-secret-save':
      await compute.setSecret(body.name, body.value, body.file);
      return 200;
    case 'compute-secret-remove':
      await compute.removeSecret(body.secret);
      return 200;
    case 'compute-gpus':
      await compute.refreshGpus();
      return 200;
    case 'compute-settings':
      await compute.changeSettings(body, body.base);
      return 200;
    case 'compute-lease-approve':
      await compute.leases.approve(body.lease);
      return 200;
    case 'compute-lease-deny':
      await compute.leases.deny(body.lease);
      return 200;
    case 'compute-lease-stop':
      await compute.leases.stop(body.lease, 'person', 'you stopped it.');
      return 200;
    case 'compute-lease-start':
      await compute.leases.start(body.lease, 'person', 'you started it.');
      return 200;
    case 'compute-lease-end':
      await compute.leases.end(body.lease, 'person', 'you ended it.');
      return 200;
    case 'compute-lease-dismiss':
      await compute.leases.dismiss(body.lease);
      return 200;
    default:
      return 400;
  }
}

/**
 * "Agents at once" of the project: saved in its record, and the new limit of
 * its worker slots. A lower limit stops no agent: new starts wait until fewer
 * run.
 */
export async function setAgentsAtOnce(
  root: string,
  slots: { limit: number },
  agents: unknown,
): Promise<void> {
  if (!validAgents(agents))
    throw new SessionActionError(
      'Choose a whole number of agents from 1 to 8.',
    );
  await changeWorkspace(root, (current) => {
    if (!current) throw new SessionActionError('The project has no record.');
    return { ...current, agents };
  });
  slots.limit = agents;
}

/** How long the same intent key gets the same answer. */
const answerMs = 60_000;

/** The pod actions that wait for RunPod, or for a pod's outputs to come back, with their words while they run. */
const slowActions: Readonly<Record<string, string>> = {
  'compute-lease-approve': 'Starting the pod',
  'compute-lease-stop': 'Stopping the pod',
  'compute-lease-start': 'Starting the pod again',
  'compute-lease-end': 'Ending the pod',
  'compute-gpus': 'Reading the prices',
};

/**
 * The actions that the app sends with the key of the person's intent. The
 * desk's key and secret actions are not among them: their `key` is a RunPod
 * key.
 */
const intentActions: ReadonlySet<string> = new Set([
  ...Object.keys(slowActions),
  'compute-settings',
  'compute-agents',
  'compute-lease-deny',
  'compute-lease-dismiss',
]);

/**
 * The compute actions of one desk. An action whose intent key came within
 * the last minute gets the same answer and runs nothing, so a retry after a
 * lost reply cannot run it twice. A slow action that has not ended after
 * `waitMs` answers 202 and goes on. A failure after the 202 shows in
 * `works` until the person dismisses it.
 */
export class ComputeRequests {
  /** Slow pod actions that run in the background, and the ones that failed there. */
  works: readonly Work[] = [];
  private readonly answers = new Map<
    string,
    { readonly status: Promise<number>; readonly at: number }
  >();
  private readonly waitMs: number;

  constructor(waitMs = 2_000) {
    this.waitMs = waitMs;
  }

  /** Answer `body`, running its action with `run` unless its intent key has an answer. */
  act(
    body: Record<string, unknown>,
    run: () => Promise<number>,
  ): Promise<number> {
    if (body.action === 'compute-dismiss') {
      this.works = this.works.filter((work) => work.error === null);
      return Promise.resolve(200);
    }
    const action = typeof body.action === 'string' ? body.action : '';
    const key =
      intentActions.has(action) &&
      typeof body.key === 'string' &&
      /^[a-f0-9]{32}$/.test(body.key)
        ? body.key
        : null;
    const now = Date.now();
    for (const [old, entry] of this.answers)
      if (entry.at < now - answerMs) this.answers.delete(old);
    const known = key ? this.answers.get(key) : undefined;
    if (known) return known.status;
    const label = slowActions[action];
    const status = label ? this.slow(action, label, body, run) : run();
    if (key) {
      this.answers.set(key, { status, at: now });
      // A refused request keeps no answer: the same request again tries again.
      status.catch(() => this.answers.delete(key));
    }
    return status;
  }

  private slow(
    action: string,
    label: string,
    body: Record<string, unknown>,
    run: () => Promise<number>,
  ): Promise<number> {
    const lease =
      typeof body.lease === 'string' && /^lease-[1-9]\d{0,5}$/.test(body.lease)
        ? body.lease
        : undefined;
    const work: Work = {
      action,
      label: lease ? `${label}: ${lease}` : label,
      at: new Date().toISOString(),
      error: null,
      ...(lease ? { lease } : {}),
    };
    // A new try replaces the earlier failure of the same action on the same pod.
    this.works = [
      ...this.works.filter(
        (entry) =>
          entry.error === null ||
          entry.action !== action ||
          entry.lease !== lease,
      ),
      work,
    ];
    let answered = false;
    const done = run().then(
      (code) => {
        this.works = this.works.filter((entry) => entry !== work);
        return code;
      },
      (error: unknown) => {
        // A failure after the 202 shows in `works`. One before it is the answer.
        this.works = this.works.flatMap((entry) =>
          entry !== work
            ? [entry]
            : answered
              ? [
                  {
                    ...work,
                    error:
                      error instanceof Error ? error.message : 'Unknown error.',
                  },
                ]
              : [],
        );
        throw error;
      },
    );
    done.catch(() => {});
    return Promise.race([
      done,
      new Promise<number>((resolve) =>
        setTimeout(() => resolve(202), this.waitMs).unref(),
      ),
    ]).finally(() => {
      answered = true;
    });
  }
}
