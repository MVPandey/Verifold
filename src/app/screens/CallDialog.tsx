import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { Call, Lab } from '../../protocol/api.ts';
import {
  callView,
  closeHow,
  costLine,
  failureOf,
  footLine,
  missingLine,
  onBoard,
  optionForKey,
  optionLines,
  optionOrder,
  returnFocus,
  settledLabel,
  typing,
  undoLeft,
  applyingText,
  type CallView,
} from '../call.ts';
import { andList } from '../../ui/call-words.ts';
import { asked, since, usd } from '../format.ts';
import { href, replaceRoute } from '../route.ts';
import { useAction } from '../useAction.ts';
import { AnswerLine } from '../components/AnswerLine.tsx';
import { FactSource, uniqueFacts } from '../components/FactsList.tsx';
import { showPost } from '../components/BoardThread.tsx';
import { Composer } from '../components/Composer.tsx';
import { Cross } from '../components/Icons.tsx';
import type { LabActions } from './LabHome.tsx';

/**
 * Leave the call's address for the lab home without a new history entry:
 * back when the lab home opened the call, else the call's entry becomes the
 * lab's. Back after this cannot reopen the call.
 */
function goHome(): void {
  if (closeHow(history.state) === 'back') {
    history.back();
    return;
  }
  replaceRoute(href.lab);
}

