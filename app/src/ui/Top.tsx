import { useState } from 'react';
import type { ReactElement } from 'react';

import type { Api } from '../api/client.ts';
import { messageOf } from '../api/client.ts';
import type { AgentView, HarnessOption, LabView } from '../api/types.ts';
import {
  costLine,
  face,
  harnessTitle,
  labTotal,
  members,
  stateLine,
  workingLine,
} from '../model/agents.ts';
import { href } from '../model/route.ts';
import type { Route } from '../model/route.ts';
import { stopLine } from '../model/settings.ts';
import { clockLine, endLine, moreTime } from '../model/time.ts';
import { FaceView } from './parts.tsx';

/** What the top bar shows for a started lab. */
export interface TopLab {
  readonly lab: LabView;
  readonly harnesses: readonly HarnessOption[];
  readonly needs: number;
  readonly now: Date;
  readonly api: Api;
  readonly onChange: () => void;
}

/** The top bar: the wordmark, the project, the pages, and for a started lab its members and its clock. */
export function Top(props: {
  readonly folder: string;
  readonly route: Route;
  readonly open: TopLab | null;
}): ReactElement {
  const name = props.folder.split('/').filter(Boolean).pop() ?? props.folder;
  const { open, route } = props;
  const current = (on: boolean): 'page' | undefined => (on ? 'page' : undefined);
  return (
    <header className="f-top">
      <a className="f-brand" href={href({ page: 'lab' })}>
        verifold
      </a>
      <span>{open ? name : 'New lab'}</span>
      <nav className="f-nav" aria-label="Pages">
        {open ? (
          <>
            <a
              href={href({ page: 'lab' })}
              aria-current={current(route.page === 'lab' || route.page === 'thread')}
            >
              Lab
            </a>
            <a href={href({ page: 'needs' })} aria-current={current(route.page === 'needs')}>
              Needs you
              {open.needs > 0 ? <span className="count">{open.needs}</span> : null}
            </a>
          </>
        ) : null}
        <a href={href({ page: 'settings' })} aria-current={current(route.page === 'settings')}>
          Settings
        </a>
      </nav>
      {open ? (
        <>
          <span className="grow" />
          <Members lab={open.lab} harnesses={open.harnesses} now={open.now} />
          <details className="f-pop f-time" name="top">
            <summary>{clockLine(open.lab, open.now)}</summary>
            <TimePanel lab={open.lab} now={open.now} api={open.api} onChange={open.onChange} />
          </details>
        </>
      ) : null}
    </header>
  );
}

/** The member list: who is in the lab, what each does now, and what each has cost. */
function Members(props: {
  readonly lab: LabView;
  readonly harnesses: readonly HarnessOption[];
  readonly now: Date;
}): ReactElement {
  const { lab } = props;
  const reruns = lab.agents.filter((view) => view.agent.checks !== null);
  const first = reruns[0];
  const busy = lab.agents.some((view) => view.activity.state === 'working');
  const dot = lab.out_of_time ? 'stop' : busy ? 'live' : 'idle';
  const row = (view: AgentView): ReactElement => {
    const state = stateLine(view.activity, props.now);
    return (
      <>
        <p>
          <b>{view.agent.name}</b>
          {view.agent.role ? <span className="f-role">{view.agent.role}</span> : null}
          <span className="f-tag">{harnessTitle(props.harnesses, view.agent.harness)}</span>
        </p>
        <p className="f-status">
          <span className={`dot ${state.dot}`} /> {state.text}
        </p>
        <p className="f-where">{costLine(view)}</p>
      </>
    );
  };
  return (
    <details className="f-pop f-members" name="top">
      <summary className="f-live">
        <span className={`dot ${dot}`} /> {workingLine(lab.agents)}
        <u>
          <span className="closed">Who</span>
          <span className="opened">Hide</span>
        </u>
      </summary>
      <div className="f-panel">
        <ul>
          {members(lab.agents).map((view) => (
            <li key={view.agent.id}>
              <FaceView face={face(lab.agents, view.agent.id)} />
              <div>{row(view)}</div>
            </li>
          ))}
          {first ? (
            <li>
              <FaceView face={face(lab.agents, first.agent.id)} />
              <div>
                <p>
                  <b>{reruns.length === 1 ? '1 blind rerun' : `${reruns.length} blind reruns`}</b>
                </p>
                <p className="f-where">
                  Outside checkers on the other model family. Each leaves after one check.
                </p>
                <details className="f-each">
                  <summary>What each did and cost</summary>
                  <ul>
                    {reruns.map((view) => (
                      <li key={view.agent.id}>{row(view)}</li>
                    ))}
                  </ul>
                </details>
              </div>
            </li>
          ) : null}
        </ul>
        <p className="f-total">
          <span>
            {lab.posts} {lab.posts === 1 ? 'post' : 'posts'} in {lab.threads}{' '}
            {lab.threads === 1 ? 'thread' : 'threads'}
          </span>
          <span>
            Lab total <b>{labTotal(lab.agents)}</b>
          </span>
        </p>
      </div>
    </details>
  );
}

/** The lab's time: when it ends, more time, and the stop with its confirmation. */
function TimePanel(props: {
  readonly lab: LabView;
  readonly now: Date;
  readonly api: Api;
  readonly onChange: () => void;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { lab } = props;

  const setTime = (minutes: number): void => {
    setError(null);
    props.api.setTime(minutes).then(
      () => {
        setConfirming(false);
        props.onChange();
      },
      (failure: unknown) => {
        setError(messageOf(failure));
      },
    );
  };

  return (
    <div className="f-panel timebox">
      <p>{endLine(lab, props.now)}</p>
      <div className="timeacts">
        {lab.ends_at !== null ? (
          <>
            <button
              className="btn small"
              type="button"
              onClick={() => setTime(moreTime(lab, 30, new Date()))}
            >
              30 more min
            </button>
            <button
              className="btn small"
              type="button"
              onClick={() => setTime(moreTime(lab, 60, new Date()))}
            >
              1 more hour
            </button>
          </>
        ) : null}
        {lab.out_of_time ? null : confirming ? (
          <button className="btn small danger" type="button" onClick={() => setTime(0)}>
            Stop every agent now
          </button>
        ) : (
          <button className="linkbtn" type="button" onClick={() => setConfirming(true)}>
            Stop the lab
          </button>
        )}
      </div>
      {confirming && !lab.out_of_time ? (
        <p className="quiet stopline">
          {stopLine(lab.settings)} <a href={href({ page: 'settings' })}>Change this</a>
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
