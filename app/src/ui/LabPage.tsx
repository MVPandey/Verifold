import { useEffect } from 'react';
import type { ReactElement } from 'react';

import type { AgentView, LabView, PostView, ThreadSummary } from '../api/types.ts';
import { authorName, face } from '../model/agents.ts';
import type { Face } from '../model/agents.ts';
import { orderNeeds } from '../model/needs.ts';
import { isPermission, personMessage, standingChip } from '../model/posts.ts';
import { href } from '../model/route.ts';
import { hasNew, markSeen, readSeen } from '../model/seen.ts';
import { answerSoFar, cardStatus, headClaim, questionThread } from '../model/turns.ts';
import { useThread } from './hooks.ts';
import type { PageProps, ThreadRead } from './hooks.ts';
import { ChipView, Composer, FaceView } from './parts.tsx';
import { Turns } from './Thread.tsx';

/** A question longer than this gets smaller type, so it does not fill the screen. */
const LONG_QUESTION = 120;

/**
 * The lab as a wall: the question and the answer so far, the box that steers the lab, and one card for each
 * thread. `open` is the thread whose card is open, and `post` is the post in it to scroll to.
 */
export function LabPage(
  props: PageProps & { readonly open: string | null; readonly post: string | null },
): ReactElement {
  const { api, data, open, post } = props;
  const { lab, threads, needs, version } = data;
  const seen = readSeen(window.localStorage, lab.opened_at);
  const question = questionThread(threads);
  const questionId = question?.thread.id ?? null;
  // The seat needs the question's thread at every load. An open card needs its own.
  const questionRead = useThread(api, questionId, version);
  const cardRead = useThread(api, open === questionId ? null : open, version);
  const openRead = open === questionId ? questionRead : cardRead;
  const loaded = openRead.view?.thread.id === open ? openRead.view : null;
  const last = loaded?.posts.at(-1)?.seq;

  useEffect(() => {
    if (open !== null && last !== undefined) {
      markSeen(window.localStorage, lab.opened_at, open, last);
    }
  }, [open, last, lab.opened_at]);

  const ready = loaded !== null;
  useEffect(() => {
    if (open === null || !ready) return;
    const target =
      (post && document.getElementById(post)) || document.getElementById(`card-${open}`);
    target?.scrollIntoView({ block: post && target.id === post ? 'center' : 'start' });
  }, [open, post, ready]);

  const send = async (text: string, thread: string | null): Promise<void> => {
    const request = personMessage(text, thread ?? undefined);
    if (request) await api.post(request);
    data.reload();
  };
  const turns = (read: ThreadRead): ReactElement =>
    read.view ? (
      <Turns
        view={read.view}
        agents={lab.agents}
        harnesses={data.setup?.harnesses ?? []}
        needs={needs}
        question={questionId}
        onRerun={(postId) => api.rerun(postId)}
        onSend={(text) => send(text, read.view?.thread.id ?? null)}
      />
    ) : (
      <p className="f-wait" role="status">
        {read.error ?? 'Loading the thread.'}
      </p>
    );
  const cards = threads
    .filter((summary) => summary !== question)
    .sort((first, second) => number(first) - number(second));
  const answer = questionRead.view ? answerSoFar(questionRead.view.posts) : null;
  const chip = answer ? standingChip(answer.post, answer.standing) : null;
  const answerOpen = question !== null && open === questionId;
  const missing = open !== null && !threads.some((summary) => summary.thread.id === open);

  return (
    <>
      <section className="f-seat">
        <div>
          <h1 className={lab.question.length > LONG_QUESTION ? 'long' : undefined}>
            {lab.question}
          </h1>
          {question ? (
            <div className={`f-answer${answerOpen ? ' on' : ''}`}>
              <div className="f-card-title">
                <a
                  className="f-label"
                  href={href(
                    answerOpen
                      ? { page: 'lab' }
                      : { page: 'thread', id: question.thread.id, post: null },
                  )}
                  aria-expanded={answerOpen}
                >
                  The answer so far
                </a>
                {hasNew(question, seen) && !answerOpen ? <New /> : null}
              </div>
              {answer ? (
                <>
                  <p className={answerOpen ? undefined : 'clamp'}>{answer.post.text}</p>
                  <div className="f-card-st">
                    <ChipView chip={chip ?? { label: 'Not checked', tone: 'none' }} />
                  </div>
                </>
              ) : (
                <p className="dim">
                  {questionRead.view
                    ? 'No answer proposed yet.'
                    : (questionRead.error ?? 'Loading the answer.')}
                </p>
              )}
              <Faces faces={authors(questionRead.view?.posts ?? [], lab.agents)} />
            </div>
          ) : null}
        </div>
        <div className="f-steer">
          <Need needs={needs} lab={lab} />
          <Composer
            variant="steer"
            label="Steer the lab"
            placeholder="Change the scope, the priority, or the time. Every agent gets it."
            button="Send to the lab"
            hint={
              needs.length > 0
                ? 'Your message opens a new thread.'
                : 'Nothing waits for you. Your message opens a new thread.'
            }
            onSend={(text) => send(text, null)}
          />
        </div>
      </section>

      {question && answerOpen ? (
        <section
          id={`card-${question.thread.id}`}
          className="f-card open f-answer-thread"
          aria-label={question.thread.title}
        >
          {turns(questionRead)}
        </section>
      ) : null}

      <div className="f-body">
        {missing ? (
          <p className="f-wait" role="alert">
            {cardRead.error ?? 'This lab has no such thread.'}
          </p>
        ) : null}
        {cards.length > 0 ? (
          <div className="f-wall">
            {cards.map((summary) => (
              <Card
                key={summary.thread.id}
                summary={summary}
                agents={lab.agents}
                fresh={hasNew(summary, seen)}
                read={summary.thread.id === open ? cardRead : null}
              >
                {summary.thread.id === open ? turns(cardRead) : null}
              </Card>
            ))}
          </div>
        ) : (
          <p className="empty">No threads yet.</p>
        )}
      </div>
    </>
  );
}

