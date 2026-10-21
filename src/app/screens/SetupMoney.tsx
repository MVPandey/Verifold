import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { MoneyLimits, SetupView } from '../../protocol/api.ts';
import { Check } from '../components/Icons.tsx';
import { StepHeader } from '../components/StepHeader.tsx';
import { clock, usd } from '../format.ts';
import { newKey } from '../intent.ts';
import { allowedGpus, type SetupActions } from '../setup.ts';
import { useAction } from '../useAction.ts';

/** The limit fields as the person types them. */
interface LimitText {
  readonly limitUsd: string;
  readonly maxUsdPerHour: string;
  readonly maxHoursPerLease: string;
  readonly idleMinutes: string;
  readonly maxRunningPods: '1' | '2';
  /** Empty: no monthly limit. */
  readonly monthUsd: string;
}

function textOf(limits: MoneyLimits): LimitText {
  return {
    // A profile with pods off shows the default, so "Finish setup" turns them on.
    limitUsd: String(limits.limitUsd ?? 25),
    maxUsdPerHour: String(limits.maxUsdPerHour),
    maxHoursPerLease: String(limits.maxHoursPerLease),
    idleMinutes: String(limits.idleMinutes),
    maxRunningPods: limits.maxRunningPods === 2 ? '2' : '1',
    monthUsd: String(limits.monthUsd ?? ''),
  };
}

/** A number that the person typed, or null when it is not one. */
function numberOf(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() && Number.isFinite(value) ? value : null;
}

/** When Verifold read the prices: "at 19:41 today", or with the date. */
export function readAt(at: string): string {
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString()
    ? `at ${clock(at)} today`
    : `on ${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} at ${clock(at)}`;
}

/** One number field with its unit, as in the artboard's "Limits". `note`: a line under it. */
function LimitField({
  label,
  before,
  after,
  value,
  onChange,
  min,
  step,
  note,
}: {
  readonly label: string;
  readonly before?: string;
  readonly after?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly min: number;
  readonly step: number;
  readonly note?: ReactNode;
}): ReactNode {
  const id = useId();
  const noteId = useId();
  return (
    <div className="limit">
      <label htmlFor={id} className="limit__label">
        {label}
      </label>
      <span className="limit__value">
        {before}
        <input
          id={id}
          className="limit__input"
          type="number"
          inputMode="decimal"
          min={min}
          step={step}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          {...(note ? { 'aria-describedby': noteId } : {})}
        />
        {after}
      </span>
      {note && (
        <span id={noteId} className="limit__note">
          {note}
        </span>
      )}
    </div>
  );
}

/**
 * Step 4, as in the artboard "4 GPU money": the RunPod key, RunPod's prices
 * now with the GPUs that agents may rent, and the limits that each new
 * project starts with.
 */
