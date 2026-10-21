import { useState, type ReactNode } from 'react';
import type { Lab } from '../../protocol/api.ts';
import { due, usd } from '../format.ts';
import { href } from '../route.ts';
import { ChevronDown, Logo, Search } from './Icons.tsx';

/**
 * The top bar: the project, the money line, search, and pause. `onPause`
 * resolves to Verifold's reason when it refused.
 */
export function AppHeader({
  project,
  lab,
  now,
  onPause,
}: {
  readonly project: string;
  readonly lab: Lab | null;
  readonly now: number;
  readonly onPause?: (pause: boolean) => Promise<string | null>;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = async (): Promise<void> => {
    if (!onPause || !lab) return;
    setBusy(true);
    setError(await onPause(!lab.paused));
    setBusy(false);
  };
  return (
    <header className="header">
      <Logo />
      <a
        className="header__project"
        href={href.projects}
        aria-label={`${project}, switch project`}
      >
        {project}
        <ChevronDown />
      </a>
      <div className="header__spacer" />
      {lab && <MoneyLine lab={lab} now={now} />}
      {lab && (
        <a className="button button--search" href={href.search}>
          <Search />
          Search
          <kbd>⌘K</kbd>
        </a>
      )}
      {lab && onPause && lab.agentsHere && (
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void toggle()}
        >
          {lab.paused ? 'Resume' : 'Pause'}
        </button>
      )}
      {error && (
        <span role="alert" className="composer__error">
          {error}
        </span>
      )}
    </header>
  );
}

/** "Due Fri 18:00 · ≈$3.10 plans · $4.20 of $25 GPU" */
export function MoneyLine({
  lab,
  now,
}: {
  readonly lab: Lab;
  readonly now: number;
}): ReactNode {
  const { money, budget } = lab;
  return (
    <span className="header__money">
      {budget && (
        <>
          <span className="muted">Due</span> <b>{due(budget.deadline, now)}</b>
          {' · '}
        </>
      )}
      <b>≈{usd(money.plansUsd)}</b> <span className="muted">plans</span>
      {' · '}
      <b>{usd(money.gpuUsd)}</b>{' '}
      <span className="muted">
        {money.gpuLimitUsd === null
          ? 'GPU'
          : `of ${usd(money.gpuLimitUsd)} GPU`}
      </span>
    </span>
  );
}
