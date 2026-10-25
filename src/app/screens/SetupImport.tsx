import { useId, type ReactNode } from 'react';
import type { SetupImport } from '../../protocol/api.ts';
import { since } from '../format.ts';
import type { SetupActions } from '../setup.ts';
import { useAction } from '../useAction.ts';
import { harnessTitles } from './SetupOwnSkills.tsx';
import { list } from './SetupSkills.tsx';

/** The parts of the profile card, with their labels. */
export const cardFields = [
  { field: 'workOn', label: 'You work on' },
  { field: 'explore', label: 'To explore' },
  { field: 'talk', label: 'Talk to me' },
] as const;

/**
 * "Get information about me from my harnesses" on the About step: the
 * button, a line for each harness while they answer, then what they sent,
 * which the person accepts or discards.
 */
export function ImportPanel({
  state,
  actions,
  refresh,
}: {
  /** Undefined: an older Verifold without the import. */
  readonly state: SetupImport | undefined;
  readonly actions: SetupActions;
  readonly refresh: () => void;
}): ReactNode {
  const title = useId();
  const ask = useAction((_: null, key) => actions.importAsk(key));
  const accept = useAction((_: null, key) => actions.importAccept(key));
  const discard = useAction((_: null, key) => actions.importDiscard(key));
  if (!state) return null;
  const run =
    (action: { submit: (value: null) => Promise<boolean> }) => (): void =>
      void action.submit(null).then(refresh);
  const error = ask.error ?? accept.error ?? discard.error ?? state.error;
  const result = state.result;
  if (state.busy)
    return (
      <section aria-label="What your harnesses know" className="import">
        <div className="chat__busy import__busy" role="status">
          <span className="dot" aria-hidden="true" />
          {list(state.asking.map((harness) => harnessTitles[harness]))}{' '}
          {state.asking.length > 1 ? 'read' : 'reads'} what{' '}
          {state.asking.length > 1 ? 'they know' : 'it knows'} about you ·{' '}
          {since(state.busy, Date.now())}
        </div>
      </section>
    );
  if (!result)
    return (
      <section aria-label="What your harnesses know" className="import">
        <div>
          <button
            type="button"
            className="button button--outline"
            disabled={ask.busy}
            onClick={run(ask)}
          >
            Get information about me from my harnesses
          </button>
        </div>
        <p className="setup__note">
          Each harness reads its own memories, instructions and skills,
          read-only. It doesn’t read your past sessions. Nothing is saved until
          you accept.
        </p>
        {error && (
          <span role="alert" className="setup__error">
            {error}
          </span>
        )}
      </section>
    );
  const fits = result.skills.filter((skill) => skill.fits);
  const rest = result.skills.filter((skill) => !skill.fits);
  return (
    <section aria-labelledby={title} className="profile import">
      <h2 id={title} className="profile__title">
        What {list(result.from.map((harness) => harnessTitles[harness]))}{' '}
        {result.from.length > 1 ? 'know' : 'knows'} about you
      </h2>
      <dl className="profile__fields">
        {cardFields.map(({ field, label }) => (
          <div key={field} className="profile__field">
            <dt>{label}</dt>
            <dd>
              {result.card[field] || <span className="muted">Not known</span>}
            </dd>
          </div>
        ))}
      </dl>
      {result.skills.length > 0 && (
        <>
          <h3 className="setup__subtitle">Skills that fit your research</h3>
          {fits.length ? (
            <ul className="import__skills">
              {fits.map((skill) => (
                <li key={`${skill.harness}:${skill.id}`}>
                  <b>{skill.name}</b>{' '}
                  <span className="muted">
                    · {harnessTitles[skill.harness]}
                  </span>
                  {skill.when && (
                    <span className="import__when">{skill.when}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="setup__line">
              Your harnesses found no skill that fits your research.
            </p>
          )}
          {rest.length > 0 && (
            <details className="import__rest">
              <summary>Not for research: {rest.length}</summary>
              <ul className="import__skills">
                {rest.map((skill) => (
                  <li key={`${skill.harness}:${skill.id}`}>
                    {skill.name}{' '}
                    <span className="muted">
                      · {harnessTitles[skill.harness]}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <ul className="import__read">
        {[...result.read, ...result.problems].map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="profile__note">
        Accept makes this your draft card. You can still edit it before you save
        it.
        {result.skills.length > 0 &&
          ' It also sets Your skills: Yes for the skills that fit, with their notes, and No for the rest.'}
      </p>
      {error && (
        <span role="alert" className="setup__error">
          {error}
        </span>
      )}
      <div className="setup__row">
        <button
          type="button"
          className="button button--primary"
          disabled={accept.busy || discard.busy}
          onClick={run(accept)}
        >
          Accept
        </button>
        <button
          type="button"
          className="button button--outline"
          disabled={accept.busy || discard.busy}
          onClick={run(discard)}
        >
          Discard
        </button>
      </div>
    </section>
  );
}
