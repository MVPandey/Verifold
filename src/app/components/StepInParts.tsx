import { useState, type ReactNode } from 'react';
import type { Lab, Post, Question } from '../../protocol/api.ts';
import { lineHref, lineText, hasOriginal } from '../brief-view.ts';
import { useControl } from '../controls.ts';
import { href } from '../route.ts';
import {
  answerHead,
  checksForYou,
  newestQuestions,
  noticesForYou,
  postActs,
  priorLabel,
  sourceWords,
  type BoxAct,
} from '../step-in.ts';
import { useView } from '../view-mode.ts';
import { Avatar } from './Avatar.tsx';
import { IdText } from './IdText.tsx';
import { PlainToggle } from './PlainToggle.tsx';

/** Reply, Object, and Ask for a check on a post. When no check can start, the control says why. */
export function PostActs({
  post,
  onAct,
}: {
  readonly post: Post;
  readonly onAct: (act: BoxAct) => void;
}): ReactNode {
  const { controls, action } = useControl<string>((controls, id, key) =>
    controls.askCheck(id, key),
  );
  const { object, canCheck, why } = postActs(post);
  return (
    <div className="acts acts--post">
      <button type="button" onClick={() => onAct({ kind: 'reply', post })}>
        Reply
      </button>
      {object && (
        <button type="button" onClick={() => onAct({ kind: 'object', post })}>
          Object
        </button>
      )}
      {canCheck && controls && (
        <button
          type="button"
          disabled={action.busy}
          onClick={() => void action.submit(post.id)}
        >
          Ask for a check
        </button>
      )}
      {why && <span className="acts__why">{why}</span>}
      {action.error && (
        <span role="alert" className="composer__error">
          {action.error}
        </span>
      )}
    </div>
  );
}

/** What a proposal or a ruled-out post says of earlier work. The agent wrote the fields, and the record gives the label. */
export function PriorBlock({
  post,
  now,
}: {
  readonly post: Post;
  readonly now: number;
}): ReactNode {
  const { prior, search } = post;
  if (!prior && !search) return null;
  const rows = [
    ['Closest', prior?.closest],
    ['Not found', prior?.notFound],
    ['New here', prior?.newHere],
  ] as const;
  return (
    <div className="prior">
      <span className="prior__label">{priorLabel(post, now)}</span>
      {prior ? (
        <dl>
          {rows.map(
            ([name, text]) =>
              text && (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>
                    <IdText text={text} />
                  </dd>
                </div>
              ),
          )}
        </dl>
      ) : (
        <span className="reach">
          The agent wrote no summary of this search.
        </span>
      )}
    </div>
  );
}

/** One answer of the Coordinator: the question, the answer with its source posts, and that no agent woke. */
function Answer({
  question,
  now,
}: {
  readonly question: Question;
  readonly now: number;
}): ReactNode {
  const { mode } = useView();
  const [original, setOriginal] = useState(false);
  const { answer } = question;
  return (
    <div className="answer">
      <div className="post__head">
        <Avatar who="coordinator" size="sm" />
        <b>Coordinator</b>
        <span className="post__time">{answerHead(question, now)}</span>
      </div>
      <div className="answer__text">
        <b>You:</b> {question.text}
      </div>
      {answer && (
        <div className="answer__text">
          <IdText text={lineText(answer, mode, original)} />{' '}
          <a className="proof" href={lineHref(answer)}>
            {sourceWords(answer.posts)}
          </a>{' '}
          {hasOriginal(answer, mode) && (
            <PlainToggle
              original={original}
              onToggle={() => setOriginal(!original)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The person's newest questions to the Coordinator, with their answers. */
export function Answers({
  lab,
  now,
}: {
  readonly lab: Lab;
  readonly now: number;
}): ReactNode {
  return newestQuestions(lab).map((question) => (
    <Answer key={question.id} question={question} now={now} />
  ));
}

/** What the Coordinator told agents that the person can act on. `thread`: only those of one thread. */
export function NoticeLines({
  lab,
  thread,
}: {
  readonly lab: Lab;
  readonly thread?: string;
}): ReactNode {
  const { mode } = useView();
  return (
    <>
      {noticesForYou(lab, mode, thread).map((notice) => (
        <p key={notice.id} className="later">
          <IdText text={notice.text} />
          {notice.thread && notice.thread !== thread && (
            <>
              {' '}
              <a href={href.thread(notice.thread)}>Thread</a>
            </>
          )}
        </p>
      ))}
      {!thread &&
        checksForYou(lab, mode).map((check) => (
          <p key={check.id} className="later">
            <IdText text={check.text} />{' '}
            <a href={href.post(check.post)}>The post</a>
          </p>
        ))}
    </>
  );
}
