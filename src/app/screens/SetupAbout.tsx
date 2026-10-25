import { useId, useRef, useState, type ReactNode } from 'react';
import type {
  ChatLine,
  ProfileCard,
  SetupAbout,
  SetupStep,
  SetupView,
} from '../../protocol/api.ts';
import { Avatar, type Who } from '../components/Avatar.tsx';
import {
  BackButton,
  StepHeader,
  useUnsaved,
} from '../components/StepHeader.tsx';
import { harnessName, since } from '../format.ts';
import { afterSend } from '../intent.ts';
import type { SetupActions } from '../setup.ts';
import { useAction } from '../useAction.ts';

const fieldNames: readonly {
  readonly field: keyof ProfileCard;
  readonly label: string;
}[] = [
  { field: 'workOn', label: 'You work on' },
  { field: 'explore', label: 'To explore' },
  { field: 'talk', label: 'Talk to me' },
];

function sameCard(a: ProfileCard, b: ProfileCard): boolean {
  return a.workOn === b.workOn && a.explore === b.explore && a.talk === b.talk;
}

function speaker(from: ChatLine['from']): { who: Who; name: string } {
  if (from === 'you') return { who: 'person', name: 'You' };
  if (from === 'verifold') return { who: 'verifold', name: 'Verifold' };
  return {
    who: { harness: from, handle: harnessName(from) },
    name: harnessName(from),
  };
}