function number(summary: ThreadSummary): number {
  return Number(summary.thread.id.slice(2));
}

/**
 * Return the faces of the authors of some posts, each once, with the latest author first. The API does not say
 * who is in a thread now, so the page shows who posted last and, fainter, who posted before.
 */
function authors(posts: readonly PostView[], agents: readonly AgentView[]): readonly Face[] {
  const ids = [...new Set(posts.map((item) => item.post.author).reverse())];
  const faces = ids.map((id) => face(agents, id));
  // Blind reruns share one face, because they have no name.
  const rerun = faces.findIndex((one) => one.kind === 'rerun');
  return faces.filter((one, index) => one.kind !== 'rerun' || index === rerun);
}

function Faces(props: { readonly faces: readonly Face[] }): ReactElement {
  return (
    <div className="f-faces">
      {props.faces.map((one, index) => (
        <FaceView key={index} face={one} alone ghost={index > 0} />
      ))}
    </div>
  );
}

function New(): ReactElement {
  return <span className="f-new">New</span>;
}

/** The ask that waits for the person, with the way to the Needs you page. */
function Need(props: {
  readonly needs: readonly PostView[];
  readonly lab: LabView;
}): ReactElement | null {
  const first = orderNeeds(props.needs, props.lab)[0];
  if (first === undefined) return null;
  const name = authorName(props.lab.agents, first.post.author);
  const more = props.needs.length - 1;
  return (
    <a className="f-need" href={href({ page: 'needs' })}>
      <b>{isPermission(first.post) ? `${name} asks for permission` : `${name} needs you`}</b>
      <span>{first.post.text.replace(/^Permission needed:\s*/, '')}</span>
      {more > 0 ? (
        <small>{more === 1 ? 'One more ask waits.' : `${more} more asks wait.`}</small>
      ) : null}
      <em>Answer</em>
    </a>
  );
}

/**
 * One thread on the wall. Closed, it shows the title, a status, a mark for new posts, and the face of the latest
 * author. Open, it takes the full width and shows the result that the thread stands on, then `children`.
 */
function Card(props: {
  readonly summary: ThreadSummary;
  readonly agents: readonly AgentView[];
  readonly fresh: boolean;
  /** The thread's posts when the card is open, or `null` for a closed card. */
  readonly read: ThreadRead | null;
  readonly children: ReactElement | null;
}): ReactElement {
  const { summary, read } = props;
  const { id, title } = summary.thread;
  const open = read !== null;
  const status = cardStatus(summary);
  const head = read?.view ? headClaim(read.view.posts) : null;
  const chip = head ? standingChip(head.post, head.standing) : null;
  const faces = read?.view
    ? authors(read.view.posts, props.agents)
    : summary.latest
      ? [face(props.agents, summary.latest.author)]
      : [];
  return (
    <section id={`card-${id}`} className={`f-card c-${status.edge}${open ? ' open' : ''}`}>
      <header>
        <div className="f-card-title">
          <h2>
            <a
              href={href(open ? { page: 'lab' } : { page: 'thread', id, post: null })}
              aria-expanded={open}
            >
              {title}
            </a>
          </h2>
          {props.fresh && !open ? <New /> : null}
        </div>
        <div className="f-card-st">
          {chip ? (
            <ChipView chip={chip} />
          ) : (
            <span className={`f-st fs-count-${status.edge}`}>{status.label}</span>
          )}
          {status.openAsks ? <span className="f-st fs-ask">{status.openAsks}</span> : null}
        </div>
        {head ? <p className="f-head">{head.post.text}</p> : null}
        <Faces faces={faces} />
      </header>
      {props.children}
    </section>
  );
}
