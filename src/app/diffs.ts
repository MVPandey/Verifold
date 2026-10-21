import type { FileDiff } from '../protocol/api.ts';
import type { Loaded } from './api.ts';

/** A file's diff on a bring-in page: being read, read, or why not. */
export type DiffShown = Loaded<FileDiff> | 'loading';

/** Why a diff that Verifold sent does not show. */
export const otherWork =
  'This is the diff of other work, so it does not show here.';

/**
 * The diffs that the person opens on a bring-in page: each is one file's
 * diff at the commit that the page shows. The person may tick a file that
 * runs code because its diff looks right, so a diff of other work never
 * shows. When the page moves to another commit, the reads of the old one
 * stop and its diffs close. A diff that Verifold made at another commit
 * than the one asked for shows as an error.
 */
export class DiffReads {
  private readonly read: (
    path: string,
    commit: string,
    signal: AbortSignal,
  ) => Promise<Loaded<FileDiff>>;
  private readonly show: (
    commit: string | null,
    shown: ReadonlyMap<string, DiffShown>,
  ) => void;
  private commit: string | null = null;
  private shown: ReadonlyMap<string, DiffShown> = new Map();
  /** The read of each diff that is being read, by path. */
  private readonly reads = new Map<string, AbortController>();

  constructor(
    read: (
      path: string,
      commit: string,
      signal: AbortSignal,
    ) => Promise<Loaded<FileDiff>>,
    show: (
      commit: string | null,
      shown: ReadonlyMap<string, DiffShown>,
    ) => void,
  ) {
    this.read = read;
    this.show = show;
  }

  /** The page shows the files at `commit`: the diffs of another commit close, and their reads stop. */
  at(commit: string | null): void {
    if (commit === this.commit) return;
    this.stop();
    this.commit = commit;
    this.set(new Map());
  }

  /** Open a file's diff at `commit`, or close it when it is open. */
  toggle(commit: string, path: string): void {
    this.at(commit);
    this.reads.get(path)?.abort();
    this.reads.delete(path);
    if (this.shown.has(path)) {
      const next = new Map(this.shown);
      next.delete(path);
      this.set(next);
      return;
    }
    const controller = new AbortController();
    this.reads.set(path, controller);
    this.set(new Map(this.shown).set(path, 'loading'));
    void this.read(path, commit, controller.signal).then((result) => {
      // A read that stopped is of a diff that closed, or of other work.
      if (controller.signal.aborted) return;
      this.reads.delete(path);
      this.set(
        new Map(this.shown).set(
          path,
          'value' in result && result.value.commit !== commit
            ? { error: otherWork }
            : result,
        ),
      );
    });
  }

  /** Stop every read, as when the page closes. */
  stop(): void {
    for (const controller of this.reads.values()) controller.abort();
    this.reads.clear();
  }

  private set(shown: ReadonlyMap<string, DiffShown>): void {
    this.shown = shown;
    this.show(this.commit, shown);
  }
}
