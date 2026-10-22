import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Lab, Run, RunDetail, Snapshot } from '../../protocol/api.ts';
import { ControlsContext } from '../controls.ts';
import { harnessName } from '../format.ts';
import { href } from '../route.ts';
import {
  followRun,
  runActive,
  runState,
  runTimes,
  runWhere,
  size,
} from '../runs.ts';
import type { Connection } from '../store.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { Chevron } from '../components/Icons.tsx';
import type { LabActions } from './LabHome.tsx';

/**
 * A run on its own page: what ran and why, where and when, its metrics, the
 * files that Verifold kept from it, and the end of its log. The log is read
 * again every few seconds while the run waits or runs, and a read that
 * failed is tried again, less often each time. While the run waits or runs,
 * the person can cancel it. The snapshot's own copy of the run shows at
 * once, and the read adds the rest.
 */
export function RunPage({
  snapshot,
  lab,
  id,
  connection,
  now,
  actions,
}: {
  readonly snapshot: Snapshot;
  readonly lab: Lab;
  readonly id: string;
  readonly connection: Connection;
  readonly now: number;
  readonly actions: LabActions;
}): ReactNode {
  const controls = useContext(ControlsContext);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // The person cancelled the run, so its Cancel goes at once.
  const [cancelled, setCancelled] = useState(false);
  // A cancel reads the run again at once.
  const [round, setRound] = useState(0);
  const listed = lab.runs.find((entry) => entry.id === id);
  // A change of state in the snapshot, such as the end of the run, reads it once more.
  useEffect(() => {
    if (!controls) return;
    const controller = new AbortController();
    followRun(
      (signal) => controls.run(id, signal),
      (loaded) => {
        if ('error' in loaded) {
          setProblem(loaded.error);
          return;
        }
        setDetail(loaded.value);
        setProblem(null);
      },
      controller.signal,
    );
    return () => controller.abort();
  }, [controls, id, listed?.status, round]);
  const run = detail?.run ?? listed;
  const direction = run
    ? lab.directions.find((entry) => entry.id === run.direction)
    : undefined;
  return (
    <div className="page">
      <AppHeader
        project={snapshot.project}
        lab={lab}
        now={now}
        onPause={actions.pause}
      />
      <main className="main">
        <div className="column column--detail">
          <ConnectionBar connection={connection} at={snapshot.at} />
          <a
            className="back"
            href={direction ? href.run(direction.id, id) : href.lab}
          >
            <Chevron to="left" />
            {direction ? direction.title : 'The lab'}
          </a>
          <div className="direction-head">
            <h1 className="page-title">Run {id}</h1>
            {run && (
              <p className="direction-head__meta">
                <span
                  className={
                    runActive(run) ? 'run-state run-state--live' : 'run-state'
                  }
                >
                  {runActive(run) && (
                    <span className="dot" aria-hidden="true" />
                  )}
                  {runState(run, now)}
                </span>
              </p>
            )}
          </div>
          {!run && !problem && (
            <p className="turns__none">
              {controls
                ? 'Reading the run…'
                : 'This view of the lab leaves out this run.'}
            </p>
          )}
          {problem && (
            <p
              role={detail ? 'status' : 'alert'}
              className={detail ? 'steps__problem' : 'composer__error'}
            >
              {detail ? `Can't refresh this run: ${problem}` : problem}
            </p>
          )}
          {run && <RunFacts run={run} detail={detail} lab={lab} />}
          {run?.note && (
            <p role="status" className="run-note">
              {run.note}
            </p>
          )}
          {run && <Metrics run={run} />}
          {detail && <RunLog detail={detail} />}
          {detail && <Outputs detail={detail} />}
          {controls && detail?.cancelable && !cancelled && (
            <div className="run-actions">
              <ConfirmButton
                label="Cancel the run"
                confirm="Click again to cancel it"
                run={(key) => controls.cancelRun(id, key)}
                onDone={() => {
                  setCancelled(true);
                  setRound((count) => count + 1);
                }}
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function RunFacts({
  run,
  detail,
  lab,
}: {
  readonly run: Run;
  readonly detail: RunDetail | null;
  readonly lab: Lab;
}): ReactNode {
  const direction = lab.directions.find((entry) => entry.id === run.direction);
  const agent = lab.agents.find((entry) => entry.id === run.agent);
  const handle = detail?.handle ?? agent?.handle ?? run.agent;
  const harness = detail?.harness ?? agent?.harness;
  return (
    <dl className="run-facts">
      <dt>Command</dt>
      <dd>
        <code className="mono">{run.command}</code>
      </dd>
      <dt>Why</dt>
      <dd>{run.why}</dd>
      <dt>Commit</dt>
      <dd>
        <code className="mono">{run.commit.slice(0, 12)}</code>
      </dd>
      <dt>Where</dt>
      <dd>{runWhere(run)}</dd>
      <dt>Ran by</dt>
      <dd>
        {/* An agent that the snapshot leaves out has no page to link. */}
        {agent ? <a href={href.agent(run.agent)}>{handle}</a> : handle}
        {harness && ` · ${harnessName(harness)}`}
      </dd>
      <dt>Direction</dt>
      <dd>
        {direction ? (
          <a href={href.direction(direction.id)}>{direction.title}</a>
        ) : (
          run.direction
        )}
      </dd>
      <dt>Time</dt>
      <dd>
        {runTimes(run)}
        {detail && ` At most ${detail.minutes} min.`}
      </dd>
    </dl>
  );
}

function Metrics({ run }: { readonly run: Run }): ReactNode {
  const metrics = Object.entries(run.metrics);
  if (!metrics.length)
    return (
      <p className="muted run-fine">
        No metrics. A run reports them with <code>METRIC name=value</code> lines
        or a <code>metrics.json</code> file.
      </p>
    );
  return (
    <section className="section" aria-labelledby="run-metrics">
      <h2 id="run-metrics" className="section__title">
        Metrics
      </h2>
      <div className="table-box">
        <table className="metrics">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map(([name, value]) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td>{value === null ? 'Not a number' : String(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The files that Verifold kept from the run, folded, as the canvas folds depth. */
function Outputs({ detail }: { readonly detail: RunDetail }): ReactNode {
  const count = detail.outputs.length + detail.moreOutputs;
  if (!count) return null;
  return (
    <details className="run-outputs">
      <summary className="run-outputs__summary">
        Files it kept ({count})
      </summary>
      <ul className="outputs">
        {detail.outputs.map((output) => (
          <li key={output.path}>
            <code className="mono">{output.path}</code>{' '}
            <span className="muted">{size(output.bytes)}</span>
          </li>
        ))}
      </ul>
      {detail.moreOutputs > 0 && (
        <span className="more">
          and {detail.moreOutputs} more{' '}
          {detail.moreOutputs === 1 ? 'file' : 'files'}
        </span>
      )}
      <p className="muted run-fine">
        They are in{' '}
        <code className="mono">
          .verifold/lab/runs/{detail.run.id}/outputs/
        </code>{' '}
        in the project folder.
      </p>
    </details>
  );
}

/**
 * The end of the run's log, shown from its last line. A read that brings
 * more keeps the box at its end, unless the person scrolled up to read.
 */
function RunLog({ detail }: { readonly detail: RunDetail }): ReactNode {
  const box = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  const text = detail.log?.text;
  useEffect(() => {
    const element = box.current;
    if (element && atEnd.current) element.scrollTop = element.scrollHeight;
  }, [text]);
  return (
    <section className="section" aria-labelledby="run-log">
      <h2 id="run-log" className="section__title">
        The end of its log
      </h2>
      {detail.log ? (
        <>
          <pre
            ref={box}
            className="log run-log"
            tabIndex={0}
            onScroll={(event) => {
              const element = event.currentTarget;
              atEnd.current =
                element.scrollHeight -
                  element.scrollTop -
                  element.clientHeight <
                24;
            }}
          >
            {detail.log.text || ' '}
          </pre>
          {detail.log.partial && (
            <p className="muted run-fine">
              The whole log has {size(detail.log.bytes)}. This is its end.
            </p>
          )}
        </>
      ) : (
        <p className="muted run-fine">No log yet.</p>
      )}
    </section>
  );
}