/** What the call rests on: the money spent so far, the facts that the asker checked, and those of the plan. */
function Facts({
  lab,
  call,
}: {
  readonly lab: Lab;
  readonly call: Call;
}): ReactNode {
  const { money, plan } = lab;
  const facts = uniqueFacts([...(call.facts ?? []), ...(plan?.facts ?? [])]);
  return (
    <details className="call__facts">
      <summary>Facts behind this</summary>
      <ul>
        <li>
          GPU spent so far: {usd(money.gpuUsd)}
          {money.gpuLimitUsd !== null &&
            ` of the project's ${usd(money.gpuLimitUsd)} GPU limit`}
          . Plans so far: about {usd(money.plansUsd)}.
        </li>
        {facts.map((fact, index) => (
          <li key={index}>
            {fact.claim} <FactSource fact={fact} />
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The top line: what the dialog is about, and Close. */
function Top({
  label,
  tone,
  onClose,
}: {
  readonly label: string | null;
  readonly tone: 'need' | 'done' | 'busy' | 'quiet';
  readonly onClose: () => void;
}): ReactNode {
  return (
    <div className="call__top">
      <span className={`call__label call__label--${tone}`}>{label}</span>
      <button
        type="button"
        className="call__close"
        aria-label="Close"
        onClick={onClose}
      >
        <Cross size={18} width={2} />
      </button>
    </div>
  );
}

/** An open call: the reasons, the options to pick, the facts, and a box for the person's own words. */
function OpenCall({
  call,
  lab,
  now,
  titleId,
  order,
  busy,
  error,
  older,
  onPick,
  onThread,
  onClose,
  onWords,
}: {
  readonly call: Call;
  readonly lab: Lab;
  readonly now: number;
  readonly titleId: string;
  readonly order: readonly number[];
  readonly busy: boolean;
  readonly error: string | null;
  readonly older: boolean;
  readonly onPick: (option: number) => void;
  readonly onThread: (post: string) => void;
  readonly onClose: () => void;
  readonly onWords: LabActions['words'];
}): ReactNode {
  const failure = failureOf(lab, call);
  // The call's reason, then each later asker's own, when it says more.
  const reasons = [
    call.why,
    ...call.askers
      .slice(1)
      .filter((asker) => asker.why && asker.why !== call.why)
      .map((asker) => `${asker.handle}: ${asker.why}`),
  ];
  const post = call.post;
  return (
    <div className="call__body">
      <Top
        label={`Needs you · ${asked(call.askers)} · ${since(call.at, now)} ago`}
        tone="need"
        onClose={onClose}
      />
      <h2 id={titleId} className="call__title">
        {call.question}
      </h2>
      {failure && (
        <p role="alert" className="call__failure">
          {failure.text} The call is open again.
        </p>
      )}
      <div className="call__context">
        {reasons.map((reason, index) => (
          <p key={index}>
            {reason}
            {index === reasons.length - 1 && post && (
              <>
                {' '}
                <a
                  href={href.lab}
                  onClick={(event) => {
                    event.preventDefault();
                    onThread(post);
                  }}
                >
                  See the thread
                </a>
              </>
            )}
          </p>
        ))}
        {older && (
          <p role="status" className="call__fine">
            That thread is older than the board shows.
          </p>
        )}
      </div>
      <div className="call__options" role="group" aria-labelledby={titleId}>
        {order.map((index, position) => {
          const option = call.options[index];
          if (!option) return null;
          const lines = optionLines(option, call, lab);
          const missing = missingLine(option);
          const advised = call.pick === index;
          const cost = costLine(option);
          return (
            <div key={index} className="call__choice">
              <button
                type="button"
                className={`call__option${advised ? ' call__option--pick' : ''}`}
                aria-keyshortcuts={String(position + 1)}
                disabled={busy}
                onClick={() => onPick(index)}
              >
                <span className="call__option-body">
                  <b>{option.label}</b>
                  {option.detail && (
                    <span className="call__detail">{option.detail}</span>
                  )}
                  {cost && <span className="call__cost">{cost}</span>}
                </span>
                {advised && (
                  <span className="call__pick">The agents' pick</span>
                )}
              </button>
              {lines && <p className="call__fine">{lines.does}</p>}
              {missing && (
                <p className="call__fine call__fine--need">
                  {missing} Store each one in a terminal with{' '}
                  <code>verifold runpod secret set NAME</code>.
                </p>
              )}
            </div>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="call__error">
          {error}
        </p>
      )}
      <Facts lab={lab} call={call} />
      {call.byVerifold && call.words && (
        <p role="status" className="call__sent">
          Your words went to the lab. Pick an option to give it more time or end
          it.
        </p>
      )}
      <Composer
        multiline
        label="Or tell them what to do instead"
        placeholder="Say it in your own words"
        maxLength={call.wordsLimit}
        onSend={(text, key) => onWords(call.id, text, key)}
      />
      <p className="call__foot">{footLine(call, lab)}</p>
    </div>
  );
}

/** A call that no longer waits: what became of it, under a label that says its state. */
function Settled({
  view,
  lab,
  now,
  titleId,
  actions,
  onClose,
}: {
  readonly view: Exclude<CallView, { readonly kind: 'open' }>;
  readonly lab: Lab;
  readonly now: number;
  readonly titleId: string;
  readonly actions: LabActions;
  readonly onClose: () => void;
}): ReactNode {
  const label = settledLabel(view);
  const body = ((): ReactNode => {
    switch (view.kind) {
      case 'applying':
        return (
          <p className="call__fine" role="status">
            {applyingText(view.option)}
          </p>
        );
      case 'chosen':
        return undoLeft(view.call, now) === null ? (
          <>
            <p className="call__fine">You chose “{view.option.label}”.</p>
            <AnswerLine
              call={view.call}
              lab={lab}
              now={now}
              onUndo={actions.undo}
            />
          </>
        ) : (
          <AnswerLine
            call={view.call}
            lab={lab}
            now={now}
            onUndo={actions.undo}
          />
        );
      case 'words':
        return (
          <>
            <p className="call__fine">You answered in your own words:</p>
            <blockquote className="call__quote">{view.words}</blockquote>
            <p className="call__fine">
              {view.call.askers.length
                ? `${andList(view.call.askers.map((asker) => asker.handle))} ${view.call.askers.length === 1 ? 'gets' : 'get'} your words with the next turn. No option applied.`
                : 'No option applied.'}
            </p>
          </>
        );
      case 'undoing':
        return (
          <p className="call__fine" role="status">
            Undoing your answer…
          </p>
        );
      case 'withdrawn':
        return (
          <p className="call__fine">
            Verifold withdrew this call
            {view.call.note ? `: ${view.call.note}` : '.'}
          </p>
        );
      case 'missing':
        return (
          <p className="call__fine">
            It may have ended a while ago, or the address is wrong.
          </p>
        );
    }
  })();
  return (
    <div className="call__body">
      <Top
        label={label?.text ?? null}
        tone={label?.tone ?? 'quiet'}
        onClose={onClose}
      />
      <h2 id={titleId} className="call__title">
        {view.kind === 'missing'
          ? 'This call is not in the lab'
          : view.call.question}
      </h2>
      {body}
      <div className="call__done">
        <button
          type="button"
          className="button button--primary"
          onClick={onClose}
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
 * without answering; nothing is bought then.
 *
 * A modal `<dialog>` keeps focus inside. Leaving closes it first, so the
 * browser returns focus to where it was when the call opened, and then
 * leaves the address. After the dialog is gone, focus goes to the Decide
 * link if it went nowhere, and "See the thread" brings the post into view.
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
  // Set when the person leaves; what to bring into view after the dialog is gone.
  const leaving = useRef<{ readonly post: string | null } | null>(null);
  const titleId = useId();
  const [older, setOlder] = useState(false);
  const view = callView(lab, id);
  const open = view.kind === 'open' ? view.call : null;
  const order = open ? optionOrder(open) : [];
  const answer = useAction<number>((option, key) =>
    actions.answer(id, option, key),
  );
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      const after = leaving.current;
      if (dialog?.open) dialog.close();
      // After React removed the dialog: then neither the focus fallback nor
      // the scroll can be undone by the browser's own focus return.
      setTimeout(() => {
        returnFocus(document);
        if (after?.post) showPost(after.post);
      }, 0);
    };
  }, []);
  const leave = (post: string | null = null): void => {
    leaving.current = { post };
    ref.current?.close();
  };
  const pick = (option: number): void => {
    if (open && !answer.busy) void answer.submit(option);
  };
  const keys = (event: KeyboardEvent<HTMLDialogElement>): void => {
    if (!open || event.metaKey || event.ctrlKey || event.altKey) return;
    const option = optionForKey(event.key, order, typing(event.target));
    if (option === null) return;
    event.preventDefault();
    pick(option);
  };
  return (
    <dialog
      ref={ref}
      className="call"
      aria-labelledby={titleId}
      aria-modal="true"
      onKeyDown={keys}
      onCancel={(event) => {
        // Escape: leave as Close does, so the address stays in step.
        event.preventDefault();
        leave();
      }}
      onClose={() => {
        if (leaving.current) goHome();
      }}
    >
      {view.kind === 'open' ? (
        <OpenCall
          call={view.call}
          lab={lab}
          now={now}
          titleId={titleId}
          order={order}
          busy={answer.busy}
          error={answer.error}
          older={older}
          onPick={pick}
          onThread={(post) => {
            if (onBoard(lab, post)) leave(post);
            else setOlder(true);
          }}
          onClose={() => leave()}
          onWords={actions.words}
        />
      ) : (
        <Settled
          view={view}
          lab={lab}
          now={now}
          titleId={titleId}
          actions={actions}
          onClose={() => leave()}
        />
      )}
    </dialog>
  );
}
