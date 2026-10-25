import { useId, useState, type ReactNode } from 'react';
import type { Harness, OwnSkill } from '../../protocol/api.ts';
import { StatusBar } from '../components/StatusBar.tsx';
import type { SetupActions } from '../setup.ts';
import { useAction } from '../useAction.ts';

/** A description longer than this shows its first lines, with a button for the rest. */
const shortWhat = 160;
/** The most characters of a note on when to use a skill, as the server takes it. */
const whenLimit = 300;

type Choice = Parameters<SetupActions['ownSkills']>[0][number];

/** A group of skills: the person's skill folder, claude.ai, a plugin, or the computer's admin folder. */
interface Group {
  readonly key: string;
  readonly title: string;
  readonly skills: readonly OwnSkill[];
}

const harnessTitles: Readonly<Record<Harness, string>> = {
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

function OwnRow({
  skill,
  busy,
  onChoose,
}: {
  readonly skill: OwnSkill;
  readonly busy: boolean;
  readonly onChoose: (choice: Choice) => void;
}): ReactNode {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState(skill.when);
  // The note's box opens on a click, so a long list stays short.
  const [noting, setNoting] = useState(false);
  const long = skill.description.length > shortWhat;
  const save = (): void => {
    if (when.trim() !== skill.when)
      onChoose({
        harness: skill.harness,
        name: skill.name,
        use: true,
        when: when.trim(),
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
              disabled={busy}
              onClick={() =>
                skill.use !== use &&
                onChoose({ harness: skill.harness, name: skill.name, use })
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
              maxLength={whenLimit}
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
 * The person's skill folder opens at once; claude.ai and each plugin open
 * on a click, since a plugin can hold dozens of skills.
 */
export function OwnSkills({
  skills,
  reading,
  actions,
  refresh,
}: {
  readonly skills: readonly OwnSkill[];
  readonly reading: boolean;
  readonly actions: SetupActions;
  readonly refresh: () => void;
}): ReactNode {
  const choose = useAction((choices: readonly Choice[], key) =>
    actions.ownSkills(choices, key),
  );
  const onChoose = (choice: Choice): void => {
    void choose.submit([choice]).then(refresh);
  };
  return (
    <section aria-labelledby="own-skills" className="skills">
      <h2 id="own-skills" className="setup__subtitle">
        Your skills
      </h2>
      <p className="setup__line">
        Your own Claude Code and Codex already load these. Verifold’s agents
        load them too, unless you say No.
      </p>
      {reading ? (
        <StatusBar tone="plan">
          Listing the skills that your Claude Code and Codex load.
        </StatusBar>
      ) : !skills.length ? (
        <p className="setup__note">
          Your Claude Code and Codex load no skills of their own.
        </p>
      ) : (
        (['claude', 'codex'] as const).map((harness) => {
          const mine = skills.filter((skill) => skill.harness === harness);
          if (!mine.length) return null;
          return (
            <div key={harness} className="own-list">
              <h3 className="own-list__title">{harnessTitles[harness]}</h3>
              {groups(mine).map((group) => {
                const off = group.skills.filter((skill) => !skill.use).length;
                return (
                  <details
                    key={group.key}
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
                          key={`${skill.name}:${skill.when}`}
                          skill={skill}
                          busy={choose.busy}
                          onChoose={onChoose}
                        />
                      ))}
                    </ul>
                  </details>
                );
              })}
            </div>
          );
        })
      )}
      {choose.error && (
        <span role="alert" className="setup__error">
          {choose.error}
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
