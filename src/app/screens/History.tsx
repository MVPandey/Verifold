import { useContext, useEffect, useState, type ReactNode } from 'react';
import type {
  FileDiff,
  HistoryEntry,
  HistoryLabRun,
  HistoryList,
  HistoryResearchRun,
  HistoryRun,
  HistoryTask,
  HistoryTaskSummary,
  HistoryTaskVersion,
  HistoryTurns,
  Snapshot,
  Text,
} from '../../protocol/api.ts';
import { shownVerdict, verdictLabels } from '../../ui/lab-lines.ts';
import { turnSummary } from '../activity.ts';
import type { ActOutcome, Loaded } from '../api.ts';
import { authorOf, clock, harnessName } from '../format.ts';
import {
  archivedAt,
  counted,
  HistoryContext,
  kindName,
  phaseNames,
  startOverKeeps,
  startOverMoves,
} from '../history.ts';
import { href, replaceRoute } from '../route.ts';
import { size } from '../runs.ts';
import type { Connection } from '../store.ts';
import { useAction } from '../useAction.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { Chevron } from '../components/Icons.tsx';

/** What every History page gets from the app. */
interface PageProps {
  readonly snapshot: Snapshot;
  readonly connection: Connection;
  readonly now: number;
  readonly onPause: (pause: boolean, key: string) => Promise<ActOutcome>;
}

function Page({
  snapshot,
  connection,
  now,
  onPause,
  back,
  children,
}: PageProps & {
  readonly back: { readonly href: string; readonly label: string };
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div className="page">
      <AppHeader
        project={snapshot.project}
        own={snapshot.ownProfile === true}
        lab={snapshot.lab}
        now={now}
        onPause={onPause}
      />
      <main className="main">
        <div className="column column--detail history">
          <ConnectionBar connection={connection} at={snapshot.at} />
          <a className="back" href={back.href}>
            <Chevron to="left" />
            {back.label}
          </a>
          {children}
        </div>
      </main>
    </div>
  );
}

/** A read of History: its value, or why it failed, while `key` stays the same. */
function useHistoryRead<T>(
  key: string | null,
  read: (signal: AbortSignal) => Promise<Loaded<T>>,
): { readonly value: T | null; readonly error: string | null } {
  const [state, setState] = useState<{
    readonly key: string;
    readonly value: T | null;
    readonly error: string | null;
  } | null>(null);
  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    void read(controller.signal).then((loaded) => {
      if (controller.signal.aborted) return;
      setState(
        'error' in loaded
          ? { key, value: null, error: loaded.error }
          : { key, value: loaded.value, error: null },
      );
    });
    return () => controller.abort();
    // The read is new on each render; the key says when to read again.
  }, [key]);
  return state && state.key === key ? state : { value: null, error: null };
}

/** A text that Verifold may have cut, and a word when it did. */
function Shown({ value }: { readonly value: Text }): ReactNode {
  return (
    <>
      {value.text}
      {value.trimmed && <span className="muted"> (cut)</span>}
    </>
  );
}

/** A line under a list that leaves items out, such as "and 3 more checks". */
function More({
  count,
  one,
  many,
}: {
  readonly count: number;
  readonly one: string;
  readonly many: string;
}): ReactNode {
  return count > 0 ? (
    <p className="more">and {counted(count, `more ${one}`, `more ${many}`)}</p>
  ) : null;
}

/** An entry of a record that Verifold could not read. */
function Unreadable({ what }: { readonly what: string }): ReactNode {
  return <span className="muted">This {what} could not be read.</span>;
}

function Problem({ error }: { readonly error: string | null }): ReactNode {
  return error ? (
    <p role="alert" className="composer__error">
      {error}
    </p>
  ) : null;
}

