import { Fragment, useContext, type ReactNode } from 'react';
import type { Lab } from '../../protocol/api.ts';
import { moneyLine } from '../../ui/lab-lines.ts';
import type { ActOutcome } from '../api.ts';
import { href } from '../route.ts';
import { onMac, searchKey } from '../search.ts';
import { ToolsContext } from '../tools.ts';
import { useAction } from '../useAction.ts';
import { Logo, Magnifier } from './Icons.tsx';
import { MoreMenu } from './MoreMenu.tsx';

/**
 * The top bar: the project, the money line, search, pause, and links to the
 * project's settings and the person's profile. The project switcher comes
 * with a later slice of #282, so the bar shows none until it works. Search
 * shows when the app gives it, as it does for a lab.
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
  const key = searchKey(onMac);
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
          aria-keyshortcuts={key.aria}
          onClick={tools.openSearch}
        >
          <Magnifier />
          Search
          <kbd className="key">{key.label}</kbd>
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
      <a className="header__link" href={href.settings}>
        Settings
      </a>
      <a className="header__link" href={href.setup('agents')}>
        Profile
      </a>
      {/* The project menu: its earlier runs, and Start over while a lab is here. */}
      <MoreMenu>
        <a className="more-menu__item" href={href.history}>
          History
        </a>
        {lab?.agentsHere && (
          <a className="more-menu__item" href={href.startOver}>
            Start over
          </a>
        )}
      </MoreMenu>
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
  const parts = moneyLine(lab.money, lab.budget?.deadline ?? null, now);
  return (
    <span className="header__money">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && ' · '}
          {part.map((piece, at) => (
            <Fragment key={at}>
              {at > 0 && ' '}
              {piece.strong ? (
                <b>{piece.text}</b>
              ) : (
                <span className="muted">{piece.text}</span>
              )}
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}
