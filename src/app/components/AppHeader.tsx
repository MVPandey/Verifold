import { useContext, type ReactNode } from 'react';
import type { Lab } from '../../protocol/api.ts';
import type { ActOutcome } from '../api.ts';
import { due, usd } from '../format.ts';
import { searchKeyLabel } from '../search.ts';
import { ToolsContext } from '../tools.ts';
import { useAction } from '../useAction.ts';
import { Logo, Magnifier } from './Icons.tsx';

/** The search key as this computer writes it: ⌘K on a Mac, Ctrl+K elsewhere. */
function searchKey(): string {
  return typeof navigator === 'undefined'
    ? '⌘K'
    : searchKeyLabel(navigator.platform);
}

/**
 * The top bar: the project, the money line, search, and pause. The project
 * switcher comes with a later slice of #282, so the bar shows none until it
 * works. Search shows when the app gives it, as it does for a lab.
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
  readonly onPause: (pause: boolean, key: string) => Promise<ActOutcome>;
}): ReactNode {
  const pause = useAction(onPause);
  const tools = useContext(ToolsContext);
  return (
    <header className="header">
      <Logo />
      <span className="header__project">{project}</span>
      <div className="header__spacer" />
      {lab && <MoneyLine lab={lab} now={now} />}
      {lab && tools && (
        <button
          type="button"
          className="button button--search"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={tools.openSearch}
        >
          <Magnifier />
          Search
          <kbd className="key">{searchKey()}</kbd>
        </button>
      )}
      {lab?.agentsHere && (
        <button
          type="button"
          className="button"
          disabled={pause.busy}
          onClick={() => void pause.submit(!lab.paused)}
        >
          {lab.paused ? 'Resume' : 'Pause'}
        </button>
      )}
      {pause.error && (
        <span role="alert" className="composer__error">
          {pause.error}
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
