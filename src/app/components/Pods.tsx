import type { ReactNode } from 'react';
import type { Lab, PodLease, ProjectCompute } from '../../protocol/api.ts';
import type { ActOutcome } from '../api.ts';
import { since, usd } from '../format.ts';
import { gpuName, podAsker, podsLine } from '../pods.ts';
import { href } from '../route.ts';
import { useAction } from '../useAction.ts';

export type PodAction =
  | 'approve'
  | 'deny'
  | 'stop'
  | 'start'
  | 'end'
  | 'dismiss';

/** One action on one pod, with the key of the person's intent. */
export type OnPod = (
  action: PodAction,
  lease: string,
  key: string,
) => Promise<ActOutcome>;

/** A pod action for one button: the same intent keeps its key on a retry. */
function usePod(onPod: OnPod) {
  return useAction(
    (value: { readonly action: PodAction; readonly lease: string }, key) =>
      onPod(value.action, value.lease, key),
    (a, b) => a.action === b.action && a.lease === b.lease,
  );
}

/**
 * A pod that waits for the person: who asks, the GPU, the most that it can
 * cost, why, and Approve and Deny. A pod that lacks a secret says how to
 * store it, and can only be denied until then.
 */
export function PodRequest({
  pod,
  compute,
  lab,
  now,
  onPod,
}: {
  readonly pod: PodLease;
  readonly compute: ProjectCompute;
  readonly lab: Lab | null;
  readonly now: number;
  readonly onPod: OnPod;
}): ReactNode {
  const act = usePod(onPod);
  const who = podAsker(pod, lab);
  const missing = pod.missingSecrets;
  return (
    <div className="needs needs--pod">
      <span className="needs__label">Needs you</span>
      <span className="needs__body">
        <b>
          {who} {who === 'You' ? 'asked' : 'asks'} for a pod with one{' '}
          {gpuName(pod.gpu, compute)}, up to {usd(pod.maxUsd)}
        </b>
        <span className="needs__meta">
          {pod.hours} {pod.hours === 1 ? 'hour' : 'hours'} at {usd(pod.rateUsd)}{' '}
          an hour · waiting {since(pod.requestedAt, now)}
          {compute.settings.askBeforePod
            ? ' · you approve each pod'
            : ' · it does not fit your limits now'}
        </span>
        <span className="pod-why">
          {who === 'You' ? 'Your reason' : `${who} says`}: {pod.reason.text}
        </span>
        {missing.length > 0 && (
          <span className="pod-missing">
            The pod needs {missing.length === 1 ? 'the secret' : 'the secrets'}{' '}
            {missing.join(' and ')}, which this computer does not store yet.
            Store {missing.length === 1 ? 'it' : 'each one'} in a terminal with{' '}
            <code>verifold runpod secret set {missing[0]}</code>, then approve
            the pod.
          </span>
        )}
        {act.error && (
          <span role="alert" className="needs__failure">
            {act.error}
          </span>
        )}
      </span>
      <span className="pod-actions">
        <button
          type="button"
          className="button button--dark"
          disabled={act.busy || missing.length > 0}
          onClick={() => void act.submit({ action: 'approve', lease: pod.id })}
        >
          Approve, up to {usd(pod.maxUsd)}
        </button>
        <button
          type="button"
          className="button"
          disabled={act.busy}
          onClick={() => void act.submit({ action: 'deny', lease: pod.id })}
        >
          Deny
        </button>
      </span>
    </div>
  );
}

/** Something that Verifold changed on a pod, until the person dismisses it. */
export function PodNotice({
  pod,
  now,
  onPod,
}: {
  readonly pod: PodLease;
  readonly now: number;
  readonly onPod: OnPod;
}): ReactNode {
  const act = usePod(onPod);
  return (
    <div className="status status--muted pod-notice">
      <span className="pod-notice__text">
        <b>{pod.id}:</b> {pod.notice}
        {pod.noticeAt && (
          <span className="muted"> · {since(pod.noticeAt, now)}</span>
        )}
        {act.error && (
          <span role="alert" className="needs__failure">
            {' '}
            {act.error}
          </span>
        )}
      </span>
      <button
        type="button"
        className="link-button"
        disabled={act.busy}
        onClick={() => void act.submit({ action: 'dismiss', lease: pod.id })}
      >
        Dismiss
      </button>
    </div>
  );
}

/** "1 pod running · $0.42 so far · ends 15:10", which opens the pods. Nothing while no pod runs. */
export function PodsLine({
  compute,
}: {
  readonly compute: ProjectCompute | undefined;
}): ReactNode {
  const line = podsLine(compute);
  if (!line) return null;
  return (
    <a className="status status--plan pods-line" href={href.settings}>
      <span aria-hidden="true" className="dot" />
      {line}
    </a>
  );
}
