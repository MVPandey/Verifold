import { useEffect, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import { messageOf } from '../api/client.ts';
import type { Api } from '../api/client.ts';
import type { NormsFile, NormsName, NormsView } from '../api/types.ts';
import { Markdown } from './Markdown.tsx';

/** The most characters that the server saves in a norms file. */
const MAX_NORMS = 100_000;

const TITLES: Readonly<Record<NormsName, string>> = {
  'LAB.md': 'How the agents work',
  'WRITING.md': 'How the lab writes its answer',
};

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
          ? 'These two files say how you want the agents to work. Each agent reads them when it starts. After you save a change, a post from you in the thread of the question tells the agents that the file changed.'
          : 'These two files say how you want the agents to work. The lab that you start gets them as they are here.'}{' '}
        Verifold itself tells the agents only how the board works.
      </p>
      {view ? (
        view.files.map((file) => (
          <NormsForm
            key={file.name}
            file={file}
            labOpen={props.labOpen}
            onSave={(text) =>
              api.saveNorms(file.name, text).then((saved) => {
                setView(saved);
                return saved.told;
              })
            }
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
 * `onSave` resolves to the post that told the agents, or `null` when no post went out.
 */
export function NormsForm(props: {
  readonly file: NormsFile;
  readonly labOpen: boolean;
  readonly onSave: (text: string) => Promise<string | null>;
  /** Whether the form starts with the text area open. */
  readonly editing?: boolean;
}): ReactElement {
  const { file } = props;
  const [draft, setDraft] = useState<string | null>(props.editing ? file.text : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const id = `norms-${file.name}`;

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (draft === null || saving) return;
    setSaving(true);
    setError(null);
    props.onSave(draft).then(
      (told) => {
        setSaving(false);
        setDraft(null);
        setDone(savedLine(props.labOpen, told));
      },
      (failure: unknown) => {
        setSaving(false);
        setError(messageOf(failure));
      },
    );
  };

  return (
    <section className="section norms-file" aria-labelledby={id}>
      <h2 id={id}>{TITLES[file.name]}</h2>
      <p className="sub">
        <code>{file.path}</code>
        {file.saved ? '' : ' does not exist yet. This is the text that a new lab gets.'}
      </p>
      {draft === null ? (
        <>
          <Markdown text={file.text} />
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

/** Return what the page says after a save: where the change went, and whether the agents heard of it. */
export function savedLine(labOpen: boolean, told: string | null): string {
  if (!labOpen) return 'Saved. The lab that you start gets this text.';
  if (told) return 'Saved. A post from you in the thread of the question tells the agents.';
  return 'Saved. No post went to the agents: the text is the same, or a post from you would open a lab that the agents closed.';
}
