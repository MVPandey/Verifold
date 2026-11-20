import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';

import { ApiError, messageOf } from '../api/client.ts';
import type { Api } from '../api/client.ts';
import type {
  HarnessOption,
  SettingKey,
  SettingsFileView,
  SettingsLevel,
  SettingsView,
} from '../api/types.ts';
import { DEFAULT_DISK_GB, MAX_DISK_GB } from '../model/limits.ts';
import { defaultsLine } from '../model/setup.ts';
import {
  AT_EXIT,
  AT_TIME_LIMIT,
  DEFAULT_MINUTES,
  DEFAULT_TASK_MINUTES,
  MAX_BOARD_MINUTES,
  MAX_REVIEWER_SEATS,
  SEATS_FOLLOW,
  WHILE_YOU_DECIDE,
  labelOf,
  minutesWords,
  numberValue,
  valueAt,
} from '../model/settings.ts';
import type { Choice } from '../model/settings.ts';

const CHANGED =
  'The settings file changed since you opened this page. These are its new values. Make your change again.';

/** The person's settings, for this project and for all projects. A change saves at once. */
export function SettingsPage(props: {
  readonly api: Api;
  readonly labOpen: boolean;
  /** The harnesses that the setup offers, for their names. */
  readonly harnesses: readonly HarnessOption[];
  /** A setting changed. The app reads the lab and the setup again. */
  readonly onChanged: () => void;
}): ReactElement {
  const { api } = props;
  const [view, setView] = useState<SettingsView | null>(null);
  const [level, setLevel] = useState<SettingsLevel>('project');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then(setView, (failure: unknown) => setError(messageOf(failure)));
  }, [api]);

  const change = (key: SettingKey, value: string | number | null): void => {
    if (view === null) return;
    const revisions = {
      project: view.project.revision,
      all_projects: view.all_projects.revision,
    };
    setSaving(true);
    setError(null);
    api.changeSetting({ level, key, value, revisions }).then(
      (changed) => {
        setView(changed);
        setSaving(false);
        props.onChanged();
      },
      (failure: unknown) => {
        if (!(failure instanceof ApiError && failure.status === 409)) {
          setSaving(false);
          setError(messageOf(failure));
          return;
        }
        // A file changed since the page read it. The page shows the new values before the person chooses again.
        api.settings().then(
          (fresh) => {
            setView(fresh);
            setSaving(false);
            setError(CHANGED);
          },
          (reading: unknown) => {
            setSaving(false);
            setError(messageOf(reading));
          },
        );
      },
    );
  };

  return (
    <div className="narrow setup settings">
      <h1>Settings</h1>
      <div className="filters" role="group" aria-label="Which settings">
        <button
          type="button"
          aria-pressed={level === 'project'}
          onClick={() => setLevel('project')}
        >
          This project
        </button>
        <button type="button" aria-pressed={level === 'all'} onClick={() => setLevel('all')}>
          All projects
        </button>
      </div>
      {view ? (
        <SettingsForm
          view={view}
          level={level}
          labOpen={props.labOpen}
          harnesses={props.harnesses}
          disabled={saving}
          onChange={change}
        />
      ) : error ? null : (
        <p className="quiet">Loading the settings.</p>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The settings of one level. On a project's page, each setting can follow the one for all projects. */
export function SettingsForm(props: {
  readonly view: SettingsView;
  readonly level: SettingsLevel;
  readonly labOpen: boolean;
  readonly harnesses: readonly HarnessOption[];
  readonly disabled: boolean;
  readonly onChange: (key: SettingKey, value: string | number | null) => void;
}): ReactElement {
  const project = props.level === 'project';
  const file = project ? props.view.project : props.view.all_projects;
  const inherited = project ? props.view.all_projects.settings : null;
  // What this project adds up to, which a running lab follows once the person chooses it.
  const chosen = props.view.project.settings.jobs;
  const lab = props.view.lab?.jobs ?? null;
  const waits = props.view.project.settings.permissions.while_you_decide;
  const labWaits = props.view.lab?.permissions.while_you_decide ?? null;
  const own = (key: SettingKey): boolean =>
    !project && valueAt(props.view.project.values, key) !== undefined;
  return (
    <>
      <p className="sub">
        {project
          ? 'These settings apply to this project only, and win over the ones for all projects. They are in '
          : 'These settings apply to each project that has no setting of its own. They are in '}
        <code>{file.path}</code>.
        {props.labOpen ? ' A change applies to the running lab now, and to the labs after it.' : ''}
      </p>
      <Setting
        title="When the lab's time ends, or you stop the lab"
        detail="This is for the processes that agents start and leave running, such as a script in the background."
        choices={AT_TIME_LIMIT}
        written={valueAt(file.values, 'jobs.at_time_limit')}
        current={file.settings.jobs.at_time_limit}
        inherited={inherited?.jobs.at_time_limit ?? null}
        projectOwn={own('jobs.at_time_limit') ? chosen.at_time_limit : null}
        lab={
          lab && lab.at_time_limit !== chosen.at_time_limit && !own('jobs.at_time_limit')
            ? lab.at_time_limit
            : null
        }
        disabled={props.disabled}
        onChange={(value) => props.onChange('jobs.at_time_limit', value)}
      />
      <Setting
        title="When Verifold exits"
        detail="This is for the same processes, when you stop Verifold or close its terminal."
        choices={AT_EXIT}
        written={valueAt(file.values, 'jobs.at_exit')}
        current={file.settings.jobs.at_exit}
        inherited={inherited?.jobs.at_exit ?? null}
        projectOwn={own('jobs.at_exit') ? chosen.at_exit : null}
        lab={lab && lab.at_exit !== chosen.at_exit && !own('jobs.at_exit') ? lab.at_exit : null}
        disabled={props.disabled}
        onChange={(value) => props.onChange('jobs.at_exit', value)}
      />
      <Setting
        title="When an agent needs a permission from you"
        detail="The request shows in Needs you, with the answers that the agent's harness offers. This is for the time until you answer."
        choices={WHILE_YOU_DECIDE}
        written={valueAt(file.values, 'permissions.while_you_decide')}
        current={file.settings.permissions.while_you_decide}
        inherited={inherited?.permissions.while_you_decide ?? null}
        projectOwn={own('permissions.while_you_decide') ? waits : null}
        lab={
          labWaits && labWaits !== waits && !own('permissions.while_you_decide') ? labWaits : null
        }
        disabled={props.disabled}
        onChange={(value) => props.onChange('permissions.while_you_decide', value)}
      />
      {[
        { field: SEATS, current: file.settings.reviewers.seats },
        { field: REVEAL, current: file.settings.votes.reveal_minutes },
        { field: LEASE, current: file.settings.reruns.lease_minutes },
        { field: TASK_LEASE, current: file.settings.tasks?.lease_minutes ?? DEFAULT_TASK_MINUTES },
        { field: DISK, current: file.settings.disk.limit_gb },
      ].map(({ field, current }) => (
        <NumberSetting
          // The field starts again from the file after each save.
          key={`${props.level}:${file.revision}:${field.key}`}
          field={field}
          file={file}
          current={current}
          project={project}
          projectOwn={own(field.key)}
          disabled={props.disabled}
          onChange={(value) => props.onChange(field.key, value)}
        />
      ))}
      <NewLabs
        file={file}
        project={project}
        projectOwn={!project && valueAt(props.view.project.values, 'setup') !== undefined}
        harnesses={props.harnesses}
        disabled={props.disabled}
        onRemove={() => props.onChange('setup', null)}
      />
    </>
  );
}

/** What the page says about one setting that takes a whole number, and the number's limits. */
interface NumberField {
  readonly key:
    | 'reviewers.seats'
    | 'votes.reveal_minutes'
    | 'reruns.lease_minutes'
    | 'tasks.lease_minutes'
    | 'disk.limit_gb';
  readonly title: string;
  readonly detail: string;
  readonly label: string;
  readonly max: number;
  /** The smallest number that the setting takes. Zero when absent. */
  readonly min?: number;
  /** The empty field's placeholder on the page for all projects. */
  readonly empty: string;
  /** The number that a level adds up to, in words. */
  readonly words: (value: number | null) => string;
  /** What `verifold run` does with a project's number, after its name, or `null` when it takes it. */
  readonly run: string | null;
}

const SEATS: NumberField = {
  key: 'reviewers.seats',
  title: 'Reviewer seats',
  detail: `How many agents can hold a reviewer seat. Leave the field empty, and the number follows the lab’s size: ${SEATS_FOLLOW}.`,
  label: 'Seats',
  max: MAX_REVIEWER_SEATS,
  empty: 'Follows the lab’s size',
  words: (seats) => {
    if (seats === null) return 'the number follows the lab’s size';
    return seats === 1 ? '1 seat' : `${seats} seats`;
  },
  run: 'does not take a higher number from this project’s file.',
};

const REVEAL: NumberField = {
  key: 'votes.reveal_minutes',
  title: 'Votes on a new post',
  detail: `For these minutes after a post was written, the board shows an agent no votes on it until it votes on it itself, so that its vote is its own judgement. Until then an agent cannot take its vote back. The author of the post and you see every vote at once. A change holds for the posts after it. Leave the field empty, and the time is ${DEFAULT_MINUTES} minutes. With 0, every agent sees every vote at once.`,
  label: 'Minutes',
  max: MAX_BOARD_MINUTES,
  empty: `${DEFAULT_MINUTES} minutes`,
  words: (minutes) => minutesWords(minutes ?? DEFAULT_MINUTES),
  run: 'does not take this number from this project’s file.',
};

const LEASE: NumberField = {
  key: 'reruns.lease_minutes',
  title: 'A rerun that an agent takes',
  detail: `For these minutes, the agent that takes a wanted rerun holds it, and no other agent can take it. An agent of another model family than the post can, while no holder is of another family. The holder’s next take starts the time again. The time ends early when the holder posts its check, gives the rerun up, or leaves the lab, and when another check settles the rerun. A change holds for the takes after it. Leave the field empty, and the time is ${DEFAULT_MINUTES} minutes. With 0, several agents can take one rerun at once.`,
  label: 'Minutes',
  max: MAX_BOARD_MINUTES,
  empty: `${DEFAULT_MINUTES} minutes`,
  words: (minutes) => minutesWords(minutes ?? DEFAULT_MINUTES),
  run: 'does not take this number from this project’s file.',
};

const TASK_LEASE: NumberField = {
  key: 'tasks.lease_minutes',
  title: 'A piece of work that an agent takes',
  detail: `For these minutes, the agent that takes a piece of work that another agent handed out holds it, and no other agent can take it. Each post of the holder on that work starts the time again. The time ends early when the holder hands the work back or gives it up, when the agent that handed it out withdraws it, and when the holder leaves the lab. When the time ends, any agent can take the work. A change holds for the takes and posts after it. Leave the field empty, and the time is ${DEFAULT_TASK_MINUTES} minutes.`,
  label: 'Minutes',
  max: MAX_BOARD_MINUTES,
  min: 1,
  empty: `${DEFAULT_TASK_MINUTES} minutes`,
  words: (minutes) => minutesWords(minutes ?? DEFAULT_TASK_MINUTES),
  run: 'does not take this number from this project’s file.',
};

const DISK: NumberField = {
  key: 'disk.limit_gb',
  title: 'Disk limit',
  detail: `The most gigabytes that the agents’ folders, the clean copies for reruns, and the snapshots may take together. Verifold measures them at the end of a turn, about once a minute at most. At the limit the agents stop, as at the time limit, until you raise it. Leave the field empty, and the limit is ${DEFAULT_DISK_GB} GB. With 0, the lab has no disk limit.`,
  label: 'Gigabytes',
  max: MAX_DISK_GB,
  empty: `${DEFAULT_DISK_GB} GB`,
  words: (gigabytes) => {
    const limit = gigabytes ?? DEFAULT_DISK_GB;
    return limit === 0 ? 'no disk limit' : `${limit} GB`;
  },
  run: 'takes only a lower limit from this project’s file.',
};

/**
 * A setting that takes a whole number, or an empty field. An empty field removes the number from this level's
 * file, so the level above applies, and without any number Verifold's default applies.
 */
function NumberSetting(props: {
  readonly field: NumberField;
  readonly file: SettingsFileView;
  /** The number that this level adds up to. */
  readonly current: number | null;
  readonly project: boolean;
  /** On the page for all projects: this project's file has a number of its own, which wins. */
  readonly projectOwn: boolean;
  readonly disabled: boolean;
  readonly onChange: (value: number | null) => void;
}): ReactElement {
  const { field } = props;
  const written = valueAt(props.file.values, field.key);
  const [text, setText] = useState(typeof written === 'number' ? String(written) : '');
  const id = useId();
  const value = numberValue(text, field.max, field.min);
  const same = value === (typeof written === 'number' ? written : null);
  return (
    <section className="section">
      <h3>{field.title}</h3>
      <p className="sub">{field.detail}</p>
      <div className="seats">
        <label htmlFor={id}>{field.label}</label>
        <input
          id={id}
          type="number"
          min={field.min ?? 0}
          max={field.max}
          value={text}
          placeholder={props.project ? 'Same as all projects' : field.empty}
          disabled={props.disabled}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <button
          className="btn small"
          type="button"
          disabled={props.disabled || value === undefined || same}
          onClick={() => {
            if (value !== undefined) props.onChange(value);
          }}
        >
          Save
        </button>
      </div>
      {value === undefined ? (
        <p className="note">
          Type a whole number from {field.min ?? 0} to {field.max}.
        </p>
      ) : null}
      <p className="note">
        {props.project && written === undefined ? 'Same as all projects. ' : ''}Now:{' '}
        {field.words(props.current)}.
      </p>
      {props.project && field.run ? (
        <p className="note">
          <code>verifold run</code> {field.run}
        </p>
      ) : null}
      {props.projectOwn ? (
        <p className="note">This project has its own number, and it wins over this one.</p>
      ) : null}
    </section>
  );
}

/** What new labs start with at this level. The person saves other choices from the setup screen. */
function NewLabs(props: {
  readonly file: SettingsFileView;
  readonly project: boolean;
  /** On the page for all projects: this project has saved choices of its own, which win. */
  readonly projectOwn: boolean;
  readonly harnesses: readonly HarnessOption[];
  readonly disabled: boolean;
  readonly onRemove: () => void;
}): ReactElement {
  const own = valueAt(props.file.values, 'setup') !== undefined;
  return (
    <section className="section">
      <h3>New labs</h3>
      <p className="sub">
        {props.project && !own ? 'Same as all projects: ' : ''}
        {defaultsLine(props.file.defaults, props.harnesses)}
      </p>
      {own ? (
        <button
          className="linkbtn"
          type="button"
          disabled={props.disabled}
          onClick={props.onRemove}
        >
          {props.project ? 'Use the choices for all projects' : "Use Verifold's defaults"}
        </button>
      ) : null}
      {props.projectOwn ? (
        <p className="note">This project has saved choices of its own, and they win over these.</p>
      ) : null}
      <p className="note">
        To save other choices, set up a lab and choose “Save these choices for the next labs”.
      </p>
    </section>
  );
}

/**
 * One setting and its answers.
 *
 * `inherited` is the value for all projects, on a project's page only. There, the setting can follow it, and an
 * answer counts as chosen only when the project's file holds it. `projectOwn` is this project's own value, on the
 * page for all projects, because it wins there. `lab` is what the running lab follows when that differs from the
 * files, for example after an edit by hand, and only where an answer on this page can change it.
 */
function Setting<T extends string>(props: {
  readonly title: string;
  readonly detail: string;
  readonly choices: readonly Choice<T>[];
  readonly written: unknown;
  readonly current: T;
  readonly inherited: T | null;
  readonly projectOwn: T | null;
  readonly lab: T | null;
  readonly disabled: boolean;
  readonly onChange: (value: T | null) => void;
}): ReactElement {
  const { inherited } = props;
  return (
    <section className="section">
      <h3>{props.title}</h3>
      <p className="sub">{props.detail}</p>
      <div className="choice">
        {inherited === null ? null : (
          <button
            type="button"
            aria-pressed={props.written === undefined}
            disabled={props.disabled}
            onClick={() => props.onChange(null)}
          >
            <b>Same as all projects</b>
            <span>Now: {labelOf(props.choices, inherited)}.</span>
          </button>
        )}
        {props.choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            aria-pressed={
              inherited === null ? props.current === choice.value : props.written === choice.value
            }
            disabled={props.disabled}
            onClick={() => props.onChange(choice.value)}
          >
            <b>{choice.label}</b>
            <span>{choice.detail}</span>
          </button>
        ))}
      </div>
      {props.projectOwn === null ? null : (
        <p className="note">
          This project has its own setting, “{labelOf(props.choices, props.projectOwn)}”, and it
          wins over this one.
        </p>
      )}
      {props.lab === null ? null : (
        <p className="note">
          The running lab still follows “{labelOf(props.choices, props.lab)}”. Choose an answer to
          change it.
        </p>
      )}
    </section>
  );
}