export function MoneyStep({
  view,
  actions,
  refresh,
  onSaved,
}: {
  readonly view: SetupView;
  readonly actions: SetupActions;
  readonly refresh: () => void;
  readonly onSaved: () => void;
}): ReactNode {
  const money = view.money;
  const keyField = useId();
  const [limits, setLimits] = useState<LimitText>(() => textOf(money.limits));
  // Null: the person did not tick any GPU, so the price cap decides.
  const [ticked, setTicked] = useState<readonly string[] | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [secret, setSecret] = useState('');
  const [file, setFile] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const cap = numberOf(limits.maxUsdPerHour) ?? money.limits.maxUsdPerHour;
  const allowed = ticked ?? allowedGpus(view, cap);
  const storeKey = useAction(
    (value: { readonly secret: string; readonly file: boolean }, key) =>
      actions.runpodKey(value.secret, value.file, key),
    (a, b) => a.secret === b.secret && a.file === b.file,
  );
  const prices = useAction((_: null, key) => actions.prices(key));
  const save = useAction((value: MoneyLimits, key) =>
    actions.money(value, key),
  );
  // With a key and no prices yet, the step reads them once when it opens.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !money.key || money.prices || money.reading) return;
    asked.current = true;
    void actions.prices(newKey()).then(refresh);
  }, [money.key, money.prices, money.reading, actions, refresh]);
  const finish = (pods: boolean): void => {
    const values = {
      limitUsd: numberOf(limits.limitUsd),
      maxUsdPerHour: numberOf(limits.maxUsdPerHour),
      maxHoursPerLease: numberOf(limits.maxHoursPerLease),
      idleMinutes: numberOf(limits.idleMinutes),
    };
    const missing = Object.entries(values).find(([, value]) => value === null);
    // An empty monthly field means no monthly limit.
    const month = numberOf(limits.monthUsd);
    if (
      (missing && (pods || missing[0] !== 'limitUsd')) ||
      (month === null && limits.monthUsd.trim())
    ) {
      setProblem('Give each limit as a number.');
      return;
    }
    setProblem(null);
    void save
      .submit({
        limitUsd: pods ? (values.limitUsd ?? 0) : null,
        maxUsdPerHour: values.maxUsdPerHour ?? 0,
        maxHoursPerLease: values.maxHoursPerLease ?? 0,
        idleMinutes: values.idleMinutes ?? 0,
        maxRunningPods: limits.maxRunningPods === '2' ? 2 : 1,
        gpuTypes: allowed,
        monthUsd: month,
      })
      .then((ok) => ok && onSaved());
  };
  const error = problem ?? storeKey.error ?? prices.error ?? save.error;
  const set = (field: keyof LimitText) => (value: string) =>
    setLimits((current) => ({ ...current, [field]: value }));
  return (
    <>
      <StepHeader step="money" title="When agents may rent GPUs">
        Agents rent a GPU on RunPod only when a direction needs one. The first
        rental in each project always asks you.
      </StepHeader>
      {money.key && !replacing ? (
        <div className="keyline">
          <span className="keyline__icon">
            <Check size={20} />
          </span>
          <span className="keyline__text">
            <b>RunPod key found</b>, ending in {money.key.last4}. It stays on
            this computer, outside your projects. Agents never see it.
            {money.key.problem && (
              <span className="keyline__problem">
                {' '}
                At the last check: {money.key.problem}
              </span>
            )}
          </span>
          <button
            type="button"
            className="button button--small"
            onClick={() => setReplacing(true)}
          >
            Replace
          </button>
        </div>
      ) : (
        <form
          className="keyform"
          onSubmit={(event) => {
            event.preventDefault();
            const value = secret.trim();
            if (!value || storeKey.busy) return;
            void storeKey
              .submit({ secret: value, file: file || !money.keyring })
              .then((ok) => {
                if (!ok) return;
                setSecret('');
                setReplacing(false);
                refresh();
              });
          }}
        >
          <label htmlFor={keyField} className="keyform__label">
            {money.key ? 'A new RunPod key' : 'Your RunPod key'}
          </label>
          <div className="keyform__row">
            <input
              id={keyField}
              className="keyform__input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={256}
              placeholder="Paste the key"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
            <button
              type="submit"
              className="button button--outline"
              disabled={storeKey.busy || !secret.trim()}
            >
              {storeKey.busy ? 'Checking' : 'Save'}
            </button>
            {money.key && (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setSecret('');
                  setReplacing(false);
                }}
              >
                Keep the stored key
              </button>
            )}
          </div>
          <span className="keyform__note">
            Verifold checks it with RunPod, then keeps it{' '}
            {money.keyring
              ? 'in your keyring'
              : 'in a private file, because this computer has no keyring'}
            , outside your projects. Agents never see it.{' '}
            <a
              href="https://docs.runpod.io/get-started/api-keys"
              target="_blank"
              rel="noreferrer"
            >
              How to make a key
            </a>
          </span>
          {money.keyring && (
            <label className="keyform__file">
              <input
                type="checkbox"
                checked={file}
                onChange={(event) => setFile(event.target.checked)}
              />
              Keep it in a private file instead of the keyring
            </label>
          )}
        </form>
      )}
      <section aria-labelledby="prices-title" className="prices">
        <div className="setup__heading">
          <h2 id="prices-title" className="setup__subtitle">
            Prices now
          </h2>
          {money.prices && (
            <span className="setup__meta">
              RunPod’s Secure Cloud list prices, read {readAt(money.prices.at)}.
              Each rental’s price comes from RunPod when an agent asks for it.
            </span>
          )}
        </div>
        {money.prices ? (
          <>
            <div className="prices__box">
              <table className="prices__table">
                <thead>
                  <tr>
                    <th scope="col">GPU</th>
                    <th scope="col">Memory</th>
                    <th scope="col" className="prices__number">
                      Per hour
                    </th>
                    <th scope="col" className="prices__allow">
                      Allow
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {money.prices.gpus.map((gpu) => (
                    <tr key={gpu.id}>
                      <td className="prices__name">{gpu.name}</td>
                      <td>{gpu.memoryGb ? `${gpu.memoryGb} GB` : ''}</td>
                      <td className="prices__number">{usd(gpu.usdPerHour)}</td>
                      <td className="prices__allow">
                        <input
                          type="checkbox"
                          aria-label={`Allow ${gpu.name}`}
                          checked={allowed.includes(gpu.id)}
                          onChange={(event) =>
                            setTicked(
                              event.target.checked
                                ? [...allowed, gpu.id]
                                : allowed.filter((id) => id !== gpu.id),
                            )
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <span className="setup__meta">
              Agents may rent the GPUs that you allow, at or under the price cap
              below.
            </span>
          </>
        ) : (
          <p className="setup__line muted">
            {money.reading
              ? 'Reading RunPod’s prices.'
              : money.key
                ? 'The prices could not be read.'
                : 'Prices show here once you add a key. Without a key, agents ask you before any rental.'}
            {money.key && !money.reading && (
              <>
                {' '}
                <button
                  type="button"
                  className="link-button"
                  disabled={prices.busy}
                  onClick={() => void prices.submit(null).then(() => refresh())}
                >
                  Read them again
                </button>
              </>
            )}
          </p>
        )}
        {money.problem && (
          <span role="alert" className="setup__error">
            {money.problem}
          </span>
        )}
      </section>
      <section aria-labelledby="limits-title" className="limits">
        <div className="setup__heading">
          <h2 id="limits-title" className="setup__subtitle">
            Limits
          </h2>
          <span className="setup__meta">
            Hard stops. Each project can change its own.
          </span>
        </div>
        {money.unreadable && (
          <p role="alert" className="setup__error limits__unread">
            {money.unreadable}
          </p>
        )}
        <LimitField
          label="A project spends at most"
          before="$"
          value={limits.limitUsd}
          onChange={set('limitUsd')}
          min={1}
          step={1}
        />
        <LimitField
          label="All projects together, each month"
          before="$"
          value={limits.monthUsd}
          onChange={set('monthUsd')}
          min={1}
          step={1}
          note={
            <>
              {money.month?.problem
                ? `${money.month.problem} `
                : money.month && money.month.spentUsd > 0
                  ? `Spent so far this month: ${usd(money.month.spentUsd)}. `
                  : 'Nothing spent this month. '}
              Leave it empty for no monthly limit. Two projects that rent at the
              same moment can go over it by one pod’s cost. Verifold then stops
              their pods.
            </>
          }
        />
        <LimitField
          label="Stop a pod that sits idle for"
          after="minutes"
          value={limits.idleMinutes}
          onChange={set('idleMinutes')}
          min={5}
          step={1}
        />
        <details className="limits__more">
          <summary>
            More limits: price per hour, pods at once, longest rental
          </summary>
          <LimitField
            label="A pod costs at most, per hour"
            before="$"
            value={limits.maxUsdPerHour}
            onChange={set('maxUsdPerHour')}
            min={0.1}
            step={0.1}
          />
          <div className="limit">
            <label htmlFor={`${keyField}-pods`} className="limit__label">
              Pods at once
            </label>
            <span className="limit__value">
              <select
                id={`${keyField}-pods`}
                className="select"
                value={limits.maxRunningPods}
                onChange={(event) =>
                  set('maxRunningPods')(event.target.value === '2' ? '2' : '1')
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
            value={limits.maxHoursPerLease}
            onChange={set('maxHoursPerLease')}
            min={1}
            step={1}
          />
        </details>
      </section>
      <p className="setup__note">
        Claude and Codex usage comes out of your plans. Each project shows what
        Claude Code estimates its work cost. When a plan’s usage limit runs out,
        the agents on it wait until it resets.
      </p>
      {error && (
        <span role="alert" className="setup__error">
          {error}
        </span>
      )}
      <div className="setup__actions">
        <button
          type="button"
          className="button button--primary button--big"
          disabled={save.busy}
          onClick={() => finish(true)}
        >
          Finish setup
        </button>
        <button
          type="button"
          className="link-button"
          disabled={save.busy}
          onClick={() => finish(false)}
        >
          No GPUs for now
        </button>
      </div>
    </>
  );
}
