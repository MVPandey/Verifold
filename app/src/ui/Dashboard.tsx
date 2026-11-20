import { useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import type { Api } from '../api/client.ts';
import type { AgentView, DashboardMeta, HeadlineView, LabView } from '../api/types.ts';
import {
  FRAME_PATH,
  FRAME_SANDBOX,
  bylineParts,
  headlineMark,
  namedLine,
  sendPage,
  statusLine,
} from '../model/dashboard.ts';
import type { Mark } from '../model/dashboard.ts';
import { href } from '../model/route.ts';
import { Refusal, usePress } from './Allowances.tsx';
import { useDashboard } from './hooks.ts';

/** The tabs of the lab page: the wall of threads, and the agents' dashboard. */
export type LabTab = 'wall' | 'dashboard';

/**
 * The status line of the lab page: the headline number with its age and the board's mark, the actions of each
 * allowance in force with how much of it is used, the share of the budget that is spent, and the press that pauses
 * every action while an allowance is in force. It shows only the parts that exist, and a lab with none of them has
 * no status line.
 */
export function StatusBar(props: {
  readonly api: Api;
  readonly lab: LabView;
  readonly now: Date;
  readonly reload: () => void;
}): ReactElement | null {
  const { api, lab } = props;
  const press = usePress();
  const line = statusLine(lab, lab.agents, props.now);
  if (line === null) return null;
  const paused = lab.actions_paused ?? null;
  return (
    <section className="d-status" aria-label="Where the lab stands">
      {line.stats.map((stat) => (
        <div key={stat.key} className={`d-stat d-${stat.key === 'headline' ? 'headline' : 'part'}`}>
          <b>{stat.value}</b>
          <small>
            {stat.words}
            {stat.mark ? (
              <>
                {' · '}
                <MarkView mark={stat.mark} plain />
              </>
            ) : null}
          </small>
        </div>
      ))}
      {line.pause ? (
        <div className="d-stat d-act">
          <button
            type="button"
            className={paused === null ? 'btn a-pause' : 'btn'}
            disabled={press.busy}
            onClick={() => {
              press.run(() => api.pauseActions(paused === null).then(props.reload));
            }}
          >
            {paused === null ? 'Pause all actions' : 'Let actions go on'}
          </button>
          <Refusal error={press.error} />
        </div>
      ) : null}
    </section>
  );
}

function MarkView(props: { readonly mark: Mark; readonly plain?: boolean }): ReactElement {
  const { mark } = props;
  return (
    <span className={`d-mark ${mark.tone}${props.plain ? ' plain' : ''}`}>
      {props.plain ? mark.text : `${mark.text.charAt(0).toUpperCase()}${mark.text.slice(1)}`}
    </span>
  );
}

/** The tabs of the lab page, as links, so that each tab has its own address. */
export function LabTabs(props: { readonly tab: LabTab }): ReactElement {
  const tabs: readonly (readonly [LabTab, string, string])[] = [
    ['wall', 'Wall', href({ page: 'lab' })],
    ['dashboard', 'Dashboard', href({ page: 'dashboard' })],
  ];
  return (
    <nav className="d-tabs" aria-label="The lab">
      {tabs.map(([tab, label, link]) => (
        <a
          key={tab}
          href={link}
          className={props.tab === tab ? 'on' : undefined}
          aria-current={props.tab === tab ? 'page' : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

/**
 * The Dashboard tab: the board's line about the agents' page, outside the page and in the app's style, then the
 * page in a sealed frame, and the control with which the person names the headline number.
 */
export function DashboardTab(props: {
  readonly api: Api;
  readonly lab: LabView;
  readonly now: Date;
  readonly reload: () => void;
}): ReactElement {
  const { api, lab, now } = props;
  const meta = lab.dashboard ?? null;
  const read = useDashboard(api, meta?.post ?? null);
  const page = read.page && meta && read.page.meta.post === meta.post ? read.page : null;
  return (
    <div className="d-board">
      {meta ? (
        <>
          <Byline
            meta={meta}
            headline={lab.headline_number ?? null}
            agents={lab.agents}
            now={now}
          />
          {page ? (
            <AgentPage key={page.meta.post} html={page.html} />
          ) : (
            <p className="f-wait" role="status">
              {read.error ?? 'Loading the dashboard.'}
            </p>
          )}
        </>
      ) : (
        <p className="d-empty">
          No agent has made a dashboard yet. One agent of the lab makes it as a page of its own, and
          it shows here.
        </p>
      )}
      <HeadlineChoice api={api} lab={lab} now={now} reload={props.reload} />
    </div>
  );
}

/** The board's own line above the agents' page: who made it, how old it is, whose numbers they are, and the headline. */
export function Byline(props: {
  readonly meta: DashboardMeta;
  readonly headline: HeadlineView | null;
  readonly agents: readonly AgentView[];
  readonly now: Date;
}): ReactElement {
  const { meta, agents } = props;
  const mark = headlineMark(props.headline, agents);
  const versions = meta.versions > 1 ? `${String(meta.versions)} versions` : '1 version';
  return (
    <div className="d-byline">
      {bylineParts(meta, agents, props.now).map((part) => (
        <span key={part}>{part}</span>
      ))}
      <a href={href({ page: 'thread', id: meta.thread, post: meta.post })}>{versions}</a>
      {meta.standing === 'disputed' ? <span className="d-mark bad">Disputed</span> : null}
      {mark ? (
        <span className="d-byline-mark">
          <MarkView mark={mark} />
        </span>
      ) : null}
    </div>
  );
}

/**
 * The agents' page, in a frame that is sealed from the app. The frame loads the frame's own page from this server,
 * which holds nothing of the lab, and the app posts the agents' page into it once it has loaded. No address of the
 * frame holds the page or the person's token, and the app reads no message from the frame.
 */
export function AgentPage(props: { readonly html: string }): ReactElement {
  return (
    <iframe
      className="d-frame"
      title="The agents' dashboard"
      src={FRAME_PATH}
      sandbox={FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      onLoad={(event) => {
        sendPage(event.currentTarget.contentWindow, props.html);
      }}
    />
  );
}

/** The person's control for the headline number: the label that stands, who named it, and a field to name another. */
function HeadlineChoice(props: {
  readonly api: Api;
  readonly lab: LabView;
  readonly now: Date;
  readonly reload: () => void;
}): ReactElement {
  const { api, lab } = props;
  const headline = lab.headline_number ?? null;
  const labels = lab.measure_labels ?? [];
  const [label, setLabel] = useState('');
  const press = usePress();
  const field = useId();
  const choices = useId();
  const name = (text: string): void => {
    press.run(() =>
      api.nameHeadline(text).then(() => {
        setLabel('');
        props.reload();
      }),
    );
  };
  return (
    <section className="d-choice" aria-label="The headline number">
      <h3>The headline number</h3>
      <p>
        {headline
          ? `The status line shows the newest measure labeled “${headline.label}”. ${namedLine(headline, lab.agents, props.now)}`
          : 'Name the label of the number that the status line shows first. The newest measure with that label is its value.'}
      </p>
      <form
        className="d-choice-row"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (label.trim()) name(label.trim());
        }}
      >
        <label htmlFor={field}>Label</label>
        <input
          id={field}
          list={choices}
          value={label}
          maxLength={80}
          placeholder={labels[0] ?? 'Account value'}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
        />
        <datalist id={choices}>
          {labels.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
        <button type="submit" className="btn primary" disabled={press.busy || !label.trim()}>
          Name it
        </button>
        {headline ? (
          <button
            type="button"
            className="btn"
            disabled={press.busy}
            onClick={() => {
              name('');
            }}
          >
            Take it back
          </button>
        ) : null}
      </form>
      <Refusal error={press.error} />
    </section>
  );
}
