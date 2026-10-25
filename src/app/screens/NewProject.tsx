import type { ReactNode } from 'react';
import { dayClock } from '../format.ts';
import { Chevron, Logo } from '../components/Icons.tsx';
import { href } from '../route.ts';
import { setupSteps, type SetupActions } from '../setup.ts';
import { useSetup } from '../useSetup.ts';

/**
 * Without a project: does the new project use the global settings, or its
 * own? Global settings that nobody set up yet come first. An isolated
 * project's settings start as a copy of the global ones in this folder,
 * and never change them.
 */
export function NewProjectPage({
  setup,
}: {
  /** The global profile's read. */
  readonly setup: SetupActions;
}): ReactNode {
  const { view } = useSetup(setup.read);
  // Until the read answers, or when it fails, the page offers the global settings as they are.
  return (
    <NewProjectChoice
      set={!view || setupSteps.some((step) => view.steps[step])}
      copied={view?.ownCopied ?? null}
    />
  );
}

/**
 * The two choices. `set`: the global settings have a step done or skipped.
 * `copied`: when this folder's own settings were copied, which the person
 * can go on with. Tests render it directly.
 */
export function NewProjectChoice({
  set,
  copied,
}: {
  readonly set: boolean;
  readonly copied: string | null;
}): ReactNode {
  return (
    <div className="page">
      <header className="header">
        <Logo />
        <span className="header__brand">verifold</span>
      </header>
      <main className="setup">
        <div className="setup__column">
          <h1 className="step__title">How should this project start?</h1>
          <div className="starts">
            <a className="start" href={href.setup()}>
              <span className="start__text">
                <b className="start__name">
                  {set ? 'Use my global settings' : 'Set up my global settings'}
                </b>
                <span className="start__line">
                  {set
                    ? 'Your agents, profile, skills and GPU limits. On the next page, you can still change the agents, GPU money and hours for this project.'
                    : 'Set up your agents, profile, skills and GPU limits once. This project and the next ones start from them.'}
                </span>
              </span>
              <Chevron to="right" />
            </a>
            <a className="start" href={href.setup(undefined, 'project')}>
              <span className="start__text">
                <b className="start__name">
                  {copied
                    ? 'Continue this project’s settings'
                    : 'Isolated project'}
                </b>
                <span className="start__line">
                  {copied
                    ? `Agents, a profile, skills and GPU limits for this project only, copied from your global settings ${dayClock(copied)}.`
                    : set
                      ? 'Agents, a profile, skills and GPU limits for this project only. They start as a copy of your global settings. Your global settings don’t change.'
                      : 'Agents, a profile, skills and GPU limits for this project only. Your global settings don’t change.'}
                </span>
              </span>
              <Chevron to="right" />
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}
