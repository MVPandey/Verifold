import { useId, useState } from 'react';
import type { ReactElement } from 'react';

import type { Api } from '../api/client.ts';
import { messageOf } from '../api/client.ts';
import type { LabView } from '../api/types.ts';
import {
  LIMIT_NAMES,
  MAX_BUDGET_DOLLARS,
  MAX_BUDGET_TOKENS,
  MAX_DISK_GB,
  amountField,
  diskLine,
  spentLine,
  wholeField,
} from '../model/limits.ts';
import type { Budget } from '../model/setup.ts';

/** The text of the two fields of a budget, as the person typed it. */
export interface BudgetText {
  readonly tokens: string;
  readonly dollars: string;
}

/** Return the budget that the fields hold, or `null` when a field holds no amount that a budget takes. */
export function budgetOf(text: BudgetText): Budget | null {
  const tokens = wholeField(text.tokens, MAX_BUDGET_TOKENS);
  const dollars = amountField(text.dollars, MAX_BUDGET_DOLLARS);
  return tokens === undefined || dollars === undefined ? null : { tokens, dollars };
}

/** Return the fields' text for a budget. */
export function budgetText(budget: Budget): BudgetText {
  return { tokens: budget.tokens?.toString() ?? '', dollars: budget.dollars?.toString() ?? '' };
}

/** The two fields of a budget: tokens and US dollars. An empty field sets no budget of that kind. */
export function BudgetFields(props: {
  readonly value: BudgetText;
  readonly onChange: (value: BudgetText) => void;
}): ReactElement {
  const id = useId();
  const { value } = props;
  return (
    <>
      <div className="budget">
        <label htmlFor={`${id}-tokens`}>Tokens</label>
        <input
          id={`${id}-tokens`}
          inputMode="numeric"
          placeholder="No budget"
          value={value.tokens}
          onChange={(event) => props.onChange({ ...value, tokens: event.target.value })}
        />
        <label htmlFor={`${id}-dollars`}>Dollars</label>
        <input
          id={`${id}-dollars`}
          inputMode="decimal"
          placeholder="No budget"
          value={value.dollars}
          onChange={(event) => props.onChange({ ...value, dollars: event.target.value })}
        />
      </div>
      {budgetOf(value) === null ? (
        <p className="note">
          Type a whole number of tokens, and an amount of dollars such as 25 or 2.50.
        </p>
      ) : null}
    </>
  );
}

/**
 * The lab's budget and disk limit, in the panel of its time: what the lab spent, what its files take, and the
 * person's changes. A change counts for this lab only.
 */
export function LimitsPanel(props: {
  readonly lab: LabView;
  readonly api: Api;
  readonly onChange: () => void;
}): ReactElement {
  const { lab } = props;
  const [budget, setBudget] = useState<BudgetText>(() =>
    budgetText({ tokens: lab.budget.tokens, dollars: lab.budget.dollars }),
  );
  const [disk, setDisk] = useState(String(lab.settings.disk.limit_gb));
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const chosen = budgetOf(budget);
  const same =
    chosen !== null && chosen.tokens === lab.budget.tokens && chosen.dollars === lab.budget.dollars;
  const gigabytes = /^\d+$/.test(disk.trim()) ? Number(disk.trim()) : undefined;
  const diskOk = gigabytes !== undefined && gigabytes <= MAX_DISK_GB;

  const done = (sent: Promise<LabView>): void => {
    setError(null);
    sent.then(props.onChange, (failure: unknown) => setError(messageOf(failure)));
  };
  const setLabBudget = (): void => {
    if (chosen === null) return;
    done(
      props.api.setBudget({
        ...(chosen.tokens === null ? {} : { tokens: chosen.tokens }),
        ...(chosen.dollars === null ? {} : { dollars: chosen.dollars }),
      }),
    );
  };

  return (
    <div className="limits">
      <p>{spentLine(lab)}</p>
      {lab.limit && lab.limit !== 'disk' ? (
        <p className="stopline" role="status">
          The lab reached its {LIMIT_NAMES[lab.limit]}. The agents wait until you set a budget that
          the lab has not spent.
        </p>
      ) : null}
      <BudgetFields value={budget} onChange={setBudget} />
      <button
        className="btn small"
        type="button"
        disabled={chosen === null || same}
        onClick={setLabBudget}
      >
        Set budget
      </button>
      <p className="quiet">
        A turn reports what it spent when it ends, so the lab can pass its budget by the turns that
        run then. A harness that reports no cost adds no dollars.
      </p>
      <p>{diskLine(lab)}</p>
      {lab.limit === 'disk' ? (
        <p className="stopline" role="status">
          The lab reached its disk limit. The agents wait until you set a higher limit.
        </p>
      ) : null}
      <div className="budget">
        <label htmlFor={`${id}-disk`}>Disk limit in GB</label>
        <input
          id={`${id}-disk`}
          inputMode="numeric"
          value={disk}
          onChange={(event) => setDisk(event.target.value)}
        />
        <button
          className="btn small"
          type="button"
          disabled={!diskOk || gigabytes === lab.settings.disk.limit_gb}
          onClick={() => {
            if (gigabytes !== undefined) done(props.api.setDisk(gigabytes));
          }}
        >
          Set limit
        </button>
      </div>
      {diskOk ? null : <p className="note">Type a whole number of gigabytes. 0 means no limit.</p>}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