function entryLine(entry: HistoryEntry): string {
  return [
    entry.at === null
      ? 'The current run, from the earlier research flow'
      : `${kindName(entry)}, archived ${archivedAt(entry.at)}`,
    entry.direction ? `Direction: ${entry.direction}` : null,
    entry.tasks ? counted(entry.tasks, 'task', 'tasks') : null,
    entry.bytes ? size(entry.bytes) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function RunLink({ entry }: { readonly entry: HistoryEntry }): ReactNode {
  return (
    <li>
      <a className="history-run" href={href.historyRun(entry.id)}>
        <b>{entry.question ?? 'A run without a question'}</b>
        <span className="muted">{entryLine(entry)}</span>
      </a>
    </li>
  );
}

/**
 * History: the project's earlier runs, newest first, and its memory files.
 * Start over moves a run here. Verifold deletes none of them.
 */
export function HistoryPage(props: PageProps): ReactNode {
  const tools = useContext(HistoryContext);
  const read = useHistoryRead<HistoryList>(tools ? 'list' : null, (signal) =>
    tools ? tools.list(signal) : Promise.resolve({ error: '' }),
  );
  const list = read.value;
  return (
    <Page {...props} back={{ href: href.lab, label: 'The project' }}>
      <h1 className="page-title">History</h1>
      <p className="muted">
        The earlier runs of this project. Start over moves a run here, and
        Verifold deletes none of them: each one stays in{' '}
        <code>.verifold/archive/</code> in the project folder.
      </p>
      <Problem error={read.error} />
      {tools && !list && !read.error && (
        <p className="muted">Reading the runs…</p>
      )}
      {list &&
        (list.current || list.runs.length ? (
          <ul className="history-runs">
            {list.current && <RunLink entry={list.current} />}
            {list.runs.map((entry) => (
              <RunLink key={entry.id} entry={entry} />
            ))}
          </ul>
        ) : (
          <p className="muted">No earlier runs yet.</p>
        ))}
      {list?.more && (
        <p className="more">
          Only the newest {list.runs.length} runs show here.
        </p>
      )}
      {props.snapshot.lab && tools && (
        <p>
          <a href={href.startOver}>Start over</a> moves the current run here and
          keeps its question.
        </p>
      )}
      {list && list.memory.length > 0 && (
        <section className="section" aria-labelledby="history-memory">
          <h2 id="history-memory" className="section__title">
            Project memory
          </h2>
          {list.memory.map((file) => (
            <details key={file.name} className="history-fold">
              <summary>{file.name}</summary>
              <pre className="history-text">{file.text.text}</pre>
              {file.text.trimmed && (
                <p className="more">
                  This file is long, so only its start shows.
                </p>
              )}
            </details>
          ))}
        </section>
      )}
    </Page>
  );
}

/**
 * The turns of a research attempt or a session in a run, folded as the
 * agent pages fold them. They are read when the person opens them.
 */
function Turns({
  run,
  source,
  now,
}: {
  readonly run: string;
  readonly source: string;
  readonly now: number;
}): ReactNode {
  const tools = useContext(HistoryContext);
  const [open, setOpen] = useState(false);
  const read = useHistoryRead<HistoryTurns>(
    open && tools ? `${run}/${source}` : null,
    (signal) =>
      tools ? tools.turns(run, source, signal) : Promise.resolve({ error: '' }),
  );
  if (!tools) return null;
  return (
    <details
      className="history-fold"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Its turns</summary>
      <Problem error={read.error} />
      {open && !read.value && !read.error && (
        <p className="muted">Reading the turns…</p>
      )}
      {read.value && (
        <ol className="history-list">
          {read.value.turns.map((turn) => (
            <li key={turn.id}>
              <span className="muted">{turnSummary(turn, now)}</span>
              {turn.message && (
                <p className="history-post">
                  <Shown value={turn.message} />
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {read.value?.more && (
        <p className="more">Only the newest turns show here.</p>
      )}
    </details>
  );
}

/** A lab's archived run: the question, the plan, directions, runs, and the newest posts. */
export function LabRun({ run }: { readonly run: HistoryLabRun }): ReactNode {
  return (
    <>
      <p className="muted">
        {kindName(run.entry)}
        {run.startedAt ? `, started ${archivedAt(run.startedAt)}` : ''}
        {run.entry.at ? `, archived ${archivedAt(run.entry.at)}` : ''}
      </p>
      {!run.readable && (
        <p className="more">
          The lab's own record could not be read, so only its runs and its board
          show here.
        </p>
      )}
      {run.question !== null && (
        <section className="section" aria-labelledby="history-question">
          <h2 id="history-question" className="section__title">
            The question
          </h2>
          <p className="history-post">{run.question}</p>
        </section>
      )}
      {run.plan && (
        <section className="section" aria-labelledby="history-plan">
          <h2 id="history-plan" className="section__title">
            The plan of record
          </h2>
          <p className="history-post">
            <Shown value={run.plan.reading} />
          </p>
          <p className="muted">
            <Shown value={run.plan.cost} />
          </p>
          {run.plan.facts.length > 0 && (
            <ul className="history-list">
              {run.plan.facts.map((fact, index) => (
                <li key={index}>
                  {fact.claim}{' '}
                  <span className="muted">
                    · {fact.source ?? 'unverified (no source)'}
                    {fact.sourceDate ? `, ${fact.sourceDate}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {run.directions.length > 0 && (
        <section className="section" aria-labelledby="history-directions">
          <h2 id="history-directions" className="section__title">
            Directions
          </h2>
          <ul className="history-list">
            {run.directions.map((direction) => {
              const shown = shownVerdict({ ...direction, disputed: false });
              return (
                <li key={direction.id}>
                  <span className={`verdict verdict--${shown}`}>
                    {verdictLabels[shown]}
                  </span>{' '}
                  <b>{direction.title}</b>
                  {direction.handle && (
                    <span className="muted"> · {direction.handle}</span>
                  )}
                  {direction.bar && (
                    <div className="muted">Holds up if: {direction.bar}</div>
                  )}
                  {direction.evidence && (
                    <div className="history-post">{direction.evidence}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {run.runs.length > 0 && (
        <section className="section" aria-labelledby="history-runs">
          <h2 id="history-runs" className="section__title">
            Runs
          </h2>
          <ul className="history-list">
            {run.runs.map((entry) => (
              <li key={entry.id}>
                <b>{entry.id}</b>{' '}
                <span className="muted">· {entry.status}</span>
                <div>
                  <code className="history-code">{entry.command}</code>
                </div>
                {Object.keys(entry.metrics).length > 0 && (
                  <div className="muted">
                    {Object.entries(entry.metrics)
                      .map(
                        ([name, value]) => `${name} ${value ?? 'not a number'}`,
                      )
                      .join(' · ')}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="section" aria-labelledby="history-board">
        <h2 id="history-board" className="section__title">
          Board
        </h2>
        {run.olderPosts > 0 && (
          <p className="more">
            {run.olderPosts} older{' '}
            {run.olderPosts === 1 ? 'post is' : 'posts are'} not shown.
          </p>
        )}
        <ul className="history-list">
          {run.posts.map((post) => (
            <li key={post.id}>
              <span className="muted">
                {authorOf(post)} · {clock(post.at)}
              </span>
              <p className="history-post">{post.text}</p>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

/** One file of a task version, with its diff, read when the person opens it. */
function VersionFile({
  run,
  task,
  version,
  file,
}: {
  readonly run: string;
  readonly task: string;
  readonly version: number;
  readonly file: HistoryTaskVersion['files'][number];
}): ReactNode {
  const tools = useContext(HistoryContext);
  const [open, setOpen] = useState(false);
  const read = useHistoryRead<FileDiff>(
    open && tools ? `${run}/${task}/${version}/${file.path}` : null,
    (signal) =>
      tools
        ? tools.diff(run, task, version, file.path, signal)
        : Promise.resolve({ error: '' }),
  );
  return (
    <details
      className="history-fold"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {file.change && <span className="muted">{file.change} </span>}
        <code className="history-code">{file.path}</code>
        {!file.inScope && <span className="muted"> · outside its scope</span>}
      </summary>
      <Problem error={read.error} />
      {read.value && (
        <>
          <pre className="history-text history-text--code">
            {read.value.text || 'No text change.'}
          </pre>
          {read.value.trimmed && (
            <p className="more">This diff is long, so only its start shows.</p>
          )}
        </>
      )}
    </details>
  );
}

/** A task's line in a run: from its record, or why the record does not show. */
function taskLine(task: HistoryTaskSummary): string {
  if (task.record === 'unreadable') return 'Its record could not be read.';
  if (task.record === 'large')
    return 'Its record is long, so it shows when you open it.';
  return [
    task.state,
    task.outcome ? `its last attempt: ${task.outcome}` : null,
    task.harness ? harnessName(task.harness) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function TaskItem({
  run,
  task,
  now,
}: {
  readonly run: string;
  readonly task: HistoryTaskSummary;
  readonly now: number;
}): ReactNode {
  const tools = useContext(HistoryContext);
  const [open, setOpen] = useState(false);
  const read = useHistoryRead<HistoryTask>(
    open && tools ? `${run}/${task.id}` : null,
    (signal) =>
      tools ? tools.task(run, task.id, signal) : Promise.resolve({ error: '' }),
  );
  const detail = read.value;
  return (
    <details
      className="history-fold"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <b>{task.id}</b> {task.title ?? ''}{' '}
        <span className="muted">· {taskLine(task)}</span>
      </summary>
      <Problem error={read.error} />
      {open && tools && !detail && !read.error && (
        <p className="muted">Reading the task…</p>
      )}
      {detail && (
        <div className="history-task">
          <p className="history-post">
            <Shown value={detail.objective} />
          </p>
          {detail.olderAttempts > 0 && (
            <p className="more">
              {detail.olderAttempts} older{' '}
              {detail.olderAttempts === 1 ? 'attempt is' : 'attempts are'} not
              shown.
            </p>
          )}
          {detail.attempts.map((attempt) => (
            <div key={attempt.number} className="history-attempt">
              <p className="muted">
                Attempt {attempt.number}
                {attempt.startedAt ? `, ${archivedAt(attempt.startedAt)}` : ''}
                {attempt.outcome ? ` · ${attempt.outcome}` : ''}
              </p>
              {attempt.note && <p>{attempt.note}</p>}
              {attempt.olderVersions > 0 && (
                <p className="more">
                  {attempt.olderVersions} older{' '}
                  {attempt.olderVersions === 1 ? 'version is' : 'versions are'}{' '}
                  not shown.
                </p>
              )}
              {attempt.versions.map((version) => (
                <div key={version.number}>
                  <p>
                    Version {version.number}
                    {version.turn ? ` · ${version.turn}` : ''}
                    {version.decision
                      ? ` · ${version.decision.kind} by ${version.decision.by === 'person' ? 'you' : 'the coordinator'}`
                      : ''}
                  </p>
                  {version.decision?.note && (
                    <p className="muted">{version.decision.note}</p>
                  )}
                  {version.reply && (
                    <p className="history-post">
                      <Shown value={version.reply} />
                    </p>
                  )}
                  <ul className="history-files">
                    {version.files.map((file) => (
                      <li key={file.path}>
                        <VersionFile
                          run={run}
                          task={task.id}
                          version={version.number}
                          file={file}
                        />
                      </li>
                    ))}
                  </ul>
                  <More count={version.moreFiles} one="file" many="files" />
                </div>
              ))}
              {attempt.session && (
                <Turns
                  run={run}
                  source={`session:${attempt.session}`}
                  now={now}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

/** A run of the earlier research flow, read only. */
export function ResearchRun({
  run,
  now,
}: {
  readonly run: HistoryResearchRun;
  readonly now: number;
}): ReactNode {
  const id = run.entry.id;
  return (
    <>
      <p className="muted">{entryLine(run.entry)}</p>
      <section className="section" aria-labelledby="history-question">
        <h2 id="history-question" className="section__title">
          The question
        </h2>
        <p className="history-post">{run.question ?? 'No question.'}</p>
        {run.brief && (
          <details className="history-fold">
            <summary>The brief</summary>
            <pre className="history-text">
              <Shown value={run.brief} />
            </pre>
          </details>
        )}
        {run.plan && (
          <details className="history-fold">
            <summary>The research plan</summary>
            <p className="history-post">{run.plan.scope}</p>
            <ul className="history-list">
              {run.plan.personas.map((persona) => (
                <li key={persona.name}>
                  <b>{persona.name}</b>: {persona.task}
                </li>
              ))}
            </ul>
            <More count={run.plan.morePersonas} one="persona" many="personas" />
          </details>
        )}
      </section>
      {run.attempts.length > 0 && (
        <section className="section" aria-labelledby="history-attempts">
          <h2 id="history-attempts" className="section__title">
            Research
          </h2>
          {run.moreAttempts > 0 && (
            <p className="more">
              {run.moreAttempts} older research{' '}
              {run.moreAttempts === 1 ? 'step is' : 'steps are'} not shown.
            </p>
          )}
          <ul className="history-list">
            {run.attempts.map((attempt) => (
              <li key={attempt.id}>
                <span className="muted">
                  {[
                    attempt.phase
                      ? (phaseNames[attempt.phase] ?? attempt.phase)
                      : null,
                    attempt.status,
                    attempt.harness ? harnessName(attempt.harness) : null,
                    attempt.model,
                    attempt.startedAt ? archivedAt(attempt.startedAt) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') ||
                    'A research step whose record cannot be read'}
                </span>
                {attempt.summary && (
                  <p className="history-post">
                    <Shown value={attempt.summary} />
                  </p>
                )}
                {attempt.sources.length > 0 && (
                  <details className="history-fold">
                    <summary>
                      {counted(
                        attempt.sources.length + attempt.moreSources,
                        'source',
                        'sources',
                      )}
                    </summary>
                    <ul className="history-list">
                      {attempt.sources.map((source) => (
                        <li key={source.url}>
                          <a href={source.url} rel="noreferrer" target="_blank">
                            {source.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                    <More
                      count={attempt.moreSources}
                      one="source"
                      many="sources"
                    />
                  </details>
                )}
                {attempt.transcript && (
                  <Turns run={id} source={`attempt:${attempt.id}`} now={now} />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {run.candidates.length > 0 && (
        <section className="section" aria-labelledby="history-candidates">
          <h2 id="history-candidates" className="section__title">
            Directions
          </h2>
          <ul className="history-list">
            {run.candidates.map((candidate) => (
              <li key={candidate.id}>
                <b>{candidate.title}</b>
                {candidate.id === run.chosen && (
                  <span className="chip chip--plan">Chosen</span>
                )}
                <p className="history-post">
                  <Shown value={candidate.recommendation} />
                </p>
                {candidate.checks.length > 0 && (
                  <ul className="history-list history-list--checks">
                    {candidate.checks.map((check, index) => (
                      <li key={index}>{check}</li>
                    ))}
                  </ul>
                )}
                <More count={candidate.moreChecks} one="check" many="checks" />
              </li>
            ))}
          </ul>
          <More count={run.moreCandidates} one="direction" many="directions" />
        </section>
      )}
      {run.coordinator && (
        <section className="section" aria-labelledby="history-coordinator">
          <h2 id="history-coordinator" className="section__title">
            The coordinator
          </h2>
          <p className="history-post">
            <Shown value={run.coordinator.objective} />
          </p>
          <p className="muted">
            {harnessName(run.coordinator.harness)}
            {run.coordinator.model ? ` · ${run.coordinator.model}` : ''}
            {run.coordinator.startedAt
              ? ` · started ${archivedAt(run.coordinator.startedAt)}`
              : ''}
            {run.coordinator.stoppedAt
              ? ` · stopped ${archivedAt(run.coordinator.stoppedAt)}`
              : ''}
            {run.coordinator.planApproved ? ' · you approved its plan' : ''}
          </p>
          {run.coordinator.actions.length > 0 && (
            <details className="history-fold">
              <summary>
                {counted(
                  run.coordinator.actions.length + run.coordinator.olderActions,
                  'action',
                  'actions',
                )}
              </summary>
              {run.coordinator.olderActions > 0 && (
                <p className="more">
                  {run.coordinator.olderActions} older actions are not shown.
                </p>
              )}
              <ol className="history-list">
                {run.coordinator.actions.map((action, index) => (
                  <li key={index}>
                    {action ? (
                      <>
                        <code className="history-code">{action.tool}</code>{' '}
                        <span className="muted">
                          · {clock(action.at)}
                          {action.ok ? '' : ' · refused'}
                        </span>
                        {action.reason && <div>{action.reason}</div>}
                        <div className="muted">
                          <Shown value={action.result} />
                        </div>
                      </>
                    ) : (
                      <Unreadable what="action" />
                    )}
                  </li>
                ))}
              </ol>
            </details>
          )}
          {run.coordinator.session && (
            <Turns
              run={id}
              source={`session:${run.coordinator.session}`}
              now={now}
            />
          )}
        </section>
      )}
      {run.tasks.length > 0 && (
        <section className="section" aria-labelledby="history-tasks">
          <h2 id="history-tasks" className="section__title">
            Tasks
          </h2>
          {run.tasks.map((task) => (
            <TaskItem key={task.id} run={id} task={task} now={now} />
          ))}
          <More count={run.moreTasks} one="task" many="tasks" />
        </section>
      )}
      {run.results.map((results, at) => (
        <section
          key={at}
          className="section"
          aria-labelledby={`history-results-${at}`}
        >
          <h2 id={`history-results-${at}`} className="section__title">
            Results
          </h2>
          <ul className="history-list">
            {results.checks.map((check, index) => (
              <li key={index}>
                {check ? (
                  <>
                    Check {check.check}: <b>{check.result}</b> · {check.value}
                    <div className="muted">
                      <Shown value={check.reason} />
                    </div>
                    {check.ruling && (
                      <div>
                        Your ruling: {check.ruling.result}.{' '}
                        {check.ruling.reason}
                      </div>
                    )}
                  </>
                ) : (
                  <Unreadable what="check" />
                )}
              </li>
            ))}
          </ul>
          <More count={results.moreChecks} one="check" many="checks" />
          {results.answer && (
            <div className="history-answer">
              <p className="history-post">
                {results.answer.statement ? (
                  <Shown value={results.answer.statement} />
                ) : (
                  <Unreadable what="answer" />
                )}
              </p>
              <ul className="history-list">
                {results.answer.claims.map((claim, index) => (
                  <li key={index}>
                    {claim ? (
                      <>
                        {claim.text}
                        {claim.evidence.length > 0 && (
                          <span className="muted">
                            {' '}
                            · {claim.evidence.join(', ')}
                            {claim.moreEvidence > 0
                              ? `, and ${claim.moreEvidence} more`
                              : ''}
                          </span>
                        )}
                      </>
                    ) : (
                      <Unreadable what="claim" />
                    )}
                  </li>
                ))}
              </ul>
              <More
                count={results.answer.moreClaims}
                one="claim"
                many="claims"
              />
              {results.answer.decision && (
                <p className="muted">
                  {results.answer.decision.kind === 'accepted'
                    ? 'You accepted this answer.'
                    : 'You asked for more work.'}
                  {results.answer.decision.note
                    ? ` ${results.answer.decision.note}`
                    : ''}
                </p>
              )}
            </div>
          )}
        </section>
      ))}
      {run.moreResults > 0 && (
        <p className="more">
          {run.moreResults} more results{' '}
          {run.moreResults === 1 ? 'file is' : 'files are'} not shown.
        </p>
      )}
      {run.messages.length > 0 && (
        <section className="section" aria-labelledby="history-messages">
          <h2 id="history-messages" className="section__title">
            Messages
          </h2>
          <details className="history-fold">
            <summary>
              {counted(
                run.messages.length + run.olderMessages,
                'message',
                'messages',
              )}
            </summary>
            {run.olderMessages > 0 && (
              <p className="more">
                {run.olderMessages} older messages are not shown.
              </p>
            )}
            <ol className="history-list">
              {run.messages.map((message) => (
                <li key={message.id}>
                  <span className="muted">
                    {message.from} to {message.to} · {message.kind} ·{' '}
                    {clock(message.at)}
                    {message.status ? ` · ${message.status}` : ''}
                  </span>
                  <p className="history-post">
                    <Shown value={message.text} />
                  </p>
                  {message.answer && (
                    <p className="muted">
                      Its answer: <Shown value={message.answer} />
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </details>
        </section>
      )}
      {run.sessions.length > 0 && (
        <section className="section" aria-labelledby="history-sessions">
          <h2 id="history-sessions" className="section__title">
            Your sessions
          </h2>
          <ul className="history-list">
            {run.sessions.map((session) => (
              <li key={session.id}>
                <span className="muted">
                  {harnessName(session.harness)}
                  {session.model ? ` · ${session.model}` : ''} ·{' '}
                  {session.status} · {archivedAt(session.startedAt)}
                  {session.costUsd !== null
                    ? ` · ≈$${session.costUsd.toFixed(2)}`
                    : ''}
                </span>
                {session.commands.length > 0 && (
                  <details className="history-fold">
                    <summary>
                      {counted(
                        session.commands.length + session.olderCommands,
                        'command',
                        'commands',
                      )}
                    </summary>
                    <ol className="history-list">
                      {session.commands.map((command, index) => (
                        <li key={index}>
                          <code className="history-code">
                            <Shown value={command.action} />
                          </code>
                          {command.risk.length > 0 && (
                            <span className="muted">
                              {' '}
                              · {command.risk.join(', ')}
                            </span>
                          )}
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
                {session.transcript && (
                  <Turns run={id} source={`session:${session.id}`} now={now} />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {run.pods.length > 0 && (
        <section className="section" aria-labelledby="history-pods">
          <h2 id="history-pods" className="section__title">
            Pods
          </h2>
          <ul className="history-list">
            {run.pods.map((pod) => (
              <li key={pod.lease}>
                <b>{pod.lease}</b>{' '}
                <span className="muted">
                  ·{' '}
                  {[
                    pod.gpu,
                    pod.state,
                    pod.costUsd === null ? null : `$${pod.costUsd.toFixed(2)}`,
                    pod.tasks.join(', '),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ul>
          <More count={run.morePods} one="pod" many="pods" />
        </section>
      )}
    </>
  );
}

/**
 * Start over's button: it moves the current run into History, and then the
 * project's page asks for the question of a new lab. `expect`: the run that
 * the page showed, so a page from before a lab started cannot archive the lab.
 */
function StartOverButton({
  label,
  expect,
  children,
}: {
  readonly label: string;
  readonly expect?: 'research';
  readonly children?: ReactNode;
}): ReactNode {
  const tools = useContext(HistoryContext);
  const action = useAction<null>((_, key) =>
    tools
      ? tools.startOver(key, expect)
      : Promise.resolve({ refused: 'Open Verifold from your terminal.' }),
  );
  return (
    <>
      <p className="history-actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!tools || action.busy}
          onClick={() =>
            void action.submit(null).then((ran) => {
              if (ran) replaceRoute(href.lab);
            })
          }
        >
          {label}
        </button>
        {children}
      </p>
      <Problem error={action.error} />
    </>
  );
}

/**
 * A run that History read. The current run, when the read says that it is
 * from the earlier research flow, offers Start a lab: Start over archives
 * the run first, then the project's page asks for the question of the lab.
 */
export function HistoryRunView({
  id,
  run,
  now,
}: {
  readonly id: string;
  readonly run: HistoryRun;
  readonly now: number;
}): ReactNode {
  return run.kind === 'lab' ? (
    <LabRun run={run} />
  ) : (
    <>
      {id === 'current' && (
        <div className="status status--plan history-start">
          <p>
            This run is from Verifold's earlier research flow. It shows here
            read only. Start a lab moves it into History first, and then you
            start a lab on its question, or on a new one.
          </p>
          <StartOverButton label="Start a lab" expect="research" />
        </div>
      )}
      <ResearchRun run={run} now={now} />
    </>
  );
}

/** One run of History: a lab's run, or a run of the earlier research flow. */
export function HistoryRunPage({
  id,
  ...props
}: PageProps & { readonly id: string }): ReactNode {
  const tools = useContext(HistoryContext);
  const read = useHistoryRead<HistoryRun>(
    tools ? `run/${id}` : null,
    (signal) =>
      tools ? tools.run(id, signal) : Promise.resolve({ error: '' }),
  );
  const run = read.value;
  return (
    <Page {...props} back={{ href: href.history, label: 'History' }}>
      <h1 className="page-title">
        {id === 'current' ? 'The current run' : 'An earlier run'}
      </h1>
      <Problem error={read.error} />
      {tools && !run && !read.error && (
        <p className="muted">Reading the run…</p>
      )}
      {run && <HistoryRunView id={id} run={run} now={props.now} />}
    </Page>
  );
}

/** Start over: what it keeps, what it moves into History, and the button. */
export function StartOverPage(props: PageProps): ReactNode {
  return (
    <Page {...props} back={{ href: href.lab, label: 'The project' }}>
      <h1 className="page-title">Start over</h1>
      <p>
        Start over moves this run into History. Then you start a new lab on the
        same question, or on a new one. Verifold stops the lab's agents first,
        and deletes nothing.
      </p>
      <section className="section" aria-labelledby="start-over-keeps">
        <h2 id="start-over-keeps" className="section__title">
          It keeps
        </h2>
        <ul className="history-list">
          {startOverKeeps.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
      <section className="section" aria-labelledby="start-over-moves">
        <h2 id="start-over-moves" className="section__title">
          It moves into History
        </h2>
        <ul className="history-list">
          {startOverMoves.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
      <StartOverButton label="Start over">
        <a href={href.lab}>Keep this run</a>
      </StartOverButton>
    </Page>
  );
}
