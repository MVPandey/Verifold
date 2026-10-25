import { useEffect, useRef, type ReactNode } from 'react';
import type {
  SetupStep,
  SetupView,
  SkillCard,
  SkillRuns,
} from '../../protocol/api.ts';
import { StatusBar } from '../components/StatusBar.tsx';
import { BackButton, StepHeader } from '../components/StepHeader.tsx';
import { newKey } from '../intent.ts';
import { href } from '../route.ts';
import type { SetupActions } from '../setup.ts';
import { useAction } from '../useAction.ts';
import { dayClock } from '../format.ts';

/** "A", "A and B", "A, B and C". */
function list(items: readonly string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** What a skill can run, in one line, as Verifold found it in its files. */
export function runsLine(runs: SkillRuns): string {
  const parts = [
    runs.scripts.length
      ? `Can run ${list(
          runs.scripts.map(
            (script) =>
              `${script.language} scripts (${script.files} ${script.files === 1 ? 'file' : 'files'})`,
          ),
        )}.`
      : 'Has no scripts.',
  ];
  if (runs.executables)
    parts.push(
      `${runs.executables} ${runs.executables === 1 ? 'file is' : 'files are'} executable.`,
    );
  if (runs.installs.length)
    parts.push(`Its files name ${list(runs.installs)}.`);
  if (runs.hosts.length)
    parts.push(`Web hosts in its files: ${runs.hosts.join(', ')}.`);
  parts.push('No hooks.');
  return parts.join(' ');
}

/** "9 Oct 2026": the date when a skill's folder last changed. */
function day(at: string): string {
  return new Date(at).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function SkillRow({
  card,
  busy,
  onAdd,
  onRemove,
}: {
  readonly card: SkillCard;
  readonly busy: boolean;
  readonly onAdd: () => void;
  readonly onRemove: () => void;
}): ReactNode {
  const added = card.state === 'added';
  return (
    <article className="skill">
      <div className="skill__body">
        <b className="skill__name">{card.name}</b>
        <span>{card.what}</span>
        <span className="skill__source">
          {/* The link opens the skill's own folder at the pinned commit. */}
          <a
            href={`https://github.com/${card.repo}/tree/${card.commit}/${card.path}`}
            title={card.path}
            target="_blank"
            rel="noreferrer"
          >
            {card.repo} @ {card.commit.slice(0, 7)}
          </a>
          {` · updated${card.updated ? ` ${day(card.updated)}` : ': not read'}`}
        </span>
        <span className="skill__runs">
          {runsLine(card.runs)}
          {card.license ? ` License: ${card.license}.` : ''}
        </span>
      </div>
      <button
        type="button"
        className="skill__add"
        aria-pressed={added}
        title={added ? 'Remove this skill' : undefined}
        disabled={busy}
        onClick={added ? onRemove : onAdd}
      >
        {added ? 'Added' : card.state === 'update' ? 'Update' : 'Add'}
      </button>
    </article>
  );
}

/**
 * Step 3, as in the artboard "3 Skills": up to three skills from public
 * catalogs that fit the profile, each pinned to a commit, with what it can
 * run. Nothing installs until the person adds it.
 */
export function SkillsStep({
  view,
  actions,
  refresh,
  onDone,
  onBack,
  onOpen,
}: {
  readonly view: SetupView;
  readonly actions: SetupActions;
  readonly refresh: () => void;
  readonly onDone: () => void;
  readonly onBack: () => void;
  readonly onOpen: (step: SetupStep) => void;
}): ReactNode {
  const skills = view.skills;
  const search = useAction((_: null, key) => actions.skillsSearch(key));
  const add = useAction((id: string, key) => actions.skillAdd(id, key));
  const remove = useAction((id: string, key) => actions.skillRemove(id, key));
  const done = useAction((_: null, key) => actions.skillsDone(key));
  const skip = useAction((_: null, key) => actions.skip('skills', key));
  // With no search yet, the step searches once when it opens: for new skills
  // with a profile, and for updates of the added skills with or without one.
  const asked = useRef(false);
  useEffect(() => {
    if (
      asked.current ||
      !skills ||
      skills.search ||
      skills.busy ||
      (skills.needsProfile && !skills.added.length)
    )
      return;
    asked.current = true;
    void actions.skillsSearch(newKey()).then(refresh);
  }, [skills, actions, refresh]);
  const busy = Boolean(skills?.busy) || add.busy || remove.busy;
  const error =
    skills?.problem ??
    search.error ??
    add.error ??
    remove.error ??
    done.error ??
    skip.error;
  const read = skills?.search;
  const readable = read?.catalogs.filter((catalog) => catalog.commit) ?? [];
  const missing = read?.catalogs.filter((catalog) => !catalog.commit) ?? [];
  const shown = new Set(skills?.cards.map((card) => card.id));
  const others = skills?.added.filter((entry) => !shown.has(entry.id)) ?? [];
  const act = (run: Promise<boolean>): void => {
    void run.then(refresh);
  };
  return (
    <>
      <StepHeader
        step="skills"
        steps={view.steps}
        onOpen={onOpen}
        title="Skills that fit your work"
      >
        {read
          ? `Verifold read ${readable.length} skill ${readable.length === 1 ? 'catalog' : 'catalogs'} ${dayClock(read.at)} ${
              skills?.needsProfile
                ? 'to check your added skills for updates.'
                : `and matched them to your profile. ${
                    read.picker
                      ? `${read.picker === 'claude' ? 'Claude Code' : 'Codex'} picked these from the best matches.`
                      : 'These match it best.'
                  }`
            }`
          : 'Verifold searches public skill catalogs for skills that fit your profile.'}
      </StepHeader>
      {!skills ? (
        <p className="setup__note">
          This Verifold has no Skills step. Continue to the next step.
        </p>
      ) : skills.needsProfile ? (
        <p className="setup__line">
          Skills are matched to what you work on, so this step needs{' '}
          <a href={href.setup('about')}>About you</a> first.
        </p>
      ) : skills.busy === 'search' ? (
        <StatusBar tone="plan">
          Reading the skill catalogs on GitHub and matching them to your
          profile.
        </StatusBar>
      ) : read && !skills.cards.length ? (
        <p className="setup__line">
          No skill in these catalogs matches your profile closely enough.
        </p>
      ) : null}
      {skills && skills.cards.length > 0 && skills.busy !== 'search' && (
        <section aria-label="Suggested skills" className="skills">
          {skills.cards.map((card) => (
            <SkillRow
              key={card.id}
              card={card}
              busy={busy}
              onAdd={() => act(add.submit(card.id))}
              onRemove={() => act(remove.submit(card.id))}
            />
          ))}
        </section>
      )}
      {others.length > 0 && (
        <section aria-labelledby="added-skills" className="skills">
          <h2 id="added-skills" className="setup__subtitle">
            Added earlier
          </h2>
          <ul className="added">
            {others.map((entry) => (
              <li key={entry.id} className="added__item">
                <b>{entry.name}</b>
                <span className="skill__source">
                  {entry.repo} @ {entry.commit.slice(0, 7)}
                </span>
                <button
                  type="button"
                  className="link-button"
                  disabled={busy}
                  onClick={() => act(remove.submit(entry.id))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {missing.length > 0 && (
        <p className="setup__note">
          Not read this time:{' '}
          {missing
            .map(
              (catalog) =>
                `${catalog.repo} (${catalog.problem ?? 'no answer'})`,
            )
            .join('; ')}
        </p>
      )}
      <p className="setup__note">
        Nothing installs until you add it. An added skill is pinned to the
        version shown, and loads only for Verifold’s agents, not in your own
        Claude Code or Codex. Read what each one can run before you add it.
      </p>
      {error && (
        <span role="alert" className="setup__error">
          {error}{' '}
          {skills?.problem && !skills.busy && (
            <button
              type="button"
              className="link-button"
              onClick={() => act(search.submit(null))}
            >
              Try again
            </button>
          )}
        </span>
      )}
      <div className="setup__actions">
        <BackButton onBack={onBack} />
        <button
          type="button"
          className="button button--primary button--big"
          disabled={done.busy || busy}
          onClick={() =>
            // An older Verifold has no Skills step to finish.
            skills
              ? void done.submit(null).then((ok) => ok && onDone())
              : onDone()
          }
        >
          Continue
        </button>
        <button
          type="button"
          className="link-button"
          disabled={skip.busy}
          onClick={() =>
            // An older Verifold has no Skills step to skip.
            skills
              ? void skip.submit(null).then((ok) => ok && onDone())
              : onDone()
          }
        >
          Skip. Ask me later.
        </button>
        {read && !skills?.busy && (
          <button
            type="button"
            className="link-button link-button--quiet"
            onClick={() => act(search.submit(null))}
          >
            Search again
          </button>
        )}
      </div>
    </>
  );
}
