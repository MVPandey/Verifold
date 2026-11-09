import { useEffect, useState } from 'react';
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
import { defaultsLine } from '../model/setup.ts';
import { AT_EXIT, AT_TIME_LIMIT, labelOf, valueAt } from '../model/settings.ts';
import type { Choice } from '../model/settings.ts';

const CHANGED =
  'The settings file changed since you opened this page. These are its new values. Make your change again.';

/** The person's settings, for this project and for all projects. A change saves at once. */
export function SettingsPage(props: {
  readonly api: Api;
  readonly labOpen: boolean;
  /** The harnesses that the setup offers, for their names. */
  readonly harnesses: readonly HarnessOption[];
}): ReactElement {
  const { api } = props;
  const [view, setView] = useState<SettingsView | null>(null);
  const [level, setLevel] = useState<SettingsLevel>('project');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then(setView, (failure: unknown) => setError(messageOf(failure)));
  }, [api]);

  const change = (key: SettingKey, value: string | null): void => {
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
  readonly onChange: (key: SettingKey, value: string | null) => void;
}): ReactElement {
  const project = props.level === 'project';
  const file = project ? props.view.project : props.view.all_projects;
  const inherited = project ? props.view.all_projects.settings : null;
  // What this project adds up to, which a running lab follows once the person chooses it.
  const chosen = props.view.project.settings.jobs;
  const lab = props.view.lab?.jobs ?? null;
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
      <NewLabs
        file={file}
        project={project}
        harnesses={props.harnesses}
        disabled={props.disabled}
        onRemove={() => props.onChange('setup', null)}
      />
    </>
  );
}

/** What new labs start with at this level. The person saves other choices from the setup screen. */
function NewLabs(props: {
  readonly file: SettingsFileView;
  readonly project: boolean;
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
