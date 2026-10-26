import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Harness, OwnSkill, SetupSkills } from '../../protocol/api.ts';
import { StatusBar } from '../components/StatusBar.tsx';
import { useUnsaved } from '../components/StepHeader.tsx';
import type { SetupActions, StepNav } from '../setup.ts';
import { useAction } from '../useAction.ts';

/** A description longer than this shows its first lines, with a button for the rest. */
const shortWhat = 160;

type Choice = Parameters<SetupActions['ownSkills']>[0][number];

/** A group of skills: the person's skill folder, claude.ai, a plugin, or the computer's admin folder. */
interface Group {
  readonly key: string;
  readonly title: string;
  readonly skills: readonly OwnSkill[];
}

export const harnessTitles: Readonly<Record<Harness, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/** The groups of one harness, in the order that the server lists them. */
function groups(skills: readonly OwnSkill[]): Group[] {
  const found = new Map<string, Group>();
  for (const skill of skills) {
    const plugin =
      skill.source === 'plugin' ? (skill.name.split(':')[0] ?? '') : '';
    const key = `${skill.source}:${plugin}`;
    const title =
      skill.source === 'personal'
        ? 'Your skill folder'
        : skill.source === 'synced'
          ? 'From claude.ai'
          : skill.source === 'admin'
            ? 'This computer’s skills'
            : `The ${plugin} plugin`;
    const group = found.get(key) ?? { key, title, skills: [] };
    found.set(key, { ...group, skills: [...group.skills, skill] });
  }
  return [...found.values()];
}

/** The name without the plugin or claude.ai prefix, which the group already names. */
function shortName(skill: OwnSkill): string {
  return skill.source === 'plugin' || skill.source === 'synced'
    ? skill.name.slice(skill.name.indexOf(':') + 1)
    : skill.name;
}

/**
 * Yes or No for every skill of a group, in one request. It sits beside the
 * group's summary, not in it, so a click never opens or closes the group.
 * A mixed group shows neither as pressed, and a screen reader hears
 * "mixed". A choice leaves each note as it is.
 */
export function GroupSwitch({
  group,
  busy,
  onChoose,
}: {
  readonly group: Group;
  readonly busy: boolean;
  readonly onChoose: (choices: readonly Choice[]) => void;
}): ReactNode {
  const on = group.skills.filter((skill) => skill.use).length;
  const mixed = on > 0 && on < group.skills.length;
  return (
    <div
      role="group"
      aria-label={`Verifold’s agents use all skills in the group “${group.title}”`}
      className="own__switch own-group__switch"
    >
      {[true, false].map((use) => {
        // Like a row's switch, a click sends only the skills that change.
        const changes = group.skills.filter((skill) => skill.use !== use);
        return (
          <button
            key={String(use)}
            type="button"
            className="own__choice"
            aria-pressed={mixed ? 'mixed' : !changes.length}
            disabled={busy}
            onClick={() =>
              changes.length > 0 &&
              onChoose(
                changes.map((skill) => ({
                  harness: skill.harness,
                  id: skill.id,
                  use,
                })),
              )
            }
          >
            {use ? 'Yes' : 'No'}
          </button>
        );
      })}
    </div>
  );
}

function OwnRow({
  skill,
  noteLimit,
  onChoose,
  onTyped,
}: {
  readonly skill: OwnSkill;
  readonly noteLimit: number;
  readonly onChoose: (choice: Choice) => void;
  /** The note in the box differs from the saved one, or no longer does. */
  readonly onTyped: (typed: boolean) => void;
}): ReactNode {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState(skill.when);
  // A note that changed elsewhere, such as from an import, shows in the box.
  useEffect(() => setWhen(skill.when), [skill.when]);
  // The note's box opens on a click, so a long list stays short.
  const [noting, setNoting] = useState(false);
  const long = skill.description.length > shortWhat;
  const note = when.trim() !== skill.when ? { when: when.trim() } : {};
  const typed = 'when' in note;
  useEffect(() => onTyped(typed), [typed, onTyped]);
  const save = (): void => {
    if ('when' in note)
      onChoose({
        harness: skill.harness,
        id: skill.id,
        use: true,
        ...note,
      });
    else if (!when.trim()) setNoting(false);
  };
  return (
    <li className="own">
      <div className="own__top">
        <div className="own__body">
          <b className="own__name" title={skill.name}>
            {shortName(skill)}
          </b>
          {skill.description && (
            <span
              id={`${id}-what`}
              className={`own__what${long && !open ? ' own__what--short' : ''}`}
            >
              {skill.description}
            </span>
          )}
          {long && (
            <button
              type="button"
              className="link-button own__more"
              aria-expanded={open}
              aria-controls={`${id}-what`}
              onClick={() => setOpen(!open)}
            >
              {open ? 'Less' : 'More'}
            </button>
          )}
        </div>
        {/* The switch stays on while a note saves, and a choice takes the note with it, so neither is lost. */}
        <div
          role="group"
          aria-label={`Verifold’s agents use ${shortName(skill)}`}
          className="own__switch"
        >
          {[true, false].map((use) => (
            <button
              key={String(use)}
              type="button"
              className="own__choice"
              aria-pressed={skill.use === use}
              onClick={() =>
                (skill.use !== use || 'when' in note) &&
                onChoose({
                  harness: skill.harness,
                  id: skill.id,
                  use,
                  ...note,
                })
              }
            >
              {use ? 'Yes' : 'No'}
            </button>
          ))}
        </div>
      </div>
      {skill.use &&
        (skill.when || noting ? (
          <>
            <label htmlFor={`${id}-when`} className="visually-hidden">
              When should agents use {shortName(skill)}?
            </label>
            <input
              id={`${id}-when`}
              className="own__when"
              maxLength={noteLimit}
              placeholder="When should agents use it?"
              // The box opens on the person's click, so it takes the typing at once.
              autoFocus={noting}
              value={when}
              onChange={(event) => setWhen(event.target.value)}
              onBlur={save}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </>
        ) : (
          <button
            type="button"
            className="link-button own__more"
            onClick={() => setNoting(true)}
          >
            Say when to use it
          </button>
        ))}
    </li>
  );
}

