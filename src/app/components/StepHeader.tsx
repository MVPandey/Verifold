import { useEffect, type ReactNode } from 'react';
import type { SetupStep, SetupView } from '../../protocol/api.ts';
import { href, plainClick } from '../route.ts';
import { pageBefore, setupSteps, type StepNav } from '../setup.ts';

const stepNames: Readonly<Record<SetupStep, string>> = {
  agents: 'Agents',
  about: 'About you',
  skills: 'Skills (optional)',
  money: 'GPU money',
};

const stateNames = {
  done: 'done',
  skipped: 'skipped',
  none: 'not yet',
} as const;

/**
 * "Step 2 of 4: About you", a bar with one link for each step, the title,
 * and a lead line. Each segment shows its step's state: done, skipped, or
 * not yet, and the current step has a ring on top of its state. A plain
 * click opens the step through the setup page, which asks first when the
 * step has unsaved input. Any other click opens the link the browser's way.
 */
export function StepHeader({
  step,
  states,
  nav,
  title,
  children,
}: {
  readonly step: SetupStep;
  readonly states: SetupView['steps'];
  readonly nav: StepNav;
  readonly title: string;
  readonly children?: ReactNode;
}): ReactNode {
  // A step that this Verifold does not report, opened by its address, counts among all steps.
  const list = nav.steps.includes(step) ? nav.steps : setupSteps;
  const index = list.indexOf(step);
  return (
    <div className="step">
      <span className="step__label">
        Step {index + 1} of {list.length}: {stepNames[step]}
      </span>
      <nav aria-label="Setup steps" className="step__bar">
        {list.map((name) => {
          const state = states[name] ?? 'none';
          return (
            <a
              key={name}
              href={href.setup(name)}
              className="step__link"
              aria-label={`${stepNames[name]}, ${stateNames[state]}`}
              aria-current={name === step ? 'step' : undefined}
              title={`${stepNames[name]}: ${stateNames[state]}`}
              onClick={(event) => {
                if (!plainClick(event)) return;
                event.preventDefault();
                nav.open(name);
              }}
            >
              <span
                className={`step__segment${state === 'none' ? '' : ` step__segment--${state}`}`}
              />
            </a>
          );
        })}
      </nav>
      <h1 className="step__title">{title}</h1>
      {children && <p className="step__lead">{children}</p>}
    </div>
  );
}

/** Back: opens the step before through the setup page. It saves and skips nothing. */
export function BackButton({
  step,
  nav,
}: {
  readonly step: SetupStep;
  readonly nav: StepNav;
}): ReactNode {
  const before = pageBefore(step, nav.steps);
  if (!before) return null;
  return (
    <button
      type="button"
      className="button button--big"
      onClick={() => nav.open(before)}
    >
      Back
    </button>
  );
}

/**
 * Tells the setup page whether the step holds unsaved input, so Back, the
 * step bar and the link to the lab ask before they drop it. A step that
 * closes holds none.
 */
export function useUnsaved(unsaved: boolean, nav: StepNav): void {
  const report = nav.unsaved;
  useEffect(() => {
    report(unsaved);
  }, [unsaved, report]);
  useEffect(() => () => report(false), [report]);
}
