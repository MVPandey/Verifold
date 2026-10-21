import { useState, type ReactNode } from 'react';
import type { Step, Text } from '../../protocol/api.ts';
import {
  commandLike,
  foldSteps,
  stepTook,
  stepVerb,
  stepWhat,
} from '../activity.ts';
import { clock } from '../format.ts';

/**
 * The steps of an open fold: the turn's newest tool calls, one line each,
 * then a link to the turn's page, which has every step and its output.
 * `total`: the turn's tool calls, from its counts, so the list says how
 * many came before the ones it shows.
 */
export function StepList({
  id,
  steps,
  total,
  turnHref,
}: {
  readonly id: string;
  readonly steps: readonly Step[];
  readonly total: number;
  readonly turnHref: string;
}): ReactNode {
  const shown = steps.filter((step) => step.type === 'tool').slice(-foldSteps);
  const earlier = Math.max(0, total - shown.length);
  return (
    <ol id={id} className="steps">
      {total === 0 && <li className="muted">No tool calls in this turn.</li>}
      {earlier > 0 && (
        <li className="muted">
          {earlier} earlier {earlier === 1 ? 'step' : 'steps'}
        </li>
      )}
      {shown.map((step) => (
        <li key={step.id} className="steps__item">
          <b className="steps__verb">{stepVerb(step)}</b>
          <span
            className={commandLike(step) ? 'steps__what mono' : 'steps__what'}
          >
            {stepWhat(step)}
          </span>
        </li>
      ))}
      <li>
        <a className="steps__all" href={turnHref}>
          Open every step
        </a>
      </li>
    </ol>
  );
}

/** A tool call's input or output as fixed-width text, with a line when the server cut it. */
function Block({
  label,
  value,
  end,
}: {
  readonly label: string;
  readonly value: Text;
  /** The text is the end of a longer one. */
  readonly end: boolean;
}): ReactNode {
  return (
    <div className="step-row__block">
      <span className="step-row__label">
        {label}
        {value.trimmed && (end ? ', the last lines' : ', the first lines')}
      </span>
      <pre className="log">{value.text}</pre>
    </div>
  );
}

/**
 * One step of a turn, on the turn's page. A command shows the end of its
 * output at once, as a log. Any other step with more to show opens it on a
 * button.
 */
export function StepRow({ step }: { readonly step: Step }): ReactNode {
  const [open, setOpen] = useState(false);
  const log =
    step.type === 'tool' && step.output !== null && commandLike(step)
      ? step.output
      : null;
  // Words show their first line in the row; the rest, if any, opens on the button.
  const words = step.text
    ? step.text.trimmed || step.text.text.trim() !== stepWhat(step)
    : false;
  const more = !log && (step.input !== null || step.output !== null || words);
  const took = stepTook(step);
  return (
    <li className={log ? 'step-row step-row--log' : 'step-row'}>
      <div className="step-row__line">
        <b className="step-row__verb">
          {step.status === 'running' && (
            <span className="dot step-row__dot" aria-hidden="true" />
          )}
          {stepVerb(step)}
        </b>
        <span
          className={
            commandLike(step) ? 'step-row__what mono' : 'step-row__what'
          }
        >
          {stepWhat(step)}
          {step.status === 'failed' && (
            <span className="tag tag--failed">failed</span>
          )}
        </span>
        <span className="step-row__time">
          {clock(step.at)}
          {took && ` · ${took}`}
        </span>
      </div>
      {log && (
        <div className="step-row__more">
          <Block label="Output" value={log} end />
        </div>
      )}
      {more && (
        <button
          type="button"
          className="step-row__toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide' : 'Show'}{' '}
          {step.type === 'tool' ? 'input and output' : 'the words'}
        </button>
      )}
      {more && open && (
        <div className="step-row__more">
          {step.input && <Block label="Input" value={step.input} end={false} />}
          {step.output && <Block label="Output" value={step.output} end />}
          {step.text && <p className="step-row__text">{step.text.text}</p>}
        </div>
      )}
    </li>
  );
}
