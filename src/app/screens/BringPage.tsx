import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type {
  BringFile,
  BringGroup,
  BringList,
  BringRead,
  Direction,
  Lab,
  Snapshot,
  UndoneGroup,
} from '../../protocol/api.ts';
import {
  bringKey,
  bringWork,
  chosenFiles,
  sameBring,
  type BringIntent,
  type Ticks,
} from '../answer.ts';
import { DiffReads, type DiffShown } from '../diffs.ts';
import { clock } from '../format.ts';
import { href } from '../route.ts';
import type { Connection } from '../store.ts';
import { useAction } from '../useAction.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { Chevron } from '../components/Icons.tsx';
import type { AnswerActions } from './AnswerPage.tsx';
import type { LabActions } from './LabHome.tsx';

/** The warning beside a file that can run code, as the desk words it. */
export const codeWarning =
  'This file can run code on your computer. Bring it in only if its diff looks right.';

/** No diff is open. */
const noDiffs: ReadonlyMap<string, DiffShown> = new Map();

function DiffBox({ diff }: { readonly diff: DiffShown }): ReactNode {
  if (diff === 'loading') return <p className="more">Reading the diff…</p>;
  if ('error' in diff)
    return (
      <p role="alert" className="composer__error">
        {diff.error}
      </p>
    );
  return (
    <pre className="bring-diff">
      {diff.value.text || 'No changes in the text.'}
      {diff.value.trimmed ? '\n… Verifold cut the rest of this diff.' : ''}
    </pre>
  );
}

/** One file that can come in: its box, its change, why it is not ticked, its warning, and its diff. */
function BringRow({
  file,
  checked,
  disabled,
  onTick,
  diff,
  onDiff,
}: {
  readonly file: BringFile;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onTick: (path: string, on: boolean) => void;
  readonly diff: DiffShown | undefined;
  readonly onDiff: (path: string) => void;
}): ReactNode {
  const id = useId();
  const why = file.since ? `Brought in at ${clock(file.since)}.` : file.why;
  return (
    <li className="bring-file">
      <div className="bring-file__line">
        <input
          type="checkbox"
          id={id}
          checked={checked}
          disabled={disabled}
          onChange={(event) => onTick(file.path, event.target.checked)}
          {...(file.code ? { 'aria-describedby': `${id}-code` } : {})}
        />
        <label htmlFor={id}>
          <code>{file.path}</code>
        </label>
        <span
          className={`bring-file__change bring-file__change--${file.change}`}
        >
          {file.change}
        </span>
        <button
          type="button"
          className="link-button"
          aria-expanded={diff !== undefined}
          aria-label={`Diff of ${file.path}`}
          onClick={() => onDiff(file.path)}
        >
          Diff
        </button>
      </div>
      {why && <span className="bring-file__why">{why}</span>}
      {file.code && (
        <span
          id={`${id}-code`}
          className={`bring-file__code${checked ? ' bring-file__code--ticked' : ''}`}
        >
          {codeWarning}
        </span>
      )}
      {diff !== undefined && <DiffBox diff={diff} />}
    </li>
  );
}

/**
 * The files of a bring-in, as the desk's bring-in panel shows them: the ones
 * that can come in, each with a box and its diff, then the ones that stay
 * out and the ones that the commit leaves out, each with why. Files that run
 * code, project memory, and scratch output start unticked. A file that came
 * in with this content cannot be ticked. Without the lab's agents here,
 * nothing can be ticked.
 */
