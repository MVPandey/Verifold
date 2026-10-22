import { useId, useState, type ReactNode } from 'react';
import type {
  Lab,
  PodLease,
  PodSettings,
  ProjectCompute,
  Snapshot,
} from '../../protocol/api.ts';
import type { ActOutcome } from '../api.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { Chevron } from '../components/Icons.tsx';
import { GpuTable, LimitField } from '../components/Limits.tsx';
import { PodNeeds, type OnPod, type PodActions } from '../components/Pods.tsx';
import { clock, dayClock, usd } from '../format.ts';
import {
  allowedNow,
  changesOf,
  gpuName,
  podAsker,
  podStates,
  running,
  settingsText,
  shownGpus,
  type SettingsText,
} from '../pods.ts';
import { href } from '../route.ts';
import type { Connection } from '../store.ts';
import { useAction } from '../useAction.ts';

/** The settings page's actions: the project's compute operations, each with the key of the person's intent. */
export interface ComputeActions extends PodActions {
  /**
   * Save the pod settings that the person changed. `base` is the version
   * that they edited: Verifold refuses the change when the settings changed
   * since.
   */
  readonly save: (
    changes: Partial<PodSettings>,
    base: string,
    key: string,
  ) => Promise<ActOutcome>;
  /** Read RunPod's GPUs and prices again. */
  readonly prices: (key: string) => Promise<ActOutcome>;
  readonly agents: (agents: number, key: string) => Promise<ActOutcome>;
}

/**
 * The project's settings: its pods, its GPU limits and the GPUs that agents
 * may rent, and how many agents work at once. A change applies to this
 * project only, at once. The profile keeps the defaults for new projects.
 */
