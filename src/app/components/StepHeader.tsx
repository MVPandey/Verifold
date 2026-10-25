import type { ReactNode } from 'react';
import type { SetupStep } from '../../protocol/api.ts';
import { href } from '../route.ts';
import { setupSteps } from '../setup.ts';

const stepNames: Readonly<Record<SetupStep, string>> = {
  agents: 'Agents',
  about: 'About you',
  skills: 'Skills (optional)',
  money: 'GPU money',
};

/**
 * "Step 2 of 4: About you", a bar with one link for each step, the title,
 * and a lead line. Each link opens its step, so the person can go back and
 * forth.
 */
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
      <nav aria-label="Setup steps" className="step__bar">
        {setupSteps.map((name, at) => (
          <a
            key={name}
            href={href.setup(name)}
            className="step__link"
            aria-label={stepNames[name]}
            aria-current={at === index ? 'step' : undefined}
            title={stepNames[name]}
          >
            <span
              className={`step__segment${at <= index ? ' step__segment--done' : ''}`}
            />
          </a>
        ))}
      </nav>
      <h1 className="step__title">{title}</h1>
      {children && <p className="step__lead">{children}</p>}
    </div>
  );
}
