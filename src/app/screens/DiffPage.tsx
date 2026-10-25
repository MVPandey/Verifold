import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  Direction,
  DirectionDiff,
  Lab,
  Snapshot,
} from '../../protocol/api.ts';
import { ControlsContext } from '../controls.ts';
import { href } from '../route.ts';
import type { Connection } from '../store.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { Chevron } from '../components/Icons.tsx';
import type { LabActions } from './LabHome.tsx';

/** A file's diff on the page: being read, read at a commit, or why not. */
type FileShown =
  | 'loading'
  | {
      readonly text: string;
      readonly trimmed: boolean;
      readonly to: string;
    }
  | { readonly error: string };

const changes = {
  added: 'Added',
  modified: 'Changed',
  deleted: 'Deleted',
} as const;

/** The kind of a diff line, for its color: added, removed, a hunk's head, or neither. */
export type LineKind = 'add' | 'del' | 'hunk' | null;

/**
 * The kind of each line of a diff. `---` and `+++` name the files only in a
 * file's header, before its first hunk. In a hunk, they are a removed line
 * that starts with `--` and an added line that starts with `++`.
 */
export function lineKinds(lines: readonly string[]): readonly LineKind[] {
  let header = true;
  return lines.map((line) => {
    if (line.startsWith('diff --git ')) header = true;
    else if (line.startsWith('@@')) {
      header = false;
      return 'hunk';
    }
    if (header) return null;
    if (line.startsWith('+')) return 'add';
    if (line.startsWith('-')) return 'del';
    return null;
  });
}

/** A file's diff, with added and removed lines marked. */
export function DiffText({
  text,
  trimmed,
}: {
  readonly text: string;
  readonly trimmed: boolean;
}): ReactNode {
  const lines = text.split('\n');
  const kinds = lineKinds(lines);
  return (
    <>
      <pre className="diff-text">
        {lines.map((line, index) => {
          const kind = kinds[index] ?? null;
          return (
            <span
              key={index}
              className={kind ? `diff-line diff-line--${kind}` : 'diff-line'}
            >
              {line || ' '}
              {'\n'}
            </span>
          );
        })}
      </pre>
      {trimmed && (
        <p className="muted run-fine">
          This diff is long, so Verifold shows only its start.
        </p>
      )}
    </>
  );
}

/**
 * What a direction changed since it started, file by file, at its newest
 * commit. With `proof`, such as p-12.0, the diff that a post cites instead.
 * A file opens to its diff. The list is read again when the direction's
 * newest commit moves, and then each open diff too. A diff at another
 * commit than the list says so, with a way to read it again.
 */
