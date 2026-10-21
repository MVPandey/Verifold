import type { Compute } from '../core/compute.ts';
import { validAgents } from '../core/contracts.ts';
import { SessionActionError } from '../core/session.ts';
import { changeWorkspace } from '../core/storage.ts';

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
      await compute.saveSettings(body);
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
