import { useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import type { FileEvidence, PermissionShown, Post, QuestionShown } from '../api/types.ts';
import type { Face } from '../model/agents.ts';
import type { Chip } from '../model/posts.ts';
import { href } from '../model/route.ts';
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
  const cross = props.post.kind === 'ruled_out' ? ' fk-ruled_out' : '';
  return <span className={`f-mark fm-${tone(props.post)}${cross}`} aria-hidden="true" />;
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

/**
 * Text that a harness or an agent controls, exactly as Verifold recorded it, in a box of its own with a label.
 *
 * It is preformatted text: every space and line break shows, nothing is collapsed, and it never goes through
 * paragraphs or Markdown. So no line of it can stand beside Verifold's own sentences as one of them.
 */
export function Exact(props: { readonly label: string; readonly text: string }): ReactElement {
  return (
    <figure className="exact">
      <figcaption>{props.label}</figcaption>
      <pre>{props.text}</pre>
    </figure>
  );
}

/**
 * A request of an agent's harness, from the data that Verifold recorded on the ask.
 *
 * The app writes every sentence here. The harness's text shows only inside `Exact` boxes.
 */
export function HarnessAsk(props: {
  readonly shown: PermissionShown | QuestionShown;
  /** The agent's name. */
  readonly name: string;
}): ReactElement {
  const { shown, name } = props;
  if (shown.type === 'question') return <QuestionAsk shown={shown} name={name} />;
  const long = shown.notes.includes('too_long');
  const cut = ' The rest is cut.';
  return (
    <div className="hask">
      {long ? (
        <p className="says">
          Verifold refused this request, because it is too long to show whole (
          {shown.size.toLocaleString('en-US')} characters), and you cannot allow what you cannot
          read. Nothing ran. An answer here allows nothing.
        </p>
      ) : null}
      {shown.notes.includes('unclear') ? (
        <p className="says">
          Your last answer picked none of the answers, so the request still waits. {name} can read
          your words.
        </p>
      ) : null}
      {shown.notes.includes('refused') ? (
        <p className="says">
          Verifold refused this at once, as your settings say, so {name} goes on. Your answer
          applies when {name} asks for the same again within an hour.
        </p>
      ) : null}
      {shown.command === null ? null : (
        <Exact
          label={
            long
              ? `The start of the command.${cut}`
              : `The command, exactly as the harness of ${name} sent it`
          }
          text={shown.command}
        />
      )}
      {shown.command === null && shown.title ? (
        <Exact label="The harness’s name for the request" text={shown.title} />
      ) : null}
      {shown.given ? (
        <Exact
          label={
            shown.command === null
              ? long
                ? `The start of the request.${cut}`
                : 'The request, as the harness reports it'
              : 'What the request holds beside the command'
          }
          text={shown.given}
        />
      ) : null}
      {shown.answers.length > 0 ? (
        <Exact
          label="Every answer that the harness offers. To pick one that has no button, write its whole name."
          text={shown.answers.join('\n')}
        />
      ) : null}
      {shown.grant === null ? null : (
        <p className="says">
          With the grant, this command runs once, and every agent can run a command that starts with{' '}
          <code>{shown.grant}</code> and has plain arguments. A grant names a command, not what a
          file holds: give it only for a command that the agents may change.
        </p>
      )}
      {shown.remembered.length > 0 ? (
        <>
          <p className="says">
            Some answers are the harness’s own. The harness remembers such an answer beyond this
            lab, and Verifold cannot show it or undo it later.
          </p>
          <Exact label="The harness’s own answers" text={shown.remembered.join('\n')} />
        </>
      ) : null}
    </div>
  );
}

function QuestionAsk(props: {
  readonly shown: QuestionShown;
  readonly name: string;
}): ReactElement {
  const { shown, name } = props;
  const hint = {
    text: null,
    boolean: null,
    choice: null,
    choices: 'Name each option that you choose, with commas between them.',
    number: 'Answer with a number.',
    integer: 'Answer with a whole number.',
  }[shown.kind];
  return (
    <div className="hask question">
      <p className="says">
        This is a question from the harness of {name}, not a permission request. No answer here
        allows a command.
        {shown.parts > 1 ? ` It is part ${shown.part} of ${shown.parts}.` : ''}
      </p>
      {shown.message ? (
        <Exact label="The question, as the harness wrote it" text={shown.message} />
      ) : null}
      {shown.field ? <Exact label="The field" text={shown.field} /> : null}
      {shown.description ? <Exact label="Its description" text={shown.description} /> : null}
      {shown.options.length > 0 ? (
        <Exact label="The options" text={shown.options.join('\n')} />
      ) : null}
      {hint ? <p className="says">{hint}</p> : null}
      {shown.optional ? (
        <p className="says">
          The harness does not need this answer. To leave it out, answer “skip”.
        </p>
      ) : null}
    </div>
  );
}

/** The files that back a post, each with the commit that pins it. A file opens as a page. */
export function Files(props: {
  readonly post: string;
  readonly files: readonly FileEvidence[];
}): ReactElement | null {
  if (props.files.length === 0) return null;
  return (
    <div className="files">
      {props.files.map((file) => (
        <a
          className="file"
          key={`${file.path}@${file.commit}`}
          title={file.commit}
          href={href({ page: 'file', post: props.post, path: file.path })}
        >
          {file.path} <code>{file.commit.slice(0, 7)}</code>
        </a>
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
