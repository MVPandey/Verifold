import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import type { FileEvidence } from '../api/types.ts';
import type { Tone } from '../model/agents.ts';
import type { Chip } from '../model/posts.ts';
import { messageOf } from './hooks.ts';

/** An author's round avatar with their number. */
export function Avatar(props: {
  readonly mark: string;
  readonly tone: Tone;
  readonly size?: 'sm';
}): ReactElement {
  const classes = ['av', props.tone === 'cc' ? '' : props.tone, props.size ?? ''].filter(Boolean);
  return (
    <span className={classes.join(' ')} aria-hidden="true">
      {props.mark}
    </span>
  );
}

/** A colored chip, such as "Disputed". */
export function ChipView(props: { readonly chip: Chip }): ReactElement {
  return <span className={`chip ${props.chip.tone}`}>{props.chip.label}</span>;
}

/** Text that an agent or the person wrote, as paragraphs. It renders as text, never as HTML. */
export function Body(props: { readonly text: string }): ReactElement {
  const paragraphs = props.text.split(/\n\s*\n/).filter((paragraph) => paragraph.trim());
  return (
    <div className="body">
      {paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </div>
  );
}

/** The files that back a post, each with the commit that pins it. */
export function Files(props: { readonly files: readonly FileEvidence[] }): ReactElement | null {
  if (props.files.length === 0) return null;
  return (
    <div className="ev">
      {props.files.map((file) => (
        <span className="file" key={`${file.path}@${file.commit}`} title={file.commit}>
          {file.path} <code>{file.commit.slice(0, 7)}</code>
        </span>
      ))}
    </div>
  );
}

/** The box where the person writes to the agents. */
export function Composer(props: {
  readonly to: string;
  readonly placeholder: string;
  readonly hint?: string;
  readonly onSend: (text: string) => Promise<void>;
}): ReactElement {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    props.onSend(text).then(
      () => {
        setText('');
        setSending(false);
      },
      (failure: unknown) => {
        setError(messageOf(failure));
        setSending(false);
      },
    );
  };

  return (
    <form className="composer" onSubmit={send}>
      <div className="box">
        <div className="to">
          To <span className="tolabel">{props.to}</span>
        </div>
        <textarea
          aria-label={`Message to ${props.to}`}
          placeholder={props.placeholder}
          value={text}
          rows={1}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send(event);
          }}
        />
        <button className="btn small primary" type="submit" disabled={!text.trim() || sending}>
          {sending ? 'Sending' : 'Send'}
        </button>
      </div>
      {error ? (
        <p className="hint error" role="alert">
          {error}
        </p>
      ) : props.hint ? (
        <p className="hint">{props.hint}</p>
      ) : null}
    </form>
  );
}
