import { useEffect, type ReactNode } from 'react';
import type { SetupView } from '../../protocol/api.ts';
import { Logo } from '../components/Icons.tsx';
import { StatusBar } from '../components/StatusBar.tsx';
import { href, replaceRoute } from '../route.ts';
import {
  firstPage,
  pageAfter,
  setupSteps,
  type SetupActions,
  type SetupPage as Page,
} from '../setup.ts';
import { useSetup } from '../useSetup.ts';
import { AboutStep } from './SetupAbout.tsx';
import { AgentsStep } from './SetupAgents.tsx';
import { MoneyStep } from './SetupMoney.tsx';
import { SkillsStep } from './SetupSkills.tsx';

const stepTitles = {
  agents: 'Your agents',
  about: 'About you',
  skills: 'Skills',
  money: 'GPU money',
} as const;

/** The first run's top bar. With a project, it leads back to the lab. */
function SetupHeader({ project }: { readonly project: string }): ReactNode {
  return (
    <header className="header">
      <Logo />
      <span className="header__brand">verifold</span>
      <div className="header__spacer" />
      {project ? (
        <a href={href.lab}>Back to the lab</a>
      ) : (
        <span className="header__note">
          Set up once. Every project starts from it.
        </span>
      )}
    </header>
  );
}

/** After the last step: what is set, what was skipped, and what comes next. */
export function DoneStep({
  view,
  project,
}: {
  readonly view: SetupView;
  readonly project: string;
}): ReactNode {
  // An older Verifold reports no Skills step, so the page leaves it out.
  const steps = setupSteps.filter((step) => view.steps[step] !== undefined);
  const skipped = steps.filter((step) => view.steps[step] !== 'done');
  return (
    <>
      <h1 className="step__title">
        {skipped.length ? 'Setup is saved' : 'You’re set'}
      </h1>
      <ul className="done">
        {steps.map((step) => (
          <li key={step} className="done__item">
            <span className="done__name">{stepTitles[step]}</span>
            <span
              className={view.steps[step] === 'done' ? 'done__ok' : 'muted'}
            >
              {view.steps[step] === 'done'
                ? 'Done'
                : view.steps[step] === 'skipped'
                  ? 'Skipped'
                  : 'Not yet'}
            </span>
            <a href={href.setup(step)}>
              {view.steps[step] === 'done' ? 'Change' : 'Set it up'}
            </a>
          </li>
        ))}
      </ul>
      {project ? (
        <p className="step__lead">
          New projects start from this profile. A project that exists keeps its
          own GPU limits. <a href={href.lab}>Back to the lab</a>
        </p>
      ) : (
        <div className="setup__actions">
          <a className="button button--primary button--big" href={href.ask}>
            Ask your question
          </a>
        </div>
      )}
    </>
  );
}

/**
 * The first run: `step` null opens the first step without a record. Each
 * step saves on its own and then opens the next one.
 */
export function SetupPage({
  step,
  actions,
  project,
}: {
  readonly step: Page | null;
  readonly actions: SetupActions;
  /** The project's folder name. Empty: Verifold runs without a project. */
  readonly project: string;
}): ReactNode {
  const { view, error, refresh } = useSetup(actions.read);
  // Without a project, the end of the first run is the Ask page.
  const pageHref = (page: Page): string =>
    page === 'done' && !project ? href.ask : href.setup(page);
  useEffect(() => {
    if (view && step === null) replaceRoute(pageHref(firstPage(view)));
  }, [view, step]);
  const open = (page: Page): void => {
    location.hash = pageHref(page);
    refresh();
  };
  let body: ReactNode;
  if (!view || step === null)
    body = error ? (
      <p role="alert" className="setup__error">
        {error}
      </p>
    ) : (
      <StatusBar tone="plan">Reading your profile.</StatusBar>
    );
  else if (step === 'agents')
    body = (
      <AgentsStep
        // A new check brings new rows, so the choices start again from them.
        key={view.agents.checking ? 'checking' : 'found'}
        view={view}
        actions={actions}
        refresh={refresh}
        onSaved={() => open(pageAfter('agents'))}
        onSkip={() => open('done')}
      />
    );
  else if (step === 'about')
    body = (
      <AboutStep
        view={view}
        actions={actions}
        refresh={refresh}
        onSaved={() => open(pageAfter('about'))}
      />
    );
  else if (step === 'skills')
    body = (
      <SkillsStep
        view={view}
        actions={actions}
        refresh={refresh}
        onDone={() => open(pageAfter('skills'))}
      />
    );
  else if (step === 'money')
    body = (
      <MoneyStep
        view={view}
        actions={actions}
        refresh={refresh}
        onSaved={() => open(pageAfter('money'))}
      />
    );
  else body = <DoneStep view={view} project={project} />;
  return (
    <div className="page">
      <SetupHeader project={project} />
      <main className="setup">
        <div className="setup__column">{body}</div>
      </main>
    </div>
  );
}
