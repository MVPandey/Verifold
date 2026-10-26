import { useId, useState, type ReactNode } from 'react';
import type { SetupImport } from '../../protocol/api.ts';

type ImportedSkill = NonNullable<SetupImport['result']>['skills'][number];
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

/** The parts of the card that the import fills. The person writes "To explore". */
const importFields = cardFields.filter(({ field }) => field !== 'explore');

/**
 * "Get information about me from my harnesses" on the About step: the
 * button, a line for each harness while they answer, then what they sent,
 * which the person accepts or discards.
 */
export function ImportPanel({
  state,
  actions,
  refresh,
  cardEdited,
}: {
  /** Undefined: an older Verifold without the import. */
  readonly state: SetupImport | undefined;
  readonly actions: SetupActions;
  readonly refresh: () => void;
  /** The card below has edits that are not saved, which Accept would replace. */
  readonly cardEdited: boolean;
}): ReactNode {
  const title = useId();
  const [allMemories, setAllMemories] = useState(false);
  const ask = useAction((all: boolean, key) => actions.importAsk(all, key));
  const accept = useAction((_: null, key) => actions.importAccept(key));
  const discard = useAction((_: null, key) => actions.importDiscard(key));
  if (!state) return null;
  const claude = state.claude === true;
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
          {state.asking.length
            ? `${list(state.asking.map((harness) => harnessTitles[harness]))} ${
                state.asking.length > 1
                  ? 'read what they know'
                  : 'reads what it knows'
              } about you`
            : 'Verifold finds your harnesses'}{' '}
          · {since(state.busy, Date.now())}
          <button
            type="button"
            className="link-button"
            disabled={discard.busy}
            onClick={run(discard)}
          >
            Stop
          </button>
        </div>
        {error && (
          <span role="alert" className="setup__error">
            {error}
          </span>
        )}
      </section>
    );
  if (!result)
    return (
      <section aria-label="What your harnesses know" className="import">
        {claude && (
          <label className="import__all">
            <input
              type="checkbox"
              checked={allMemories}
              onChange={(event) => setAllMemories(event.target.checked)}
            />
            Let Claude Code look through the memories of all your projects, not
            only the recent ones.
          </label>
        )}
        <div>
          <button
            type="button"
            className="button button--outline"
            disabled={ask.busy}
            onClick={() => void ask.submit(claude && allMemories).then(refresh)}
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
  /** The person's saved choice, which Accept keeps. */
  const chosen = (skill: ImportedSkill): ReactNode =>
    skill.chosen !== undefined && (
      <span className="import__chosen">
        {' '}
        · You chose {skill.chosen ? 'Yes' : 'No'}
      </span>
    );
  return (
    <section aria-labelledby={title} className="profile import">
      <h2 id={title} className="profile__title">
        What {list(result.from.map((harness) => harnessTitles[harness]))}{' '}
        {result.from.length > 1 ? 'know' : 'knows'} about you
      </h2>
      <dl className="profile__fields">
        {importFields.map(({ field, label }) => (
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
                  {chosen(skill)}
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
                    {chosen(skill)}
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
        Accept puts this in your draft card and keeps your “To explore” text.
        You can still edit the card before you save it.
        {result.skills.length > 0 &&
          ' It also sets the skills that you have not chosen yet: Yes, with the note, for each one that fits, and No for each one that does not.'}
      </p>
      {cardEdited && (
        <p className="setup__line">Save or undo your card edits first.</p>
      )}
      {error && (
        <span role="alert" className="setup__error">
          {error}
        </span>
      )}
      <div className="setup__row">
        <button
          type="button"
          className="button button--primary"
          disabled={accept.busy || discard.busy || cardEdited}
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
