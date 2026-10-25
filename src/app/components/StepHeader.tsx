import { useEffect, type ReactNode } from 'react';
import type { SetupStep, SetupView } from '../../protocol/api.ts';
import { href } from '../route.ts';
import { setupSteps, shownSteps } from '../setup.ts';

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
 * not yet, and the current step stands out. A click opens the step through
 * `onOpen`, which asks first when the step has unsaved input. The link keeps
 * its address, so a click with a modifier key opens it the browser's way.
 */
export function StepHeader({
  step,
  steps,
  onOpen,
  title,
  children,
}: {
  readonly step: SetupStep;
  readonly steps: SetupView['steps'];
  readonly onOpen: (step: SetupStep) => void;
  readonly title: string;
  readonly children?: ReactNode;
}): ReactNode {
  const shown = shownSteps(steps);
  // A step that this Verifold does not report, opened by its address, counts among all steps.
  const list = shown.includes(step) ? shown : setupSteps;
  const index = list.indexOf(step);
  return (
    <div className="step">
      <span className="step__label">
        Step {index + 1} of {list.length}: {stepNames[step]}
      </span>
      <nav aria-label="Setup steps" className="step__bar">
        {list.map((name) => {
          const state = stateNames[steps[name] ?? 'none'];
          return (
            <a
              key={name}
              href={href.setup(name)}
              className="step__link"
              aria-label={`${stepNames[name]}, ${state}`}
              aria-current={name === step ? 'step' : undefined}
              title={`${stepNames[name]}: ${state}`}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                )
                  return;
                event.preventDefault();
                onOpen(name);
              }}
            >
              <span
                className={`step__segment${state === 'not yet' ? '' : ` step__segment--${state}`}`}
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

/** Back: opens the step before. It saves and skips nothing. */
export function BackButton({
  onBack,
}: {
  readonly onBack: () => void;
}): ReactNode {
  return (
    <button type="button" className="button button--big" onClick={onBack}>
      Back
    </button>
  );
}

/**
 * Tells the setup page whether the step holds input that is not saved, so
 * Back and the step bar ask before they drop it. A step that closes holds
 * none.
 */
export function useUnsaved(
  unsaved: boolean,
  onUnsaved: (unsaved: boolean) => void,
): void {
  useEffect(() => {
    onUnsaved(unsaved);
  }, [unsaved, onUnsaved]);
  useEffect(() => () => onUnsaved(false), [onUnsaved]);
}
