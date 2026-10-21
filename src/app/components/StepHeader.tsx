import type { ReactNode } from 'react';
import type { SetupStep } from '../../protocol/api.ts';
import { setupSteps } from '../setup.ts';

const stepNames: Readonly<Record<SetupStep, string>> = {
  agents: 'Agents',
  about: 'About you',
  skills: 'Skills (optional)',
  money: 'GPU money',
};

/** "Step 2 of 4: About you", a bar with one segment for each step, the title, and a lead line. */
export function StepHeader({
  step,
  title,
  children,
}: {
  readonly step: SetupStep;
  readonly title: string;
  readonly children?: ReactNode;
}): ReactNode {
  const index = setupSteps.indexOf(step);
  return (
    <div className="step">
      <span className="step__label">
        Step {index + 1} of {setupSteps.length}: {stepNames[step]}
      </span>
      <div className="step__bar" aria-hidden="true">
        {setupSteps.map((name, at) => (
          <div
            key={name}
            className={`step__segment${at <= index ? ' step__segment--done' : ''}`}
          />
        ))}
      </div>
      <h1 className="step__title">{title}</h1>
      {children && <p className="step__lead">{children}</p>}
    </div>
  );
}
