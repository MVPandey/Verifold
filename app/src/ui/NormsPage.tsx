import { useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import { ApiError, messageOf } from '../api/client.ts';
import type { Api } from '../api/client.ts';
import type { NoPost, NormsFile, NormsName, NormsView } from '../api/types.ts';
import { dayClock } from '../model/format.ts';
import { Markdown } from './Markdown.tsx';

/** The most characters that the server saves in a norms file. */
const MAX_NORMS = 100_000;

const TITLES: Readonly<Record<NormsName, string>> = {
  'LAB.md': 'How the agents work',
  'WRITING.md': 'How the lab writes its answer',
};

/** What a save tells the page: the post that told the agents, or why no post went out. */
export interface Saved {
  readonly told: string | null;
  readonly noPost: NoPost | null;
}

/**
 * The lab's norms: the two files that tell the agents how the person wants the work done. Verifold's own text
 * for agents holds facts about the board, and these files hold everything else, so the person reads and changes
 * here what the agents are asked to do.
 */
export function NormsPage(props: { readonly api: Api; readonly labOpen: boolean }): ReactElement {
  const { api } = props;
  const [view, setView] = useState<NormsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.norms().then(setView, (failure: unknown) => setError(messageOf(failure)));
  }, [api]);

  return (
    <div className="narrow setup norms">
      <h1>Norms</h1>
      <p className="sub">
        {props.labOpen
          ? 'These two files say how you want the agents to work. Each agent reads them when it starts. When you save a change here, a post from you in the thread of the question tells the agents that the file changed. An agent that is on call does not hear that post.'
          : 'These two files say how you want the agents to work. The lab that you start gets them as they are here.'}{' '}
        Verifold itself tells the agents only how the board works.
      </p>
      {view ? (
        view.files.map((file) => (
          <NormsForm
            key={file.name}
            file={file}
            now={new Date()}
            onSave={(text) =>
              api.saveNorms(file.name, text, file.revision).then((saved) => {
                setView(saved);
                return { told: saved.told, noPost: saved.no_post };
              })
            }
            onStale={() => api.norms().then(setView)}
          />
        ))
      ) : error ? null : (
        <p className="quiet">Loading the norms.</p>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * One norms file: its text as a page, and Edit. Edit shows the text in a plain text area with Save and Cancel.
 *
 * `onSave` rejects with status 409 when the file changed since the page read it. The form then asks for the file
 * again with `onStale`, keeps the person's draft, and shows the newer text beside it.
 */
export function NormsForm(props: {
  readonly file: NormsFile;
  readonly now: Date;
  readonly onSave: (text: string) => Promise<Saved>;
  readonly onStale: () => Promise<void>;
  /** The text that the text area starts with, when the form starts open. */
  readonly draft?: string;
  /** Whether the form starts after a save that the server refused because the file had changed. */
  readonly stale?: boolean;
}): ReactElement {
  const { file } = props;
  const [draft, setDraft] = useState<string | null>(props.draft ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(props.stale ?? false);
  const [done, setDone] = useState<string | null>(null);
  const id = `norms-${file.name}`;

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (draft === null || saving) return;
    setSaving(true);
    setError(null);
    props.onSave(draft).then(
      (saved) => {
        setSaving(false);
        setStale(false);
        setDraft(null);
        setDone(savedLine(saved));
      },
      (failure: unknown) => {
        setSaving(false);
        if (!(failure instanceof ApiError && failure.status === 409)) {
          setError(messageOf(failure));
          return;
        }
        // The file changed since the page read it. The draft stays, and the newer text shows beside it.
        setStale(true);
        props.onStale().catch((reading: unknown) => setError(messageOf(reading)));
      },
    );
  };

  return (
    <section className="section norms-file" aria-labelledby={id}>
      <h2 id={id}>{TITLES[file.name]}</h2>
      <p className="sub">
        <code>{file.path}</code> {changedLine(file, props.now)}
      </p>
      {file.error ? (
        <p className="error" role="alert">
          {file.error} Verifold shows and saves this file only when it is a regular text file.
        </p>
      ) : draft === null ? (
        <>
          <Markdown text={file.text} />
          <Missing file={file} />
          <p className="norms-row">
            <button
              type="button"
              className="btn"
              onClick={() => {
                setDraft(file.text);
                setDone(null);
              }}
            >
              Edit
            </button>
            {done ? <span role="status">{done}</span> : null}
          </p>
        </>
      ) : (
        <form onSubmit={save}>
          {stale ? (
            <div role="alert">
              <p className="error">
                The file changed after you opened it, so nothing was saved. This is the text that
                the file has now. Your text is below. Save puts your text in place of this one.
              </p>
              <pre className="norms-newer">{file.text}</pre>
            </div>
          ) : null}
          <label htmlFor={`${id}-text`}>The text of {file.name}, in Markdown</label>
          <textarea
            id={`${id}-text`}
            className="norms-text"
            value={draft}
            rows={24}
            maxLength={MAX_NORMS}
            spellCheck
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
          <p className="norms-row">
            <span className={error ? 'error' : undefined} role={error ? 'alert' : undefined}>
              {error ?? ''}
            </span>
            <button
              type="button"
              className="linkbtn"
              onClick={() => {
                setDraft(null);
                setStale(false);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="btn" disabled={saving || draft === file.text}>
              {saving ? 'Saving' : 'Save'}
            </button>
          </p>
        </form>
      )}
    </section>
  );
}

/** The lines of the current default norms that the file lacks, folded, as text to read and copy. */
function Missing(props: { readonly file: NormsFile }): ReactElement | null {
  const count = props.file.missing.length;
  if (count === 0) return null;
  return (
    <details className="norms-missing">
      <summary className="f-open">
        The default norms have {count} {count === 1 ? 'line' : 'lines'} that this file does not
        have. <span className="closed">Show them</span>
        <span className="opened">Hide them</span>
      </summary>
      <p className="sub">Verifold does not add them. Copy the ones that you want into the file.</p>
      <pre>{props.file.missing.join('\n')}</pre>
    </details>
  );
}

/** Return what the page says about a file's last change: when it was, and who made it when the server knows. */
export function changedLine(file: NormsFile, now: Date): string {
  if (file.error) return '';
  if (!file.saved || file.changed_at === null) {
    return 'does not exist yet. This is the text that a new lab gets.';
  }
  const when = `Last changed ${dayClock(file.changed_at, now)}`;
  if (file.changed_by === 'page') return `${when}, from this page.`;
  if (file.changed_by === 'outside') return `${when}. Changed outside this page.`;
  return `${when}.`;
}

/** Return what the page says after a save: whether a post told the agents, or the reason why none went out. */
export function savedLine(saved: Saved): string {
  switch (saved.noPost) {
    case null:
      return saved.told
        ? 'Saved. A post from you in the thread of the question tells the agents that are not on call.'
        : 'Saved.';
    case 'same':
      return 'The file has this text already, so nothing changed.';
    case 'no_lab':
      return 'Saved. The lab that you start gets this text.';
    case 'no_thread':
      return 'Saved. This lab has no thread for the question, so no post went to the agents.';
    case 'close':
      return 'Saved. No post went to the agents: a close stands, and a post from you would open the lab again.';
    case 'told_already':
      return 'Saved. A post told the agents of a change less than a minute ago, so no other post went out.';
    case 'refused':
      return 'Saved. The board did not take the post that tells the agents.';
  }
}
