import { useEffect, useState, type ReactNode } from 'react';
import type { SetupStep, SetupView } from '../../protocol/api.ts';
import { Logo } from '../components/Icons.tsx';
import { StatusBar } from '../components/StatusBar.tsx';
import { href, parseRoute, replaceRoute } from '../route.ts';
import {
  firstPage,
  pageAfter,
  pageBefore,
  setupSteps,
  shownSteps,
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
  const steps = shownSteps(view.steps);
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

/** A page of the first run. Without a project, the end of the first run is the Ask page. */
export function pageRoute(page: Page, project: string | null): string {
  return page === 'done' && project === '' ? href.ask : href.setup(page);
}

/**
 * A step's request ended. Its next page opens only while the page still
 * shows that step, so a Back or a step link meanwhile is not undone.
 */
export function stillOn(hash: string, step: SetupStep): boolean {
  const route = parseRoute(hash);
  return route.page === 'setup' && route.step === step;
}

/**
 * What Back or a step link does: nothing on the page that shows, ask first
 * when the step has unsaved input, else open the page.
 */
export function leaveFor(
  page: Page,
  step: Page | null,
  unsaved: boolean,
): 'none' | 'ask' | 'open' {
  if (page === step) return 'none';
  return unsaved ? 'ask' : 'open';
}

/** Back or a step link while the step has unsaved input. No browser dialog. */
export function UnsavedLine({
  onLeave,
  onStay,
}: {
  readonly onLeave: () => void;
  readonly onStay: () => void;
}): ReactNode {
  return (
    <div role="alert" className="setup__problem">
      <span>Your changes on this step aren’t saved.</span>
      <div className="setup__row">
        <button
          type="button"
          className="button button--small"
          onClick={onLeave}
        >
          Leave without saving
        </button>
        {/* Focus moves here, so the line comes into view wherever the click was. */}
        <button
          type="button"
          className="button button--small"
          autoFocus
          onClick={onStay}
        >
          Stay
        </button>
      </div>
    </div>
  );
}

/**
 * Where `#/setup` leads: the first step without a record, once the first
 * run and the first snapshot are read. Before the snapshot, nobody knows
 * whether a project exists, so it waits. Null: stay.
 */
export function openingRoute(
  view: SetupView | null,
  step: Page | null,
  project: string | null,
): string | null {
  return view && step === null && project !== null
    ? pageRoute(firstPage(view), project)
    : null;
}

/**
 * The first run: `step` null opens the first step without a record. Each
 * step saves on its own and then opens the next one. Back and the step bar
 * ask first when the step has unsaved input.
 */
export function SetupPage({
  step,
  actions,
  project,
}: {
  readonly step: Page | null;
  readonly actions: SetupActions;
  /** The project's folder name. Empty: Verifold runs without a project. Null: before the first snapshot. */
  readonly project: string | null;
}): ReactNode {
  const { view, error, refresh } = useSetup(actions.read);
  useEffect(() => {
    const to = openingRoute(view, step, project);
    if (to) replaceRoute(to);
  }, [view, step, project]);
  // The step reports whether it holds unsaved input. `leaving`: the page that Back or a step link asked for meanwhile.
  const [unsaved, setUnsaved] = useState(false);
  const [leaving, setLeaving] = useState<Page | null>(null);
  useEffect(() => {
    setLeaving(null);
  }, [step]);
  const open = (page: Page): void => {
    location.hash = pageRoute(page, project);
    refresh();
  };
  /** Back and the step bar. */
  const go = (page: Page): void => {
    const move = leaveFor(page, step, unsaved);
    if (move === 'ask') setLeaving(page);
    else if (move === 'open') open(page);
  };
  /** After a step's own request: the next page, unless the person left the step meanwhile. */
  const after = (from: SetupStep, next: Page) => (): void => {
    if (stillOn(location.hash, from)) open(next);
  };
  const steps = view ? shownSteps(view.steps) : setupSteps;
  const back = (from: SetupStep) => (): void => {
    const before = pageBefore(from, steps);
    if (before) go(before);
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
        onSaved={after('agents', pageAfter('agents', steps))}
        onSkip={after('agents', 'done')}
        onOpen={go}
        onUnsaved={setUnsaved}
      />
    );
  else if (step === 'about')
    body = (
      <AboutStep
        view={view}
        actions={actions}
        refresh={refresh}
        onSaved={after('about', pageAfter('about', steps))}
        onBack={back('about')}
        onOpen={go}
        onUnsaved={setUnsaved}
      />
    );
  else if (step === 'skills')
    body = (
      <SkillsStep
        view={view}
        actions={actions}
        refresh={refresh}
        onDone={after('skills', pageAfter('skills', steps))}
        onBack={back('skills')}
        onOpen={go}
      />
    );
  else if (step === 'money')
    body = (
      <MoneyStep
        view={view}
        actions={actions}
        refresh={refresh}
        onSaved={after('money', pageAfter('money', steps))}
        onBack={back('money')}
        onOpen={go}
        onUnsaved={setUnsaved}
      />
    );
  else body = <DoneStep view={view} project={project ?? ''} />;
  return (
    <div className="page">
      <SetupHeader project={project ?? ''} />
      <main className="setup">
        <div className="setup__column">
          {body}
          {leaving && (
            <UnsavedLine
              onLeave={() => {
                setLeaving(null);
                open(leaving);
              }}
              onStay={() => setLeaving(null)}
            />
          )}
        </div>
      </main>
    </div>
  );
}
