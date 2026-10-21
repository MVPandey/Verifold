import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { Call, Lab } from '../../protocol/api.ts';
import {
  andList,
  askedBy,
  callView,
  costLine,
  effectLines,
  missingLine,
  optionForKey,
  optionOrder,
  returnFocus,
  typing,
  undoLeft,
  undoSentence,
} from '../call.ts';
import { since, usd } from '../format.ts';
import { afterSend } from '../intent.ts';
import { href } from '../route.ts';
import { useAction } from '../useAction.ts';
import { Cross } from '../components/Icons.tsx';
import { UndoLine } from '../components/UndoLine.tsx';
import type { LabActions } from './LabHome.tsx';

/** Leave the dialog for the lab home. With `post`, bring that post of the board into view. */
function close(post: string | null = null): void {
  location.hash = href.lab;
  requestAnimationFrame(() => {
    returnFocus(document);
    if (post)
      document
        .getElementById(`post-${post}`)
        ?.scrollIntoView({ block: 'center' });
  });
}

/** What the call rests on: the money spent so far, and the facts that the plan checked. */
function Facts({ lab }: { readonly lab: Lab }): ReactNode {
  const { money, plan } = lab;
  return (
    <details className="call__facts">
      <summary>Facts behind this</summary>
      <ul>
        <li>
          GPU spent so far: {usd(money.gpuUsd)}
          {money.gpuLimitUsd !== null &&
            ` of this lab's ${usd(money.gpuLimitUsd)}`}
          . Plans so far: about {usd(money.plansUsd)}.
        </li>
        {plan?.facts.map((fact, index) => (
          <li key={index}>
            {fact.claim}{' '}
            <span className="call__fact-source">
              ·{' '}
              {fact.source
                ? `${fact.source}${fact.sourceDate ? `, ${fact.sourceDate}` : ''}`
                : 'unverified (no source)'}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The person's own answer: a box and Send. The words go to every agent that asked. */
function Words({
  call,
  onWords,
}: {
  readonly call: Call;
  readonly onWords: LabActions['words'];
}): ReactNode {
  const id = useId();
  const [text, setText] = useState('');
  const words = useAction<string>((value, key) => onWords(call.id, value, key));
  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const sent = text;
    const value = sent.trim();
    if (!value || words.busy) return;
    if (await words.submit(value))
      setText((current) => afterSend(current, sent));
  };
  return (
    <form className="call__words" onSubmit={(event) => void send(event)}>
      <label htmlFor={id} className="call__words-label">
        Or tell them what to do instead
      </label>
      <div className="call__words-row">
        <textarea
          id={id}
          rows={2}
          maxLength={2000}
          value={text}
          placeholder="Say it in your own words"
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="submit"
          className="button call__send"
          disabled={words.busy}
        >
          Send
        </button>
      </div>
      {words.error && (
        <span role="alert" className="call__error">
          {words.error}
        </span>
      )}
    </form>
  );
}

/** An open call: the options to pick, the facts, and the box for the person's own words. */
function OpenCall({
  call,
  lab,
  now,
  titleId,
  actions,
}: {
  readonly call: Call;
  readonly lab: Lab;
  readonly now: number;
  readonly titleId: string;
  readonly actions: LabActions;
}): ReactNode {
  const order = optionOrder(call);
  // The call's reason, then each later asker's own, when it says more.
  const reasons = [
    call.why,
    ...call.askers
      .slice(1)
      .filter((asker) => asker.why && asker.why !== call.why)
      .map((asker) => `${asker.handle}: ${asker.why}`),
  ];
  const answer = useAction<number>((option, key) =>
    actions.answer(call.id, option, key),
  );
  const pick = (option: number): void => {
    if (!answer.busy) void answer.submit(option);
  };
  const keys = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const option = optionForKey(event.key, order, typing(event.target));
    if (option === null) return;
    event.preventDefault();
    pick(option);
  };
  return (
    <div className="call__body" onKeyDown={keys}>
      <CallHead call={call} now={now} titleId={titleId} />
      <div className="call__context">
        {reasons.map((reason, index) => (
          <p key={index}>
            {reason}
            {index === reasons.length - 1 && call.post && (
              <>
                {' '}
                <a
                  href={href.lab}
                  onClick={(event) => {
                    event.preventDefault();
                    close(call.post);
                  }}
                >
                  See the thread
                </a>
              </>
            )}
          </p>
        ))}
      </div>
      <div className="call__options" role="group" aria-labelledby={titleId}>
        {order.map((index, position) => {
          const option = call.options[index];
          if (!option) return null;
          const lines = option.effect
            ? effectLines(option.effect, call, lab)
            : null;
          const missing = missingLine(option);
          const advised = call.pick === index;
          return (
            <div key={index} className="call__choice">
              <button
                type="button"
                className={`call__option${advised ? ' call__option--pick' : ''}`}
                aria-keyshortcuts={String(position + 1)}
                disabled={answer.busy}
                onClick={() => pick(index)}
              >
                <span className="call__option-body">
                  <b>{option.label}</b>
                  {costLine(option) && (
                    <span className="call__cost">{costLine(option)}</span>
                  )}
                </span>
                {advised && (
                  <span className="call__pick">The agents' pick</span>
                )}
              </button>
              {lines && <p className="call__fine">{lines.does}</p>}
              {missing && (
                <p className="call__fine call__fine--need">
                  {missing} <a href="/">Open the desk</a> to store it.
                </p>
              )}
            </div>
          );
        })}
      </div>
      {answer.error && (
        <p role="alert" className="call__error">
          {answer.error}
        </p>
      )}
      <Facts lab={lab} />
      {call.byVerifold && call.words && (
        <p role="status" className="call__sent">
          Your words went to the lab. Pick an option to give it more time or end
          it.
        </p>
      )}
      <Words call={call} onWords={actions.words} />
      <p className="call__foot">{undoSentence(call)}</p>
    </div>
  );
}

/** The dialog's first lines: who asked and when, and the question as its title. */
function CallHead({
  call,
  now,
  titleId,
}: {
  readonly call: Call;
  readonly now: number;
  readonly titleId: string;
}): ReactNode {
  return (
    <>
      <div className="call__top">
        <span className="call__label">
          Needs you · {askedBy(call)} · {since(call.at, now)} ago
        </span>
        <button
          type="button"
          className="call__close"
          aria-label="Close"
          onClick={() => close()}
        >
          <Cross size={18} width={2} />
        </button>
      </div>
      <h2 id={titleId} className="call__title">
        {call.question}
      </h2>
    </>
  );
}

/** A call that no longer waits: what the person chose, or what became of it. */
function Settled({
  title,
  children,
  titleId,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly titleId: string;
}): ReactNode {
  return (
    <div className="call__body">
      <div className="call__top">
        <span className="call__label call__label--done">Answered</span>
        <button
          type="button"
          className="call__close"
          aria-label="Close"
          onClick={() => close()}
        >
          <Cross size={18} width={2} />
        </button>
      </div>
      <h2 id={titleId} className="call__title">
        {title}
      </h2>
      {children}
      <div className="call__done">
        <button
          type="button"
          className="button button--primary"
          onClick={() => close()}
        >
          Back to the lab
        </button>
      </div>
    </div>
  );
}

/**
 * A call, over the lab home, as on the v9 canvas ("9. A call"). The person
 * picks an option, or answers in their own words. Escape and Close leave
 * without answering; nothing is bought then. A modal `<dialog>` keeps focus
 * inside, and the browser returns it to where it was when the call opened.
 */
export function CallDialog({
  lab,
  id,
  now,
  actions,
}: {
  readonly lab: Lab;
  readonly id: string;
  readonly now: number;
  readonly actions: LabActions;
}): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  const view = callView(lab, id);
  const body = ((): ReactNode => {
    switch (view.kind) {
      case 'open':
        return (
          <OpenCall
            call={view.call}
            lab={lab}
            now={now}
            titleId={titleId}
            actions={actions}
          />
        );
      case 'undoing':
        return (
          <Settled title={view.call.question} titleId={titleId}>
            <p className="call__fine">Undoing your answer.</p>
          </Settled>
        );
      case 'chosen':
        return (
          <Settled title={view.call.question} titleId={titleId}>
            {undoLeft(view.call, now) === null ? (
              <p className="call__fine">You chose “{view.option.label}”.</p>
            ) : (
              <UndoLine
                call={view.call}
                lab={lab}
                now={now}
                onUndo={actions.undo}
              />
            )}
          </Settled>
        );
      case 'words':
        return (
          <Settled title={view.call.question} titleId={titleId}>
            <p className="call__fine">You answered in your own words:</p>
            <blockquote className="call__quote">{view.words}</blockquote>
            <p className="call__fine">
              {view.call.askers.length
                ? `${andList(view.call.askers.map((asker) => asker.handle))} ${view.call.askers.length === 1 ? 'gets' : 'get'} your words with the next turn. No option applied.`
                : 'No option applied.'}
            </p>
          </Settled>
        );
      case 'withdrawn':
        return (
          <Settled title={view.call.question} titleId={titleId}>
            <p className="call__fine">
              Verifold withdrew this call
              {view.call.note ? `: ${view.call.note}` : '.'}
            </p>
          </Settled>
        );
      case 'missing':
        return (
          <Settled title="This call is not in the lab" titleId={titleId}>
            <p className="call__fine">
              It may have ended a while ago, or the address is wrong.
            </p>
          </Settled>
        );
    }
  })();
  return (
    <dialog
      ref={ref}
      className="call"
      aria-labelledby={titleId}
      aria-modal="true"
      onCancel={(event) => {
        // Escape: leave the call without answering, and keep the address in step.
        event.preventDefault();
        close();
      }}
    >
      {body}
    </dialog>
  );
}
