import { Fragment, useEffect, useState, type ReactNode } from 'react';
import type { ActOutcome } from '../api.ts';
import { ConfirmButton } from '../components/ConfirmButton.tsx';
import type { SetupStep, SetupView } from '../../protocol/api.ts';
import { Logo } from '../components/Icons.tsx';
import { StatusBar } from '../components/StatusBar.tsx';
import { href, parseRoute, plainClick, replaceRoute } from '../route.ts';
import {
  firstPage,
  pageAfter,
  setupSteps,
  shownSteps,
  type SetupActions,
  type SetupPage as Page,
  type StepNav,
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

/**
 * The first run's top bar: whose settings these are. With a project, it
 * leads back to the lab, through `onLeave`, which asks first while the step
 * holds unsaved input. An isolated project that starts can copy the global
 * settings again.
 */
function SetupHeader({
  project,
  own,
  onLeave,
  onCopy,
}: {
  readonly project: string;
  /** The settings are a project's own, not the global ones. */
  readonly own: boolean;
  readonly onLeave: (to: string) => void;
  /** Make an isolated project's settings a copy of the global ones again. */
  readonly onCopy?: (key: string) => Promise<ActOutcome>;
}): ReactNode {
  return (
    <header className="header">
      <Logo />
      <span className="header__brand">verifold</span>
      {own && <span className="header__note">This project’s settings</span>}
      <div className="header__spacer" />
      {onCopy && (
        <ConfirmButton
          label="Start again from my global settings"
          confirm="Click again to replace these settings"
          className="link-button link-button--quiet"
          run={onCopy}
        />
      )}
      {project ? (
        <a
          href={href.lab}
          onClick={(event) => {
            if (!plainClick(event)) return;
            event.preventDefault();
            onLeave(href.lab);
          }}
        >
          Back to the lab
        </a>
      ) : own ? null : (
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
  scope,
}: {
  readonly view: SetupView;
  readonly project: string;
  /** `project`: an isolated project that starts. */
  readonly scope?: 'project';
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
            <a href={href.setup(step, scope)}>
              {view.steps[step] === 'done' ? 'Change' : 'Set it up'}
            </a>
          </li>
        ))}
      </ul>
      {project ? (
        <p className="step__lead">
          {view.scope === 'project'
            ? 'This project uses these settings. Your global settings stay as they are. Its GPU limits for runs are in Settings.'
            : 'New projects start from this profile. A project that exists keeps its own GPU limits.'}{' '}
          <a href={href.lab}>Back to the lab</a>
        </p>
      ) : (
        <div className="setup__actions">
          <a
            className="button button--primary button--big"
            href={scope ? href.projectAsk : href.ask}
          >
            Ask your question
          </a>
        </div>
      )}
    </>
  );
}

/** A page of the first run. Without a project, the end of the first run is the Ask page. */
export function pageRoute(
  page: Page,
  project: string | null,
  scope?: 'project',
): string {
  if (page === 'done' && project === '')
    return scope ? href.projectAsk : href.ask;
  return href.setup(page, scope);
}

/**
 * What a step's request does when it answers: open the next page while the
 * page still shows the step that sent it, else only read the profile again.
 * `hash` is read when the answer arrives. A return to the same step before
 * the answer still counts as showing it.
 */
export function afterAnswer(
  hash: string,
  from: SetupStep,
  scope?: 'project',
): 'next' | 'refresh' {
  return hash === href.setup(from, scope) ? 'next' : 'refresh';
}

/**
 * What Back, a step link, or the link to the lab does: nothing for the page
 * that shows, ask first when the step has unsaved input, else open it.
 */
export function leaveFor(
  to: string,
  here: string,
  unsaved: boolean,
): 'none' | 'ask' | 'open' {
  if (to === here) return 'none';
  return unsaved ? 'ask' : 'open';
}

/**
 * The question before the page drops unsaved input. It shows only while
 * the person asked to leave and the step still holds unsaved input. No
 * browser dialog.
 */
export function UnsavedLine({
  leaving,
  unsaved,
  onLeave,
  onStay,
}: {
  /** The address that the person asked for. Null: they asked for none. */
  readonly leaving: string | null;
  readonly unsaved: boolean;
  readonly onLeave: () => void;
  readonly onStay: () => void;
}): ReactNode {
  if (!leaving || !unsaved) return null;
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
  scope?: 'project',
): string | null {
  return view && step === null && project !== null
    ? pageRoute(firstPage(view), project, scope)
    : null;
}

/**
 * The first run: `step` null opens the first step without a record. Each
 * step saves on its own and then opens the next one. Back, the step bar
 * and the link to the lab ask first while the step holds unsaved input.
 */
