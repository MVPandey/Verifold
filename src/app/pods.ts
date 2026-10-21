import type {
  GpuType,
  Lab,
  PodLease,
  PodSettings,
  PodState,
  ProjectCompute,
} from '../protocol/api.ts';
import { clock, usd } from './format.ts';
import { numberOf, type GpuRow } from './components/Limits.tsx';

/** A pod's state in the words of the settings page. */
export const podStates: Readonly<Record<PodState, string>> = {
  requested: 'Waits for you',
  denied: 'Denied',
  starting: 'Starting',
  ready: 'Running',
  stopped: 'Stopped',
  ended: 'Ended',
  failed: 'Failed',
};

/** The pod runs, or starts, and bills. */
export function running(pod: PodLease): boolean {
  return pod.state === 'starting' || pod.state === 'ready';
}

/** Who asked for a pod: "You", "claude-2", or "The agent of d-2" when the lab does not show its agent. */
export function podAsker(pod: PodLease, lab: Lab | null): string {
  if (pod.asker === 'person') return 'You';
  if (pod.asker === 'coordinator') return 'The coordinator';
  const handles = pod.directions.map((id) => {
    const direction = lab?.directions.find((entry) => entry.id === id);
    return lab?.agents.find((entry) => entry.id === direction?.agent)?.handle;
  });
  if (handles.length && handles.every(Boolean)) return handles.join(' and ');
  return pod.directions.length
    ? `The agent of ${pod.directions.join(' and ')}`
    : 'An agent';
}

/** A GPU type's own name when Verifold read RunPod's list, else its ID. */
export function gpuName(id: string, compute: ProjectCompute): string {
  return compute.gpus?.types.find((gpu) => gpu.id === id)?.name ?? id;
}

/** The pods that wait for the person to approve or deny them, the oldest first. */
export function waitingPods(compute: ProjectCompute | undefined): PodLease[] {
  return (compute?.pods ?? [])
    .filter((pod) => pod.state === 'requested')
    .reverse();
}

/** The pods whose notice the person has not dismissed. */
export function podNotices(compute: ProjectCompute | undefined): PodLease[] {
  return (compute?.pods ?? []).filter((pod) => pod.notice);
}

/**
 * The lab home's line while pods run: "1 pod running · $0.42 so far · ends
 * 15:10", or with several, their rate. Null while none runs.
 */
export function podsLine(compute: ProjectCompute | undefined): string | null {
  const shown = (compute?.pods ?? []).filter(running);
  const [only] = shown;
  if (!compute || !only) return null;
  const spentUsd = shown.reduce((sum, pod) => sum + pod.spentUsd, 0);
  return shown.length === 1
    ? `1 pod running · ${usd(spentUsd)} so far${only.endsAt ? ` · ends ${clock(only.endsAt)}` : ''}`
    : `${shown.length} pods running · ${usd(spentUsd)} so far · ${usd(compute.budget.rateUsd)} an hour`;
}

/** The GPU rows to show: the common ones and the allowed ones, or every one. */
export function shownGpus(
  types: readonly GpuType[],
  allowed: readonly string[],
  all: boolean,
): GpuRow[] {
  return types.filter((gpu) => all || gpu.common || allowed.includes(gpu.id));
}

/** The pod settings as the person types them. */
export interface SettingsText {
  readonly limitUsd: string;
  readonly maxUsdPerHour: string;
  readonly maxHoursPerLease: string;
  readonly idleMinutes: string;
  readonly maxRunningPods: '1' | '2';
  readonly diskGb: string;
  /** One image on each line. */
  readonly images: string;
  readonly askBeforePod: boolean;
}

export function settingsText(settings: PodSettings): SettingsText {
  return {
    limitUsd: settings.limitUsd === null ? '' : String(settings.limitUsd),
    maxUsdPerHour: String(settings.maxUsdPerHour),
    maxHoursPerLease: String(settings.maxHoursPerLease),
    idleMinutes: String(settings.idleMinutes),
    maxRunningPods: settings.maxRunningPods === 2 ? '2' : '1',
    diskGb: String(settings.diskGb),
    images: settings.images.join('\n'),
    askBeforePod: settings.askBeforePod,
  };
}

/**
 * The settings to save from what the person typed, or why they cannot be
 * saved. An empty spend limit turns pods off. Verifold checks the ranges.
 */
export function settingsOf(
  text: SettingsText,
  gpuTypes: readonly string[],
): PodSettings | string {
  const numbers = {
    maxUsdPerHour: numberOf(text.maxUsdPerHour),
    maxHoursPerLease: numberOf(text.maxHoursPerLease),
    idleMinutes: numberOf(text.idleMinutes),
    diskGb: numberOf(text.diskGb),
  };
  const limitUsd = numberOf(text.limitUsd);
  if (
    Object.values(numbers).some((value) => value === null) ||
    (limitUsd === null && text.limitUsd.trim())
  )
    return 'Give each limit as a number. Leave the spend limit empty to turn pods off.';
  return {
    limitUsd,
    maxUsdPerHour: numbers.maxUsdPerHour ?? 0,
    maxHoursPerLease: numbers.maxHoursPerLease ?? 0,
    idleMinutes: numbers.idleMinutes ?? 0,
    maxRunningPods: text.maxRunningPods === '2' ? 2 : 1,
    gpuTypes,
    images: text.images
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    diskGb: numbers.diskGb ?? 0,
    askBeforePod: text.askBeforePod,
  };
}