export function SettingsPage({
  snapshot,
  connection,
  now,
  actions,
  onPause,
}: {
  readonly snapshot: Snapshot;
  readonly connection: Connection;
  readonly now: number;
  readonly actions: ComputeActions;
  readonly onPause: (pause: boolean, key: string) => Promise<ActOutcome>;
}): ReactNode {
  const compute = snapshot.compute;
  return (
    <div className="page">
      <AppHeader
        project={snapshot.project}
        lab={snapshot.lab}
        now={now}
        onPause={onPause}
      />
      <main className="main">
        <div className="column column--detail settings">
          <ConnectionBar connection={connection} at={snapshot.at} />
          <a className="back" href={href.lab}>
            <Chevron to="left" />
            The lab
          </a>
          <div className="settings__head">
            <h1 className="settings__title">Settings</h1>
            <p className="settings__intro">
              These settings belong to this project. A change applies at once,
              with no undo. New projects start from the defaults in{' '}
              <a href={href.setup('money')}>your profile</a>.
            </p>
          </div>
          {compute ? (
            <>
              <Pods
                compute={compute}
                lab={snapshot.lab}
                now={now}
                actions={actions}
              />
              <Limits compute={compute} actions={actions} />
              <AgentsAtOnce
                value={compute.agentsAtOnce}
                onSave={actions.agents}
              />
            </>
          ) : (
            <p className="settings__intro">
              This Verifold does not manage the pods of this project. Run{' '}
              <code>verifold</code> in the project folder to change them.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

/** A reason as a sentence: "its hours ended." shows as "Its hours ended." */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One row of the pods table, with Stop, Start again, and End where they apply. */
function PodRow({
  pod,
  compute,
  lab,
  onPod,
  earlier = false,
}: {
  readonly pod: PodLease;
  readonly compute: ProjectCompute;
  readonly lab: Lab | null;
  readonly onPod: OnPod;
  readonly earlier?: boolean;
}): ReactNode {
  const act = useAction((action: 'stop' | 'start' | 'end', key) =>
    onPod(action, pod.id, key),
  );
  const button = (action: 'stop' | 'start' | 'end', label: string) => (
    <button
      type="button"
      className="button button--small"
      disabled={act.busy}
      onClick={() => void act.submit(action)}
    >
      {label}
    </button>
  );
  return (
    <tr>
      <td>
        <b>{podAsker(pod, lab)}</b>
        {pod.directions.length > 0 && (
          <span className="pods__meta">for {pod.directions.join(', ')}</span>
        )}
      </td>
      <td>{gpuName(pod.gpu, compute)}</td>
      <td>
        {podStates[pod.state]}
        {pod.idleMinutes !== null && pod.idleMinutes >= 5 && (
          <span className="pods__meta">Idle {pod.idleMinutes} min</span>
        )}
      </td>
      <td className="prices__number">
        {usd(pod.spentUsd)}
        {running(pod) && (
          <span className="pods__meta">{usd(pod.rateUsd)} an hour</span>
        )}
      </td>
      <td>
        {earlier
          ? sentence(pod.ended?.reason ?? '')
          : pod.endsAt
            ? `Ends ${clock(pod.endsAt)}`
            : ''}
        {act.error && (
          <span role="alert" className="pods__error">
            {act.error}
          </span>
        )}
      </td>
      {!earlier && (
        <td className="pods__actions">
          {running(pod) && button('stop', 'Stop')}
          {pod.state === 'stopped' && button('start', 'Start again')}
          {(running(pod) || pod.state === 'stopped') && button('end', 'End')}
        </td>
      )}
      {earlier && <td />}
    </tr>
  );
}

function PodTable({
  pods,
  compute,
  lab,
  onPod,
  earlier = false,
}: {
  readonly pods: readonly PodLease[];
  readonly compute: ProjectCompute;
  readonly lab: Lab | null;
  readonly onPod: OnPod;
  readonly earlier?: boolean;
}): ReactNode {
  return (
    <div className="prices__box">
      <table className="prices__table pods__table">
        <thead>
          <tr>
            <th scope="col">Asked by</th>
            <th scope="col">GPU</th>
            <th scope="col">State</th>
            <th scope="col" className="prices__number">
              Cost so far
            </th>
            <th scope="col">{earlier ? 'How it ended' : 'Ends'}</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {pods.map((pod) => (
            <PodRow
              key={pod.id}
              pod={pod}
              compute={compute}
              lab={lab}
              onPod={onPod}
              earlier={earlier}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The pods: what waits for the person, what runs, what they cost, and the earlier ones. */
function Pods({
  compute,
  lab,
  now,
  actions,
}: {
  readonly compute: ProjectCompute;
  readonly lab: Lab | null;
  readonly now: number;
  readonly actions: PodActions;
}): ReactNode {
  const { budget, settings, month } = compute;
  const onPod = actions.pod;
  const open = compute.pods.filter(
    (pod) => running(pod) || pod.state === 'stopped',
  );
  return (
    <section className="section settings__section" aria-labelledby="pods">
      <h2 id="pods" className="settings__subtitle">
        Pods
      </h2>
      <p className="settings__line">
        {settings.limitUsd === null
          ? 'Pods are off: this project has no spend limit.'
          : `Spent ${usd(budget.spentUsd)}. Held for running pods ${usd(budget.heldUsd)}. Left ${usd(budget.leftUsd ?? 0)} of ${usd(settings.limitUsd)}.`}
        {budget.rateUsd > 0 && ` Pods cost ${usd(budget.rateUsd)} an hour now.`}
      </p>
      {month && (
        <p className="settings__line muted">
          This month, all projects: {usd(month.spentUsd)} of{' '}
          {usd(month.limitUsd)}.
        </p>
      )}
      {compute.problem && (
        <p role="alert" className="setup__error">
          {compute.problem.text}
        </p>
      )}
      <PodNeeds compute={compute} lab={lab} now={now} actions={actions} />
      {open.length ? (
        <PodTable pods={open} compute={compute} lab={lab} onPod={onPod} />
      ) : (
        <p className="settings__line muted">
          No pod runs. An agent asks for a pod when its direction needs a GPU.{' '}
          {settings.askBeforePod
            ? 'You approve each pod here or in Needs you.'
            : 'A pod that fits your limits starts at once. Other requests wait for you.'}
        </p>
      )}
      {compute.earlierCount > 0 && (
        <details className="limits__more">
          <summary>Earlier pods ({compute.earlierCount})</summary>
          <PodTable
            pods={compute.earlier}
            compute={compute}
            lab={lab}
            onPod={onPod}
            earlier
          />
        </details>
      )}
      <p className="settings__line muted">
        The cost counts every minute that a pod runs, its disk included. When
        RunPod bills more, Verifold shows RunPod’s figure.
      </p>
    </section>
  );
}

/**
 * The GPU limits and the GPUs that agents may rent, saved together. The form
 * shows the saved settings with the person's own changes on top, so a change
 * made elsewhere shows at once in the fields that they did not touch. Save
 * sends only their changes, with the version that they edited.
 */
function Limits({
  compute,
  actions,
}: {
  readonly compute: ProjectCompute;
  readonly actions: ComputeActions;
}): ReactNode {
  const imagesId = useId();
  const podsId = useId();
  const askId = useId();
  const [edits, setEdits] = useState<Partial<SettingsText>>({});
  const [added, setAdded] = useState<readonly string[]>([]);
  const [removed, setRemoved] = useState<readonly string[]>([]);
  // The version that the person's changes start from. Null: the version shown now.
  const [base, setBase] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const save = useAction(
    (
      value: { readonly changes: Partial<PodSettings>; readonly base: string },
      key,
    ) => actions.save(value.changes, value.base, key),
    (a, b) => JSON.stringify(a) === JSON.stringify(b),
  );
  const prices = useAction((_: null, key) => actions.prices(key));
  const saved = compute.settings.gpuTypes;
  const text = { ...settingsText(compute.settings), ...edits };
  const allowed = allowedNow(saved, added, removed);
  const touched = (): void => {
    setDone(false);
    if (base === null) setBase(compute.settingsVersion);
  };
  const set = (field: keyof SettingsText) => (value: string | boolean) => {
    touched();
    setEdits((current) => ({ ...current, [field]: value }));
  };
  const allow = (next: readonly string[]): void => {
    touched();
    const on = next.filter((id) => !allowed.includes(id));
    const off = allowed.filter((id) => !next.includes(id));
    setAdded((current) => [
      ...current.filter((id) => !off.includes(id)),
      ...on,
    ]);
    setRemoved((current) => [
      ...current.filter((id) => !on.includes(id)),
      ...off,
    ]);
  };
  const cap = Number(text.maxUsdPerHour) || compute.settings.maxUsdPerHour;
  const types = compute.gpus?.types ?? [];
  const rows = shownGpus(types, saved, all);
  const dirty =
    Object.keys(edits).length > 0 || added.length > 0 || removed.length > 0;
  const submit = (): void => {
    const changes = changesOf(
      edits,
      added.length || removed.length ? allowed : null,
    );
    if (typeof changes === 'string') {
      setProblem(changes);
      return;
    }
    setProblem(null);
    void save
      .submit({ changes, base: base ?? compute.settingsVersion })
      .then((ok) => {
        if (ok) {
          setEdits({});
          setAdded([]);
          setRemoved([]);
          setBase(null);
          setDone(true);
          return;
        }
        // The person sees the newest settings under their own changes. The
        // next edit or Save starts from the version shown then.
        setBase(null);
      });
  };
  const error = problem ?? save.error ?? prices.error;
  return (
    <>
      <section
        className="section settings__section"
        aria-labelledby="gpu-limits"
      >
        <h2 id="gpu-limits" className="settings__subtitle">
          GPU limits
        </h2>
        <div className="limits">
          <LimitField
            label="This project spends at most"
            before="$"
            value={text.limitUsd}
            onChange={set('limitUsd')}
            min={1}
            step={1}
            note="Leave it empty to turn pods off. Verifold stops every pod before the project spends more."
          />
          <LimitField
            label="Stop a pod that sits idle for"
            after="minutes"
            value={text.idleMinutes}
            onChange={set('idleMinutes')}
            min={5}
            step={1}
          />
          <label className="limit settings__check" htmlFor={askId}>
            <input
              id={askId}
              type="checkbox"
              checked={text.askBeforePod}
              onChange={(event) => set('askBeforePod')(event.target.checked)}
            />
            <span>
              Ask me before each pod starts
              <span className="limit__note">
                When this is off, a pod that fits these limits starts as soon as
                an agent asks, also while you are away.
              </span>
            </span>
          </label>
          <details className="limits__more">
            <summary>
              More limits: price per hour, pods at once, longest rental, disk,
              images
            </summary>
            <LimitField
              label="A pod costs at most, per hour"
              before="$"
              value={text.maxUsdPerHour}
              onChange={set('maxUsdPerHour')}
              min={0.1}
              step={0.1}
            />
            <div className="limit">
              <label htmlFor={podsId} className="limit__label">
                Pods at once
              </label>
              <span className="limit__value">
                <select
                  id={podsId}
                  className="select"
                  value={text.maxRunningPods}
                  onChange={(event) =>
                    set('maxRunningPods')(
                      event.target.value === '2' ? '2' : '1',
                    )
                  }
                >
                  <option value="1">1</option>
                  <option value="2">2</option>
                </select>
              </span>
            </div>
            <LimitField
              label="Longest rental"
              after="hours"
              value={text.maxHoursPerLease}
              onChange={set('maxHoursPerLease')}
              min={1}
              step={1}
            />
            <LimitField
              label="Disk of each pod"
              after="GB"
              value={text.diskGb}
              onChange={set('diskGb')}
              min={10}
              step={10}
            />
            <div className="limit settings__images">
              <label htmlFor={imagesId} className="limit__label">
                RunPod images that pods can use, one on each line
              </label>
              <textarea
                id={imagesId}
                className="settings__textarea"
                rows={2}
                maxLength={2000}
                spellCheck={false}
                value={text.images}
                onChange={(event) => set('images')(event.target.value)}
              />
            </div>
          </details>
        </div>
      </section>
      <section className="section settings__section" aria-labelledby="gpus">
        <h2 id="gpus" className="settings__subtitle">
          GPUs that agents may rent
        </h2>
        {!compute.keyStored ? (
          <p className="settings__line muted">
            Store a RunPod key under{' '}
            <a href={href.setup('money')}>GPU money in your profile</a> to see
            the GPUs and their prices.
            {allowed.length > 0 && ` Allowed now: ${allowed.join(', ')}.`}
          </p>
        ) : compute.gpus ? (
          <>
            <span className="setup__meta">
              RunPod’s Secure Cloud list prices, read{' '}
              {dayClock(compute.gpus.at)}. Each rental’s price comes from RunPod
              when an agent asks for it.
            </span>
            <GpuTable
              rows={rows}
              allowed={allowed}
              onAllow={allow}
              cap={cap}
              stock
            />
            <span className="settings__row">
              {types.length > rows.length && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setAll(true)}
                >
                  Show every GPU that RunPod lists ({types.length})
                </button>
              )}
              <button
                type="button"
                className="link-button"
                disabled={prices.busy}
                onClick={() => void prices.submit(null)}
              >
                {prices.busy ? 'Reading the prices' : 'Read the prices again'}
              </button>
            </span>
          </>
        ) : (
          <p className="settings__line muted">
            {allowed.length
              ? `Agents may rent ${allowed.join(', ')}. `
              : 'No GPU is allowed yet. '}
            <button
              type="button"
              className="link-button link-button--inline"
              disabled={prices.busy}
              onClick={() => void prices.submit(null)}
            >
              {prices.busy ? 'Reading the prices' : 'Show the GPUs and prices'}
            </button>
          </p>
        )}
        {error && (
          <p role="alert" className="setup__error">
            {error}
          </p>
        )}
        <div className="settings__save">
          <button
            type="button"
            className="button button--primary"
            disabled={save.busy || !dirty}
            onClick={submit}
          >
            {save.busy ? 'Saving' : 'Save the GPU settings'}
          </button>
          {done && !dirty && (
            <span role="status" className="settings__saved">
              Saved. They apply now.
            </span>
          )}
        </div>
      </section>
    </>
  );
}

/**
 * How many agents may work at the same time. The field shows the saved
 * number until the person types, so a change made elsewhere shows at once.
 */
function AgentsAtOnce({
  value,
  onSave,
}: {
  readonly value: number | null;
  readonly onSave: ComputeActions['agents'];
}): ReactNode {
  // Null: the person is not editing, and the field shows `value`.
  const [typed, setTyped] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const save = useAction((agents: number, key) => onSave(agents, key));
  const text = typed ?? (value === null ? '' : String(value));
  const agents = Number(text);
  const valid = Number.isInteger(agents) && agents >= 1 && agents <= 8;
  return (
    <section
      className="section settings__section"
      aria-labelledby="agents-at-once"
    >
      <h2 id="agents-at-once" className="settings__subtitle">
        Agents at once
      </h2>
      <div className="limits">
        <LimitField
          label="Agents that work at the same time, 1 to 8"
          value={text}
          onChange={(next) => {
            setTyped(next);
            setDone(false);
          }}
          min={1}
          step={1}
          note="Each agent uses your Claude Code or Codex plan, so more agents reach a plan’s usage limit sooner. A lower number stops no agent: new ones wait until fewer run."
        />
        <div className="settings__save">
          <button
            type="button"
            className="button"
            disabled={save.busy || !valid || agents === value}
            onClick={() =>
              void save.submit(agents).then((ok) => {
                if (!ok) return;
                setTyped(null);
                setDone(true);
              })
            }
          >
            Save
          </button>
          {done && (
            <span role="status" className="settings__saved">
              Saved.
            </span>
          )}
        </div>
        {save.error && (
          <p role="alert" className="setup__error">
            {save.error}
          </p>
        )}
      </div>
    </section>
  );
}