export function SetupPage({
  step,
  scope,
  actions,
  project,
}: {
  readonly step: Page | null;
  /** `project`: the own settings of an isolated project that starts. `actions` are for them too. */
  readonly scope?: 'project';
  readonly actions: SetupActions;
  /** The project's folder name. Empty: Verifold runs without a project. Null: before the first snapshot. */
  readonly project: string | null;
}): ReactNode {
  const { view, error, refresh, landed } = useSetup(actions.read);
  useEffect(() => {
    const to = openingRoute(view, step, project, scope);
    if (to) replaceRoute(to);
  }, [view, step, project, scope]);
  // A copy again of the global settings: the number of the read that follows it, until that read answers. Then the first step opens, and each step starts from the new view. A read that fails shows its error.
  const [copyRead, setCopyRead] = useState<number | null>(null);
  const [copyFailed, setCopyFailed] = useState<string | null>(null);
  const [copies, setCopies] = useState(0);
  useEffect(() => {
    if (copyRead === null || landed < copyRead) return;
    setCopyRead(null);
    if (error) {
      setCopyFailed(error);
      return;
    }
    setCopies((count) => count + 1);
    replaceRoute(href.setup(setupSteps[0], scope));
  }, [landed, copyRead, error, scope]);
  // The step reports whether it holds unsaved input. `leaving`: the address that Back, the step bar or the link to the lab asked for meanwhile.
  const [unsaved, setUnsaved] = useState(false);
  const [leaving, setLeaving] = useState<string | null>(null);
  useEffect(() => {
    setLeaving(null);
  }, [step]);
  // While the step holds unsaved input, a reload or a closed tab asks first. The browser's own Back does not.
  useEffect(() => {
    if (!unsaved) return;
    const ask = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Older browsers ask only when this is set.
      event.returnValue = '';
    };
    addEventListener('beforeunload', ask);
    return () => removeEventListener('beforeunload', ask);
  }, [unsaved]);
  const leave = (to: string): void => {
    location.hash = to;
    if (parseRoute(to).page === 'setup') refresh();
  };
  const open = (page: Page): void => leave(pageRoute(page, project, scope));
  /** Back, the step bar, and the link to the lab. */
  const go = (to: string): void => {
    const move = leaveFor(
      to,
      step === null ? '' : href.setup(step, scope),
      unsaved,
    );
    if (move === 'ask') setLeaving(to);
    else if (move === 'open') leave(to);
  };
  /** After a step's own request: the next page while the step shows. The profile is read again either way. */
  const after = (from: SetupStep, next: Page) => (): void => {
    if (afterAnswer(location.hash, from, scope) === 'next') open(next);
    else refresh();
  };
  // One list, so the label, the bar, Back and Continue agree.
  const steps = view ? shownSteps(view.steps) : setupSteps;
  const nav: StepNav = {
    steps,
    open: (page) => go(pageRoute(page, project, scope)),
    link: (page) => href.setup(page, scope),
    unsaved: setUnsaved,
  };
  let body: ReactNode;
  if (copyRead !== null)
    body = (
      <StatusBar tone="plan">Copying your global settings again.</StatusBar>
    );
  else if (copyFailed)
    body = (
      <div className="setup__problem">
        <span role="alert">
          Your global settings were copied again, but Verifold could not read
          them: {copyFailed}
        </span>
        <button
          type="button"
          className="button button--small"
          onClick={() => {
            setCopyFailed(null);
            setCopyRead(refresh());
          }}
        >
          Try again
        </button>
      </div>
    );
  else if (!view || step === null)
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
        nav={nav}
      />
    );
  else if (step === 'about')
    body = (
      <AboutStep
        view={view}
        actions={actions}
        refresh={refresh}
        onSaved={after('about', pageAfter('about', steps))}
        nav={nav}
      />
    );
  else if (step === 'skills')
    body = (
      <SkillsStep
        view={view}
        actions={actions}
        refresh={refresh}
        onDone={after('skills', pageAfter('skills', steps))}
        nav={nav}
      />
    );
  else if (step === 'money')
    body = (
      <MoneyStep
        view={view}
        actions={actions}
        refresh={refresh}
        onSaved={after('money', pageAfter('money', steps))}
        nav={nav}
      />
    );
  else
    body = (
      <DoneStep
        view={view}
        project={project ?? ''}
        {...(scope ? { scope } : {})}
      />
    );
  return (
    <div className="page">
      <SetupHeader
        project={project ?? ''}
        own={scope === 'project'}
        onLeave={go}
        // Only an isolated project that has not started copies the global settings again.
        {...(scope && project === ''
          ? {
              onCopy: async (key: string) => {
                const outcome = await actions.copyGlobal(key);
                if ('ok' in outcome) setCopyRead(refresh());
                return outcome;
              },
            }
          : {})}
      />
      <main className="setup">
        <div className="setup__column">
          <Fragment key={copies}>{body}</Fragment>
          <UnsavedLine
            leaving={leaving}
            unsaved={unsaved}
            onLeave={() => {
              if (!leaving) return;
              setLeaving(null);
              leave(leaving);
            }}
            onStay={() => setLeaving(null)}
          />
        </div>
      </main>
    </div>
  );
}