/**
 * The skills that the person's own Claude Code and Codex load, each with
 * Yes or No for Verifold's agents and an optional note on when to use it.
 * Each group also has Yes or No for all of its skills.
 * The person's skill folder opens at once; claude.ai and each plugin open
 * on a click, since a plugin can hold dozens of skills.
 */
export function OwnSkills({
  skills,
  actions,
  refresh,
  nav,
}: {
  readonly skills: SetupSkills;
  readonly actions: SetupActions;
  readonly refresh: () => void;
  readonly nav: StepNav;
}): ReactNode {
  // The rows with a note typed but not saved, so leaving the step asks first.
  const [typing, setTyping] = useState<ReadonlySet<string>>(new Set());
  useUnsaved(typing.size > 0, nav);
  const typed = useCallback((row: string, now: boolean): void => {
    setTyping((rows) => {
      if (rows.has(row) === now) return rows;
      const next = new Set(rows);
      if (now) next.add(row);
      else next.delete(row);
      return next;
    });
  }, []);
  const choose = useAction((choices: readonly Choice[], key) =>
    actions.ownSkills(choices, key),
  );
  const list = useAction((again: boolean, key) =>
    actions.ownSkillsList(again, key),
  );
  const save = (choices: readonly Choice[]): void => {
    void choose.submit(choices).then(refresh);
  };
  // Only this step lists the skills: when it opens, and when the person asks again.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void list.submit(false).then(refresh);
  }, [list, refresh]);
  const own = skills.own;
  const problems = skills.ownProblems ?? [];
  // Read again shows whenever no list runs, so a refused or lost request never leaves the step waiting.
  const reading = Boolean(skills.ownReading) || list.busy;
  const noteLimit = skills.noteLimit ?? 300;
  const error = choose.error ?? list.error;
  return (
    <section aria-labelledby="own-skills" className="skills">
      <div className="setup__heading">
        <h2 id="own-skills" className="setup__subtitle">
          Your skills
        </h2>
        {!reading && (
          <button
            type="button"
            className="link-button link-button--inline"
            disabled={list.busy}
            onClick={() => void list.submit(true).then(refresh)}
          >
            Read again
          </button>
        )}
      </div>
      <p className="setup__line">
        Your own Claude Code and Codex already load these. Verifold’s agents
        load them too, unless you say No.
      </p>
      {reading ? (
        <StatusBar tone="plan">
          Listing the skills that your Claude Code and Codex load.
        </StatusBar>
      ) : !own ? null : !own.length ? (
        <p className="setup__note">
          Your Claude Code and Codex load no skills of their own.
        </p>
      ) : (
        (['claude', 'codex'] as const).map((harness) => {
          const mine = own.filter((skill) => skill.harness === harness);
          if (!mine.length) return null;
          return (
            <div key={harness} className="own-list">
              <h3 className="own-list__title">{harnessTitles[harness]}</h3>
              {groups(mine).map((group) => {
                const off = group.skills.filter((skill) => !skill.use).length;
                // The switch comes first, so Tab reaches it before the rows of an open group.
                return (
                  <div key={group.key} className="own-group__box">
                    <GroupSwitch
                      group={group}
                      busy={choose.busy}
                      onChoose={save}
                    />
                    <details
                      className="own-group"
                      open={group.key.startsWith('personal:')}
                    >
                      <summary className="own-group__title">
                        {group.title}
                        <span className="setup__meta">
                          {` · ${group.skills.length} ${group.skills.length === 1 ? 'skill' : 'skills'}${off ? ` · ${off} off` : ''}`}
                        </span>
                      </summary>
                      <ul className="own-group__list">
                        {group.skills.map((skill) => (
                          <OwnRow
                            key={`${skill.harness}:${skill.id}`}
                            skill={skill}
                            noteLimit={noteLimit}
                            onChoose={(choice) => save([choice])}
                            onTyped={(now) =>
                              typed(`${skill.harness}:${skill.id}`, now)
                            }
                          />
                        ))}
                      </ul>
                    </details>
                  </div>
                );
              })}
            </div>
          );
        })
      )}
      {problems.map((line) => (
        <p key={line} className="setup__note">
          {line}
        </p>
      ))}
      {error && (
        <span role="alert" className="setup__error">
          {error}
        </span>
      )}
      <p className="setup__note">
        “No” turns a skill off only for Verifold’s agents. Your own Claude Code
        and Codex don’t change. Changes apply to agent sessions that start after
        this.
      </p>
    </section>
  );
}