export function BringFiles({
  lab,
  list,
  agentName,
  chosen,
  onTick,
  diffs,
  onDiff,
  onLook,
  lookBusy,
}: {
  readonly lab: Lab;
  readonly list: BringList;
  readonly agentName: string;
  readonly chosen: ReadonlySet<string>;
  readonly onTick: (path: string, on: boolean) => void;
  readonly diffs: ReadonlyMap<string, DiffShown>;
  readonly onDiff: (path: string) => void;
  readonly onLook: () => void;
  readonly lookBusy: boolean;
}): ReactNode {
  const can = list.files.filter((file) => file.out === null);
  const out = list.files.filter((file) => file.out !== null);
  const count = list.files.length + list.omitted;
  return (
    <>
      {list.working && (
        <p role="status" className="bring-note">
          {agentName} is working, so these are its files as of its last turn.
          When its turn ends, its newer work shows here.
        </p>
      )}
      <p className="bring-text">
        {count
          ? `${count} ${count === 1 ? 'file' : 'files'} changed since this direction started or since they came in. The ticked files come into your project folder. Nothing else changes, and nothing merges by itself.`
          : 'This direction changed no file since it started or since its files came in.'}
      </p>
      {list.omitted > 0 && (
        <span className="more">
          {list.omitted} more {list.omitted === 1 ? 'file is' : 'files are'} not
          listed here, so {list.omitted === 1 ? 'it does' : 'they do'} not come
          in.
        </span>
      )}
      {list.newer && lab.agentsHere && (
        <p className="bring-text">
          {agentName} has newer work.{' '}
          <button
            type="button"
            className="link-button link-button--inline"
            disabled={lookBusy}
            onClick={onLook}
          >
            Show the newer files
          </button>
        </p>
      )}
      {can.length > 0 && (
        <ul className="bring-files">
          {can.map((file) => (
            <BringRow
              key={file.path}
              file={file}
              checked={chosen.has(file.path)}
              disabled={file.since !== null || !lab.agentsHere}
              onTick={onTick}
              diff={diffs.get(file.path)}
              onDiff={onDiff}
            />
          ))}
        </ul>
      )}
      {out.length > 0 && (
        <>
          <p className="bring-text">Stays out:</p>
          <ul className="bring-out">
            {out.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>{' '}
                <span className="muted">{file.out}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {list.left.length > 0 && (
        <>
          <p className="bring-text">
            Left out of this commit, so they cannot come in:
          </p>
          <ul className="bring-out">
            {list.left.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>{' '}
                <span className="muted">{file.why}</span>
              </li>
            ))}
            {list.leftOmitted > 0 && (
              <li className="muted">and {list.leftOmitted} more</li>
            )}
          </ul>
        </>
      )}
    </>
  );
}

/** Files as one list: "a.md, b.md", with how many the list leaves out. */
function fileList(paths: readonly string[], more: number): string {
  return `${paths.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/**
 * One undo of a bring-in: which files went back, which stayed because the
 * person or a later bring-in changed them, and which could not go back.
 */
function UndoneLine({ entry }: { readonly entry: UndoneGroup }): ReactNode {
  const { restored, kept, newer, failed, more } = entry;
  const one = (files: readonly string[]): boolean => files.length === 1;
  return (
    <li>
      {clock(entry.undoneAt)}: you undid the bring-in of {clock(entry.at)}{' '}
      <span className="muted">at {entry.commit.slice(0, 7)}</span>.
      {restored.length > 0 && ` ${restored.join(', ')} went back.`}
      {kept.length > 0 &&
        ` ${kept.join(', ')} stayed as ${one(kept) ? 'it is' : 'they are'}, because you changed ${one(kept) ? 'it' : 'them'}.`}
      {newer.length > 0 &&
        ` ${newer.join(', ')} stayed as ${one(newer) ? 'it is' : 'they are'}, because a later bring-in changed ${one(newer) ? 'it' : 'them'}. Undo that bring-in first to put ${one(newer) ? 'it' : 'them'} back too.`}
      {failed.length > 0 &&
        ` ${failed.join(', ')} could not go back. Undo again to try ${one(failed) ? 'it' : 'them'} once more.`}
      {more > 0 &&
        ` ${more} more ${more === 1 ? 'file is' : 'files are'} not listed.`}
    </li>
  );
}

/**
 * The direction's bring-ins so far: when, which files, at which commit, and
 * an undo for each one that has it. Then the bring-ins that the person
 * undid. Without `onUndo`, as when the lab's agents are not here, no undo
 * shows.
 */
export function BringHistory({
  history,
  undone = [],
  onUndo,
  undoBusy = false,
}: {
  readonly history: readonly BringGroup[];
  readonly undone?: readonly UndoneGroup[];
  readonly onUndo?: (group: BringGroup) => void;
  readonly undoBusy?: boolean;
}): ReactNode {
  if (!history.length && !undone.length) return null;
  const undoable = onUndo
    ? history.filter((group) => group.undoable === true)
    : [];
  return (
    <section className="section" aria-labelledby="brought-title">
      <h2 id="brought-title" className="section__title">
        Brought in
      </h2>
      {history.length > 0 && (
        <ul className="bring-history">
          {history.map((group) => {
            const key = `${group.at}|${group.commit}`;
            return (
              <li key={key}>
                {clock(group.at)}: {fileList(group.paths, group.more)}{' '}
                <span className="muted">at {group.commit.slice(0, 7)}</span>
                {group.undoneAt && (
                  <span className="muted">
                    {' '}
                    · undone at {clock(group.undoneAt)}
                  </span>
                )}
                {onUndo && group.undoable === true && (
                  <button
                    type="button"
                    className="answer__undo bring-history__undo"
                    disabled={undoBusy}
                    aria-label={`Undo the bring-in of ${clock(group.at)}`}
                    onClick={() => onUndo(group)}
                  >
                    {group.undoneAt ? 'Undo again' : 'Undo'}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {undoable.length > 0 && (
        <p className="bring-text bring-text--fine">
          Undo puts each file of a bring-in back to the version that it had
          before. A file that you changed since it came in stays as it is.
        </p>
      )}
      {undone.length > 0 && (
        <>
          <p className="bring-text">Undone:</p>
          <ul className="bring-history">
            {undone.map((entry) => (
              <UndoneLine
                key={`${entry.at}|${entry.commit}|${entry.undoneAt}`}
                entry={entry}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * Bring a direction's files into the project folder, as the desk's bring-in
 * panel does. Verifold first commits the direction's newest work, so the
 * person sees exactly the files that come in, and a bring-in copies that
 * commit. The page reads the files again when the direction's commit or
 * bring-ins change, or a bring-in action ends.
 */
export function BringPage({
  snapshot,
  lab,
  direction,
  connection,
  now,
  actions,
  answerActions,
}: {
  readonly snapshot: Snapshot;
  readonly lab: Lab;
  readonly direction: Direction;
  readonly connection: Connection;
  readonly now: number;
  readonly actions: LabActions;
  readonly answerActions: AnswerActions;
}): ReactNode {
  const agent = lab.agents.find((entry) => entry.id === direction.agent);
  const agentName = agent?.handle ?? 'Its agent';
  const key = bringKey(lab, direction);
  const [nonce, setNonce] = useState(0);
  const [shown, setShown] = useState<BringRead | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void answerActions.read(direction.id, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      // A failed read keeps what the page shows, and says why it is not new.
      if ('value' in result) {
        setShown(result.value);
        setReadError(null);
      } else setReadError(result.error);
    });
    return () => controller.abort();
  }, [answerActions, direction.id, key, nonce]);
  const reload = (): void => setNonce((value) => value + 1);

  const list = shown?.list ?? null;
  const commit = list?.commit ?? null;
  // The person's ticks belong to the commit that they looked at.
  const [ticks, setTicks] = useState<Ticks | null>(null);
  const chosen = chosenFiles(shown, ticks);
  const tick = (path: string, on: boolean): void => {
    if (!commit) return;
    const next = new Set(chosen);
    if (on) next.add(path);
    else next.delete(path);
    setTicks({ commit, paths: next });
  };

  // The open diffs, each of a file at the commit shown. A diff of other work never shows.
  const [diffs, setDiffs] = useState<{
    readonly commit: string | null;
    readonly shown: ReadonlyMap<string, DiffShown>;
  }>({ commit: null, shown: noDiffs });
  const reads = useRef<DiffReads | null>(null);
  reads.current ??= new DiffReads(
    (path, at, signal) => answerActions.diff(direction.id, path, at, signal),
    (at, open) => setDiffs({ commit: at, shown: open }),
  );
  useEffect(() => {
    reads.current?.at(commit);
  }, [commit]);
  useEffect(() => () => reads.current?.stop(), []);
  const open = diffs.commit === commit ? diffs.shown : noDiffs;
  const toggleDiff = (path: string): void => {
    if (commit) reads.current?.toggle(commit, path);
  };

  const look = useAction<string>((id, intent) =>
    answerActions.look(id, intent),
  );
  const doLook = async (): Promise<void> => {
    if (look.busy) return;
    if (await look.submit(direction.id)) reload();
  };
  // A bring-in that runs on in the background shows in the work line, not as done.
  const pending = useRef(false);
  const bring = useAction<BringIntent>(async (sent, intent) => {
    const outcome = await answerActions.bring(
      direction.id,
      sent.commit,
      sent.files,
      intent,
    );
    pending.current = 'ok' in outcome && outcome.pending === true;
    return outcome;
  }, sameBring);
  const [done, setDone] = useState<string | null>(null);
  // An undo names its bring-in by when it came in and its commit.
  const undoPending = useRef(false);
  const undo = useAction<{ readonly at: string; readonly commit: string }>(
    async (sent, intent) => {
      const outcome = await answerActions.undo(
        direction.id,
        sent.at,
        sent.commit,
        intent,
      );
      undoPending.current = 'ok' in outcome && outcome.pending === true;
      return outcome;
    },
    (a, b) => a.at === b.at && a.commit === b.commit,
  );
  const work = bringWork(lab, direction.id);
  // A bring-in or an undo runs, also in the background: nothing else starts meanwhile.
  const running =
    bring.busy || undo.busy || (work !== null && work.error === null);
  const doUndo = async (group: BringGroup): Promise<void> => {
    if (running) return;
    setDone(null);
    if (await undo.submit({ at: group.at, commit: group.commit })) {
      if (!undoPending.current)
        setDone(
          'The list below shows which files went back, and which stayed as they are and why.',
        );
      reload();
    }
  };
  const doBring = async (): Promise<void> => {
    const files = [...chosen].sort();
    if (!commit || !files.length || running) return;
    setDone(null);
    if (await bring.submit({ commit, files })) {
      // The files were sent: nothing stays ticked, so a second click sends nothing.
      setTicks({ commit, paths: new Set() });
      if (!pending.current)
        setDone(
          `Brought in ${files.length} ${files.length === 1 ? 'file' : 'files'}. ${files.length === 1 ? 'It is' : 'They are'} in your project folder now.`,
        );
      reload();
    }
  };

  const can = list ? list.files.filter((file) => file.out === null) : [];
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
          <a className="back" href={href.answer}>
            <Chevron to="left" />
            The answer
          </a>
          <div className="bring-head">
            <span className="bring-head__kind">Bring in</span>
            <h1 className="bring-head__title">{direction.title}</h1>
            <span className="bring-head__sub">
              {list
                ? `From ${list.branch} at ${list.commit.slice(0, 7)} into your project folder`
                : 'Into your project folder'}
            </span>
          </div>
          {work &&
            (work.error ? (
              <p role="alert" className="bring-note bring-note--need">
                {work.label} did not finish: {work.error}
              </p>
            ) : (
              <p role="status" className="bring-note">
                {work.label}…
              </p>
            ))}
          {readError && (
            <p role="alert" className="bring-note bring-note--need">
              {shown
                ? "Can't read the files again: "
                : "Can't read the files: "}
              {readError}
            </p>
          )}
          {!shown ? (
            !readError && <p className="more">Reading the files…</p>
          ) : list ? (
            <BringFiles
              lab={lab}
              list={list}
              agentName={agentName}
              chosen={chosen}
              onTick={tick}
              diffs={open}
              onDiff={toggleDiff}
              onLook={() => void doLook()}
              lookBusy={look.busy}
            />
          ) : lab.agentsHere ? (
            <>
              {shown.error && (
                <p role="alert" className="bring-note bring-note--need">
                  Verifold could not read the files of this direction:{' '}
                  {shown.error}
                </p>
              )}
              <p className="bring-text">
                Verifold commits the newest work of this direction first, so you
                see exactly the files that come in.
              </p>
              <div className="bring-actions">
                <button
                  type="button"
                  className="button button--primary"
                  disabled={look.busy}
                  onClick={() => void doLook()}
                >
                  Show its files
                </button>
              </div>
            </>
          ) : (
            <p className="bring-text">
              Run verifold in the project folder to bring in files.
            </p>
          )}
          {look.error && (
            <span role="alert" className="composer__error">
              {look.error}
            </span>
          )}
          {list && lab.agentsHere && can.length > 0 && (
            <>
              <div className="bring-actions">
                <button
                  type="button"
                  className="button button--primary"
                  disabled={running || chosen.size === 0}
                  onClick={() => void doBring()}
                >
                  Bring in the ticked files
                </button>
              </div>
              <p className="bring-text bring-text--fine">
                When a file changed in your project folder since this direction
                started, or since it came in, nothing comes in, and Verifold
                names the file.
              </p>
            </>
          )}
          {bring.error && (
            <span role="alert" className="composer__error">
              {bring.error}
            </span>
          )}
          {undo.error && (
            <span role="alert" className="composer__error">
              {undo.error}
            </span>
          )}
          {done && (
            <p role="status" className="bring-note bring-note--ok">
              {done}
            </p>
          )}
          {shown && (
            <BringHistory
              history={shown.history}
              undone={shown.undone ?? []}
              {...(lab.agentsHere
                ? { onUndo: (group: BringGroup) => void doUndo(group) }
                : {})}
              undoBusy={running}
            />
          )}
        </div>
      </main>
    </div>
  );
}
