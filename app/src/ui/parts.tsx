import { useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import type { FileEvidence, Post } from '../api/types.ts';
import type { Face } from '../model/agents.ts';
import type { Chip } from '../model/posts.ts';
import { tone } from '../model/turns.ts';
import { messageOf } from '../api/client.ts';

/**
 * An author's face: two letters on the member's color, or a dashed circle for a blind rerun.
 *
 * `alone` gives the face its name for a screen reader, for the places that show no name beside it. `ghost` is
 * the small faint face of an author who posted before the latest one.
 */
export function FaceView(props: {
  readonly face: Face;
  readonly alone?: boolean;
  readonly ghost?: boolean;
}): ReactElement {
  const { kind, color, initials, name } = props.face;
  const classes = `f-face ${kind === 'member' ? `m${color}` : kind}${props.ghost ? ' ghost' : ''}`;
  return props.alone ? (
    <span className={classes} role="img" aria-label={name} title={name}>
      {initials}
    </span>
  ) : (
    <span className={classes} aria-hidden="true">
      {initials}
    </span>
  );
}

/** The mark for a turn's kind. The act line beside it says the same in words. */
export function Mark(props: { readonly post: Post }): ReactElement {
  return (
    <span className={`f-mark fm-${tone(props.post)} fk-${props.post.kind}`} aria-hidden="true" />
  );
}

/** A status, such as "Disputed". */
export function ChipView(props: { readonly chip: Chip }): ReactElement {
  return <span className={`f-st fs-${props.chip.tone}`}>{props.chip.label}</span>;
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
    <div className="files">
      {props.files.map((file) => (
        <span className="file" key={`${file.path}@${file.commit}`} title={file.commit}>
          {file.path} <code>{file.commit.slice(0, 7)}</code>
        </span>
      ))}
    </div>
  );
}

/**
 * The box where the person writes to the agents. The first line is the headline and the rest is the detail.
 *
 * `steer` is the box at the top of the lab, with its heading. `reply` is the one-line box under a thread.
 */
export function Composer(props: {
  readonly variant: 'steer' | 'reply';
  readonly label: string;
  readonly placeholder: string;
  readonly button: string;
  readonly hint: string;
  readonly onSend: (text: string) => Promise<void>;
}): ReactElement {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const steer = props.variant === 'steer';

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

  const box = (
    <textarea
      id={id}
      aria-label={steer ? undefined : props.label}
      placeholder={props.placeholder}
      value={text}
      rows={steer ? 3 : 1}
      onChange={(event) => {
        setText(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send(event);
      }}
    />
  );
  const button = (
    <button type="submit" disabled={!text.trim() || sending}>
      {sending ? 'Sending' : props.button}
    </button>
  );
  const note = error ? (
    <span className="error" role="alert">
      {error}
    </span>
  ) : (
    <span>{props.hint}</span>
  );
  return steer ? (
    <form className="f-steer-form" onSubmit={send}>
      <label htmlFor={id}>{props.label}</label>
      {box}
      <div className="f-steer-row">
        {note}
        {button}
      </div>
    </form>
  ) : (
    <form className="f-reply" onSubmit={send}>
      <div className="f-reply-row">
        {box}
        {button}
      </div>
      <p className="f-reply-note">{note}</p>
    </form>
  );
}