export function DiffPage({
  snapshot,
  lab,
  direction,
  proof = null,
  connection,
  now,
  actions,
}: {
  readonly snapshot: Snapshot;
  readonly lab: Lab;
  readonly direction: Direction;
  readonly proof?: string | null;
  readonly connection: Connection;
  readonly now: number;
  readonly actions: LabActions;
}): ReactNode {
  const controls = useContext(ControlsContext);
  const [list, setList] = useState<DirectionDiff | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlyMap<string, FileShown>>(
    () => new Map(),
  );
  // The read of each file's diff that is under way, by path.
  const reads = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const pending = reads.current;
    return () => {
      for (const controller of pending.values()) controller.abort();
    };
  }, []);
  // A proof's diff does not move. A direction's diff moves with its newest commit.
  const head = proof ? null : direction.head;
  const query = useMemo(() => (proof ? { proof } : {}), [proof]);
  useEffect(() => {
    if (!controls) return;
    const controller = new AbortController();
    void controls
      .diff(direction.id, query, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        if ('error' in loaded) setProblem(loaded.error);
        else {
          setList(loaded.value);
          setProblem(null);
        }
      });
    return () => controller.abort();
  }, [controls, direction.id, query, head]);
  /**
   * Read a file's diff. With `keep`, the diff on the page stays until the
   * new one comes, and stays when the read fails: its note offers to read
   * it again.
   */
  const read = (path: string, keep = false): void => {
    if (!controls) return;
    reads.current.get(path)?.abort();
    const controller = new AbortController();
    reads.current.set(path, controller);
    if (!keep) setOpen((current) => new Map(current).set(path, 'loading'));
    void controls
      .diff(direction.id, { ...query, file: path }, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        reads.current.delete(path);
        if (keep && 'error' in loaded) return;
        const shown: FileShown =
          'error' in loaded
            ? { error: loaded.error }
            : loaded.value.diff
              ? { ...loaded.value.diff, to: loaded.value.to }
              : { error: 'Verifold has no diff for this file.' };
        setOpen((current) =>
          current.has(path) ? new Map(current).set(path, shown) : current,
        );
      });
  };
  const toggle = (path: string): void => {
    if (!open.has(path)) {
      read(path);
      return;
    }
    reads.current.get(path)?.abort();
    reads.current.delete(path);
    setOpen((current) => {
      const next = new Map(current);
      next.delete(path);
      return next;
    });
  };
  // When the list moves to a new commit, each open diff of a file on it is read again.
  const listAt = list?.to ?? null;
  useEffect(() => {
    if (!list) return;
    for (const [path, shown] of open)
      if (
        typeof shown === 'object' &&
        'text' in shown &&
        shown.to !== list.to &&
        list.files.some((file) => file.path === path)
      )
        read(path, true);
    // Only a move of the list reads the open diffs again.
  }, [listAt]);
  const post = proof?.split('.')[0];
  return (
    <div className="page">
      <AppHeader
        project={snapshot.project}
        own={snapshot.ownProfile === true}
        lab={lab}
        now={now}
        onPause={actions.pause}
      />
      <main className="main">
        <div className="column column--detail">
          <ConnectionBar connection={connection} at={snapshot.at} />
          <a className="back" href={href.direction(direction.id)}>
            <Chevron to="left" />
            {direction.title}
          </a>
          <div className="direction-head">
            <h1 className="page-title">
              {post ? `The diff that ${post} cites` : 'Files and changes'}
            </h1>
            <p className="direction-head__meta">
              {post ? (
                <>
                  The changes that <a href={href.post(post)}>{post}</a> points
                  to as proof.
                </>
              ) : (
                'What this direction changed since it started.'
              )}
              {list &&
                ` From ${list.from.slice(0, 7)} to ${list.to.slice(0, 7)}.`}
            </p>
          </div>
          {!list && !problem && (
            <p className="turns__none">
              {controls
                ? 'Reading the changes…'
                : 'Open this page from Verifold to read its changes.'}
            </p>
          )}
          {problem && (
            <p
              role={list ? 'status' : 'alert'}
              className={list ? 'steps__problem' : 'composer__error'}
            >
              {list ? `Can't refresh the changes: ${problem}` : problem}
            </p>
          )}
          {list && list.files.length === 0 && (
            <p className="turns__none">No changed files yet.</p>
          )}
          {list && list.files.length > 0 && (
            <ul className="diff-files" aria-label="Changed files">
              {list.files.map((file) => {
                const shown = open.get(file.path);
                return (
                  <li key={file.path} className="diff-file">
                    <button
                      type="button"
                      className="diff-file__button"
                      aria-expanded={shown !== undefined}
                      disabled={!file.regular}
                      onClick={() => toggle(file.path)}
                    >
                      <Chevron to={shown ? 'down' : 'right'} size={14} />
                      <span
                        className={`diff-file__change diff-file__change--${file.change}`}
                      >
                        {changes[file.change]}
                      </span>
                      <span className="diff-file__path mono">{file.path}</span>
                    </button>
                    {!file.regular && (
                      <p className="muted run-fine">
                        A link or a submodule, so there is no text to show.
                      </p>
                    )}
                    {shown === 'loading' && (
                      <p className="muted run-fine">Reading the diff…</p>
                    )}
                    {shown && shown !== 'loading' && 'error' in shown && (
                      <p role="alert" className="composer__error">
                        {shown.error}
                      </p>
                    )}
                    {shown && shown !== 'loading' && 'text' in shown && (
                      <>
                        <DiffText text={shown.text} trimmed={shown.trimmed} />
                        {shown.to !== list.to && (
                          <p className="muted run-fine">
                            This diff is at {shown.to.slice(0, 7)}, and the list
                            at {list.to.slice(0, 7)}.{' '}
                            <button
                              type="button"
                              className="link-button"
                              onClick={() => read(file.path)}
                            >
                              Read it again
                            </button>
                          </p>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {list && list.moreFiles > 0 && (
            <span className="more">
              {list.moreFiles} more changed{' '}
              {list.moreFiles === 1 ? 'file is' : 'files are'} not listed.
            </span>
          )}
        </div>
      </main>
    </div>
  );
}