/** One line of the conversation, with its suggested answers as chips. */
function Line({
  line,
  picks,
  onPick,
}: {
  readonly line: ChatLine;
  /** The chips show only under the question that waits for an answer. */
  readonly picks: boolean;
  readonly onPick: (answer: string) => void;
}): ReactNode {
  const { who, name } = speaker(line.from);
  return (
    <div className="chat__line">
      <Avatar who={who} size="lg" />
      <div className="chat__body">
        <b className="chat__name">{name}</b>
        <span className={line.from === 'you' ? 'chat__text' : 'chat__question'}>
          {line.text}
        </span>
        {picks && line.suggestions.length > 0 && (
          <div role="group" aria-label="Suggested answers" className="chips">
            {line.suggestions.map((answer) => (
              <button
                key={answer}
                type="button"
                className="choice-chip"
                onClick={() => onPick(answer)}
              >
                {answer}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The card to review, as in the artboard: three fields that the person can edit in place. */
function CardView({
  card,
  limits,
  editing,
  onEdit,
  onChange,
}: {
  readonly card: ProfileCard;
  readonly limits: SetupAbout['limits'];
  readonly editing: boolean;
  readonly onEdit: () => void;
  readonly onChange: (card: ProfileCard) => void;
}): ReactNode {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-title`} className="profile">
      <div className="profile__head">
        <h2 id={`${id}-title`} className="profile__title">
          Your profile
        </h2>
        <button type="button" className="button button--small" onClick={onEdit}>
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>
      <dl className="profile__fields">
        {fieldNames.map(({ field, label }) => (
          <div key={field} className="profile__field">
            <dt>
              {editing ? (
                <label htmlFor={`${id}-${field}`}>{label}</label>
              ) : (
                label
              )}
            </dt>
            <dd>
              {editing ? (
                <textarea
                  id={`${id}-${field}`}
                  className="profile__input"
                  rows={2}
                  maxLength={limits[field]}
                  value={card[field]}
                  onChange={(event) =>
                    onChange({ ...card, [field]: event.target.value })
                  }
                />
              ) : (
                card[field] || <span className="muted">Not set</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <span className="profile__note">
        The planner of each project reads all of it. The other agents, and the
        checkers, get only “Talk to me”, so they don’t lean toward your views.
      </span>
    </section>
  );
}

/**
 * Step 2, as in the artboard "2 About you": one question from Verifold, up
 * to two from the person's agent, then a card that the person edits, or
 * changes with a note, before saving it.
 */
export function AboutStep({
  view,
  actions,
  refresh,
  onSaved,
  onBack,
  onOpen,
  onUnsaved,
}: {
  readonly view: SetupView;
  readonly actions: SetupActions;
  readonly refresh: () => void;
  readonly onSaved: () => void;
  readonly onBack: () => void;
  readonly onOpen: (step: SetupStep) => void;
  readonly onUnsaved: (unsaved: boolean) => void;
}): ReactNode {
  const about = view.about;
  const box = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  // The person's edits of the card, until the agent sends another one.
  const [edits, setEdits] = useState<{
    readonly from: ProfileCard;
    readonly card: ProfileCard;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  // The person chose to write a new profile over one in free form.
  const [fresh, setFresh] = useState(false);
  // Each read brings a new object, so the cards compare by their fields.
  const edited =
    edits !== null && about.card !== null && sameCard(edits.from, about.card);
  const card = edited ? edits.card : about.card;
  // A typed answer, or card edits that are not saved.
  useUnsaved(
    text.trim() !== '' || (edited && !sameCard(edits.card, edits.from)),
    onUnsaved,
  );
  const say = useAction((value: string, key) =>
    actions.say(value, edited ? card : null, key),
  );
  const retry = useAction((_: null, key) => actions.retry(key));
  const fill = useAction((_: null, key) => actions.fill(key));
  const restart = useAction((_: null, key) => actions.restart(key));
  const save = useAction((value: ProfileCard | null, key) =>
    actions.about(value, key),
  );
  const skip = useAction((_: null, key) => actions.skip('about', key));
  const error =
    say.error ??
    retry.error ??
    fill.error ??
    restart.error ??
    save.error ??
    skip.error;
  const after =
    (run: { submit: (value: null) => Promise<boolean> }) => (): void =>
      void run.submit(null).then((ok) => ok && refresh());
  // A card, saved or drafted, can also be replaced by a new conversation.
  const started = about.lines.length > 1 || about.card !== null;
  if (about.saved === 'text' && about.text && !started && !fresh)
    return (
      <>
        <StepHeader
          step="about"
          steps={view.steps}
          onOpen={onOpen}
          title="About you"
        />
        <section aria-label="Your profile" className="profile">
          <h2 className="profile__title">
            Your profile from an earlier version
          </h2>
          <p className="profile__text">{about.text}</p>
          <span className="profile__note">
            The planner of each project reads all of it. The other agents get
            none of it.
          </span>
        </section>
        {error && (
          <span role="alert" className="setup__error">
            {error}
          </span>
        )}
        <div className="setup__actions">
          <BackButton onBack={onBack} />
          <button
            type="button"
            className="button button--primary button--big"
            disabled={save.busy}
            onClick={() => void save.submit(null).then((ok) => ok && onSaved())}
          >
            Keep it
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => setFresh(true)}
          >
            Write a new one. Saving it replaces this text.
          </button>
        </div>
      </>
    );
  const waiting = about.lines.at(-1);
  const picks =
    !card && !about.busy && waiting !== undefined && waiting.from !== 'you';
  const send = async (): Promise<void> => {
    const sent = text;
    const value = sent.trim();
    if (!value || say.busy || about.busy) return;
    if (await say.submit(value)) {
      setText((current) => afterSend(current, sent));
      setEdits(null);
      setEditing(false);
      refresh();
    }
  };
  // Without an agent, a note cannot change the card: the person edits it instead.
  const noteBox = card !== null && about.harness !== null;
  return (
    <>
      <StepHeader
        step="about"
        steps={view.steps}
        onOpen={onOpen}
        title="About you"
      />
      <section aria-label="Conversation" className="chat">
        {about.lines.map((line, index) => (
          <Line
            key={index}
            line={line}
            picks={picks && index === about.lines.length - 1}
            onPick={(answer) => {
              setText(answer);
              input.current?.focus();
            }}
          />
        ))}
        {about.busy && (
          <div className="chat__busy" role="status">
            <span className="dot" aria-hidden="true" />
            {about.harness ? harnessName(about.harness) : 'Verifold'} is writing
            · {since(about.busy, Date.now())}
          </div>
        )}
      </section>
      {about.error && !about.busy && (
        <div className="setup__problem">
          <span role="alert">{about.error}</span>
          <div className="setup__row">
            <button
              type="button"
              className="button button--small"
              disabled={retry.busy}
              onClick={after(retry)}
            >
              Try again
            </button>
            <button
              type="button"
              className="button button--small"
              disabled={fill.busy}
              onClick={after(fill)}
            >
              Fill the card from my answers
            </button>
          </div>
        </div>
      )}
      {card && (
        <CardView
          card={card}
          limits={about.limits}
          editing={editing}
          onEdit={() => setEditing((now) => !now)}
          onChange={(next) =>
            about.card && setEdits({ from: about.card, card: next })
          }
        />
      )}
      {(!card || noteBox) && (
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <div className="composer__box composer__box--setup">
            <label htmlFor={box} className="visually-hidden">
              {card ? 'Add anything else' : 'Your answer'}
            </label>
            <textarea
              id={box}
              ref={input}
              className="composer__input composer__input--setup"
              rows={card ? 1 : 2}
              maxLength={about.limits.answer}
              placeholder={
                card
                  ? 'Add anything else, in your own words'
                  : 'Answer in your own words'
              }
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <button
              type="submit"
              className="button button--outline"
              disabled={say.busy || about.busy !== null}
            >
              Send
            </button>
          </div>
        </form>
      )}
      {card && about.harness === null && (
        <p className="setup__line muted">
          No agent is signed in, so edit the card to change it.
        </p>
      )}
      {error && (
        <span role="alert" className="setup__error">
          {error}
        </span>
      )}
      <div className="setup__actions">
        <BackButton onBack={onBack} />
        {card && (
          <button
            type="button"
            className="button button--primary button--big"
            disabled={save.busy || about.busy !== null}
            onClick={() =>
              void save.submit(card).then((ok) => {
                if (!ok) return;
                setEdits(null);
                onSaved();
              })
            }
          >
            Looks right
          </button>
        )}
        <button
          type="button"
          className="link-button"
          disabled={skip.busy}
          onClick={() => void skip.submit(null).then((ok) => ok && onSaved())}
        >
          Skip. Ask me later.
        </button>
        {started && (
          <button
            type="button"
            className="link-button link-button--quiet"
            disabled={restart.busy || about.busy !== null}
            onClick={after(restart)}
          >
            Start the conversation again
          </button>
        )}
      </div>
    </>
  );
}
