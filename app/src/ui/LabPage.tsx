import { useEffect, useId, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import { PERSON } from '../api/types.ts';
import type {
  AgentView,
  CandidatesView,
  CandidateView,
  LabView,
  Need,
  Obstacle,
  Post,
  PostView,
  QuestionVersion,
  TaskCard,
  ThreadLink,
  ThreadSummary,
} from '../api/types.ts';
import { authorName, called, members } from '../model/agents.ts';
import { actionIds } from '../model/allowances.ts';
import { coordinatorOf } from '../model/coordinator.ts';
import type { Tab } from '../model/coordinator.ts';
import { crossedLine, crossLines } from '../model/crossings.ts';
import { deliverLine, isDocked } from '../model/deliverables.ts';
import { deskOf } from '../model/desk.ts';
import type { Docked } from '../model/deliverables.ts';
import { ago, clock, dayClock, duration, minutesBetween } from '../model/format.ts';
import { builderLine, lineFacts, obstacleGroups } from '../model/obstacles.ts';
import {
  clip,
  isLong,
  personMessage,
  personReply,
  restsOnLine,
  standingChip,
  testedChips,
} from '../model/posts.ts';
import { isRevision, noteLabel, revisedBy, revisedLine } from '../model/question.ts';
import { href } from '../model/route.ts';
import { hasNew, markSeen, readSeen } from '../model/seen.ts';
import { NEED_WORDS, WAITS_ID, quietBand, waitGroups, wantedLine } from '../model/status.ts';
import { betweenLine, isSide, sideHeading, sideLines } from '../model/side.ts';
import { cardTasks, onItLine } from '../model/tasks.ts';
import { messageOf } from '../api/client.ts';
import { cardStatus, doneLine, goneLine, headClaim, questionThread } from '../model/turns.ts';
import {
  breakthroughUnder,
  hasBreakthrough,
  proposalRows,
  proposalsHeading,
} from '../model/votes.ts';
import { browserStore, useThread } from './hooks.ts';
import type { PageProps, ThreadRead } from './hooks.ts';
import { Detail, Words } from './Markdown.tsx';
import { CoordinatorSeat, OpenedForYou } from './Coordinator.tsx';
import { ActionNeeds, Allowances } from './Allowances.tsx';
import { DashboardTab, LabTabs, StatusBar } from './Dashboard.tsx';
import type { LabTab } from './Dashboard.tsx';
import { DeskSeat } from './Desk.tsx';
import { MovesCard } from './Moves.tsx';
import { DeliverDoor, Deliverables } from './Deliverables.tsx';
import { ChipView, Composer, Exact, Files, New } from './parts.tsx';
import { Who } from './Picture.tsx';
import { RoundOpener, RoundPanel } from './Rounds.tsx';
import { Turns } from './Thread.tsx';
import { BadgeChip } from './Votes.tsx';

/** A question longer than this gets smaller type, so it does not fill the screen. */
const LONG_QUESTION = 120;

/** Where the page is: the thread whose card is open, and the post in it to scroll to. */
interface Place {
  readonly open: string | null;
  readonly post: string | null;
  /** The panel that is docked beside the wall when the page opens. Without it, none is. */
  readonly panel?: Tab | 'deliver' | undefined;
  /** The tab of the lab page that shows: the wall, or the agents' dashboard. Without it, the wall. */
  readonly tab?: LabTab | undefined;
}

/**
 * The lab page. It reads the threads that the wall shows in full, records what the person has seen, and scrolls
 * to the open card or post.
 */
export function LabPage(props: PageProps & Place): ReactElement {
  const { api, data, open, post } = props;
  const { lab, threads, version } = data;
  const questionId = questionThread(threads)?.thread.id ?? null;
  // A link can name a thread that the lab does not have. Reading it would fail again at every load.
  const known = threads.some((summary) => summary.thread.id === open);
  // The seat shows who posted in the question's thread, so it reads the thread at every load. An open card needs
  // its own. The candidate answers do not come from this read: they come with the lab, in `data.candidates`.
  const questionRead = useThread(api, questionId, version);
  const cardRead = useThread(api, known && open !== questionId ? open : null, version);
  const loaded = (open === questionId ? questionRead : cardRead).view;
  const last = loaded?.posts.at(-1)?.seq;

  useEffect(() => {
    if (open !== null && last !== undefined) {
      markSeen(browserStore, lab.opened_at, open, last);
    }
  }, [open, last, lab.opened_at]);

  const ready = loaded !== null;
  useEffect(() => {
    if (open === null || !ready) return;
    const target =
      (post && document.getElementById(post)) || document.getElementById(`card-${open}`);
    // A post inside a closed fold is not on the screen until the fold opens.
    for (
      let fold = target?.closest('details');
      fold;
      fold = fold.parentElement?.closest('details')
    ) {
      fold.open = true;
    }
    target?.scrollIntoView({ block: post && target.id === post ? 'center' : 'start' });
  }, [open, post, ready]);

  return <Wall {...props} questionRead={questionRead} cardRead={cardRead} />;
}

/**
 * The lab as a wall: the question and the candidate answers, what waits for the person, the box that steers the lab
 * with the control that opens a round, the lab's reading of the question, the newest report, the band of a quiet
 * lab, the newest round, and one card
 * for each thread. The cards stay in the order of their
 * threads' numbers, so a status that changes moves no card. The side threads come after the cards as one folded group, one line each. `questionRead` is the question's thread, and `cardRead` is the thread of the open card.
 */
export function Wall(
  props: PageProps & Place & { readonly questionRead: ThreadRead; readonly cardRead: ThreadRead },
): ReactElement {
  const { api, data, open, questionRead } = props;
  const { lab, threads, needs } = data;
  const seen = readSeen(browserStore, lab.opened_at);
  const question = questionThread(threads);
  const questionId = question?.thread.id ?? null;
  // The panel that is docked beside the wall: a tab of the panel for the coordinator, or the deliverables.
  const [panel, setPanel] = useState<Docked>(props.panel ?? null);
  const docked = isDocked(panel, coordinatorOf(lab.agents) !== null, deskOf(lab.agents) !== null);
  useEffect(() => {
    // The page makes room for the docked panel, so the person reads the wall and the panel at once. This is
    // the one place that does it: a switch from one panel to the other keeps the room.
    document.body.classList.toggle('with-panel', docked);
    return () => {
      document.body.classList.remove('with-panel');
    };
  }, [docked]);

  const send = async (text: string, thread?: string): Promise<void> => {
    const request = personMessage(text, thread);
    if (request) await api.post(request);
    data.reload();
  };
  // With a desk seated, the desk chat is the one place where the person writes. On a thread's page, a message
  // names that thread, until the person says that it is about the whole lab.
  const desk = deskOf(lab.agents) !== null;
  const [wholeLab, setWholeLab] = useState<string | null>(null);
  const opened = threads.find((summary) => summary.thread.id === open);
  const subject =
    opened && !opened.thread.desk && wholeLab !== opened.thread.id
      ? { id: opened.thread.id, title: opened.thread.title }
      : null;
  const turns = (read: ThreadRead): ReactElement =>
    read.view ? (
      <Turns
        // Each thread has its own choice of whether every message shows.
        key={read.view.thread.id}
        view={read.view}
        target={read.view.thread.id === open ? props.post : null}
        lab={lab.opened_at}
        seen={seen[read.view.thread.id] ?? 0}
        agents={lab.agents}
        needs={needs}
        question={questionId}
        done={lab.state !== 'open'}
        state={lab.state}
        reruns={lab.reruns_wanted}
        seats={lab.reviewer_seats}
        now={props.now}
        onRerun={(postId) => api.rerun(postId).then(() => data.reload())}
        marks={{
          onVote: (postId, direction, reason) =>
            api.vote(postId, direction, reason).then(() => data.reload()),
          onBadge: (change) => api.badge(change).then(() => data.reload()),
        }}
        onSend={desk ? undefined : (text) => send(text, read.view?.thread.id)}
      />
    ) : (
      <p className="f-wait" role="status">
        {read.error ?? 'Loading the thread.'}
      </p>
    );
  const answerOpen = question !== null && open === questionId;
  // A closed lab has the answer that its close names. Until then, the candidates stand side by side.
  const answered = lab.state === 'closed' && data.candidates.closes_on !== null;
  const done = doneLine(lab);
  const tab = props.tab ?? 'wall';

  return (
    <>
      <section className="f-seat">
        <div className="f-seat-main">
          <Question
            lab={lab}
            now={props.now}
            onRevise={async (text, note) => {
              const revised = await api.reviseQuestion(text, note);
              data.reload();
              return revised;
            }}
          />
          <StatusBar api={api} lab={lab} now={props.now} reload={data.reload} />
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
                  {answered ? 'The lab’s answer' : 'Candidate answers'}
                </a>
                {hasNew(question, seen) && !answerOpen ? <New /> : null}
              </div>
              <Candidates
                view={data.candidates}
                answered={answered}
                question={question.thread.id}
                open={answerOpen}
                threads={threads}
                agents={lab.agents}
                now={props.now}
              />
              <Faces
                ids={authors(questionRead.view?.posts ?? [], lab.agents)}
                agents={lab.agents}
              />
            </div>
          ) : null}
          <DeliverDoor
            list={lab.deliverables}
            open={panel === 'deliver'}
            onToggle={() => {
              setPanel(panel === 'deliver' ? null : 'deliver');
            }}
          />
          {panel === 'deliver' ? (
            <Deliverables
              api={api}
              list={lab.deliverables}
              removed={lab.removed_deliverables}
              lab={lab}
              agents={lab.agents}
              now={props.now}
              reload={data.reload}
              onClose={() => {
                setPanel(null);
              }}
            />
          ) : null}
        </div>
        <div className="f-steer">
          <ActionNeeds api={api} needs={needs} lab={lab} now={props.now} reload={data.reload} />
          <Waits lab={lab} now={props.now} skip={actionIds(needs)} />
          <Allowances
            api={api}
            lab={lab}
            now={props.now}
            reload={data.reload}
            {...(deskOf(lab.agents) ? { onChange: () => setPanel('desk') } : {})}
          />
          {done && lab.close ? (
            <a
              className="f-done"
              href={href({ page: 'thread', id: lab.close.thread, post: lab.close.id })}
            >
              {done}
              {deliverLine(lab.deliverables) ? <span>{deliverLine(lab.deliverables)}</span> : null}
            </a>
          ) : null}
          <DeskSeat
            {...props}
            open={panel === 'desk'}
            onOpen={(open) => {
              setPanel(open ? 'desk' : null);
            }}
            subject={subject}
            onClearSubject={() => {
              setWholeLab(open);
            }}
          />
          <MovesCard
            moves={data.conversation?.moves ?? []}
            agents={lab.agents}
            seated={coordinatorOf(lab.agents) !== null}
            onAll={() => {
              setPanel('log');
            }}
          />
          <CoordinatorSeat
            {...props}
            tab={panel === 'deliver' || panel === 'desk' ? null : panel}
            onTab={setPanel}
          />
          {desk ? null : (
            <Composer
              variant="steer"
              label="Steer the lab"
              placeholder="Change the scope, the priority, or the time. Every agent gets it."
              button="Send to the lab"
              hint={
                lab.waits.length > 0
                  ? 'Your message opens a new thread.'
                  : 'Nothing waits for you. Your message opens a new thread.'
              }
              onSend={(text) => send(text)}
            />
          )}
          <RoundOpener
            round={lab.round}
            now={props.now}
            onOpen={async (request) => {
              await api.post(request);
              data.reload();
            }}
          />
        </div>
      </section>

      <LabTabs tab={tab} />
      {tab === 'dashboard' ? (
        <DashboardTab api={api} lab={lab} now={props.now} reload={data.reload} />
      ) : (
        // A function and no component, so the wall's own elements stay in the page's tree.
        wallTab({ ...props, turns, seen })
      )}
    </>
  );
}

/**
 * The Wall tab: the question's thread when it is open, the lab's reading of the question, the newest report, the
 * band of a quiet lab, the newest round, one card for each thread, the obstacles, and the side threads.
 */
function wallTab(
  props: PageProps &
    Place & {
      readonly cardRead: ThreadRead;
      readonly questionRead: ThreadRead;
      readonly turns: (read: ThreadRead) => ReactElement;
      readonly seen: Readonly<Record<string, number>>;
    },
): ReactElement {
  const { api, data, open, cardRead, questionRead, turns, seen } = props;
  const { lab, threads } = data;
  const question = questionThread(threads);
  const answerOpen = question !== null && open === question.thread.id;
  const desk = deskOf(lab.agents) !== null;
  // The thread of the offers for a deliverable is no line of work, so it has no card. The panel for the
  // deliverables links to it, and it shows as a card while it is open.
  // The thread of a removed deliverable is a card again once a post comes there, so that work is not out of sight.
  const surfaced = new Set(
    lab.removed_deliverables.filter((item) => item.active).map((item) => item.thread),
  );
  const cards = threads
    // The desk chat shows in its own panel, so the wall has no card for it.
    .filter((summary) => summary !== question && !isSide(summary) && summary.thread.desk !== true)
    .map((summary) =>
      surfaced.has(summary.thread.id)
        ? { ...summary, thread: { ...summary.thread, deliverable: null } }
        : summary,
    )
    .filter((summary) => !summary.thread.deliverable || summary.thread.id === open)
    .sort((first, second) => number(first) - number(second));
  const side = threads.filter(isSide);
  const crossing = crossedLine(threads);
  const missing = open !== null && !threads.some((summary) => summary.thread.id === open);
  return (
    <>
      {question && answerOpen ? (
        <section
          id={`card-${question.thread.id}`}
          className="f-card open f-answer-thread"
          aria-label={question.thread.title}
        >
          {turns(questionRead)}
        </section>
      ) : null}

      <ReadingCard
        reading={data.reading ?? null}
        agents={lab.agents}
        opened={lab.opened_at}
        now={props.now}
        onReply={
          desk
            ? undefined
            : async (text, to) => {
                const request = personReply(text, to);
                if (request) await api.post(request);
                data.reload();
              }
        }
      />
      {data.report ? <ReportCard report={data.report} agents={lab.agents} now={props.now} /> : null}

      <div className="f-body">
        {missing ? (
          <p className="f-wait" role="alert">
            This lab has no thread {open}.
          </p>
        ) : null}
        <QuietBand lab={lab} now={props.now} />
        <RoundPanel round={lab.round} agents={lab.agents} now={props.now} />
        {crossing ? <p className="f-crossed">{crossing}</p> : null}
        {cards.length > 0 ? (
          <div className="f-wall">
            {cards.map((summary) => (
              <Card
                key={summary.thread.id}
                summary={summary}
                threads={threads}
                agents={lab.agents}
                need={lab.thread_needs[summary.thread.id] ?? null}
                wanted={wantedIn(lab, summary.thread.id, props.now)}
                breakthrough={lab.breakthrough_threads.includes(summary.thread.id)}
                fresh={hasNew(summary, seen)}
                read={summary.thread.id === open ? cardRead : null}
                turns={turns}
                now={props.now}
              />
            ))}
          </div>
        ) : side.length === 0 ? (
          <p className="empty">No threads yet.</p>
        ) : null}
        <Obstacles
          obstacles={lab.obstacles}
          threads={threads}
          agents={lab.agents}
          now={props.now}
        />
        {side.length > 0 ? (
          // A link into the group opens it. The person folds and unfolds it as they like otherwise.
          <details
            className="f-side o-side"
            open={side.some((summary) => summary.thread.id === open)}
          >
            <summary>
              {sideHeading(side)} <u className="closed">Show</u>
              <u className="opened">Hide</u>
              {side.some((summary) => summary.thread.id !== open && hasNew(summary, seen)) ? (
                <New />
              ) : null}
            </summary>
            <ul>
              {sideLines(side, lab.agents).map((line, index) => {
                const summary = side[index];
                if (summary === undefined) return null;
                return line.id === open ? (
                  <li key={line.id}>
                    <Card
                      summary={summary}
                      threads={threads}
                      agents={lab.agents}
                      need={lab.thread_needs[summary.thread.id] ?? null}
                      wanted={wantedIn(lab, summary.thread.id, props.now)}
                      breakthrough={lab.breakthrough_threads.includes(summary.thread.id)}
                      fresh={false}
                      read={cardRead}
                      turns={turns}
                      now={props.now}
                    />
                  </li>
                ) : (
                  <li key={line.id}>
                    <a href={href({ page: 'thread', id: line.id, post: null })}>
                      <b>{line.who}</b>
                      <span>{line.title}</span>
                      {line.marks.map((mark) => (
                        <em key={mark} className="f-st fs-ask">
                          {mark}
                        </em>
                      ))}
                      <small>{line.count}</small>
                    </a>
                    {hasNew(summary, seen) ? <New /> : null}
                  </li>
                );
              })}
            </ul>
          </details>
        ) : null}
      </div>
    </>
  );
}

/**
 * The lab's question, with the control that revises it and, when the person revised it, its versions. Edit
 * puts the form in the question's place.
 */
function Question(props: {
  readonly lab: LabView;
  readonly now: Date;
  /** Revise the question, and return the lab as it is after the revision. */
  readonly onRevise: (question: string, note: string) => Promise<LabView>;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  // The answer to a save is newer than the page's lab until the page reads the lab again.
  const [saved, setSaved] = useState<LabView | null>(null);
  const { question, versions } = saved && saved.seq > props.lab.seq ? saved : props.lab;
  if (editing) {
    return (
      <QuestionForm
        question={question}
        onSave={async (text, note) => {
          setSaved(await props.onRevise(text, note));
        }}
        onClose={() => {
          setEditing(false);
        }}
      />
    );
  }
  return (
    <div className="f-question">
      <h1 className={question.length > LONG_QUESTION ? 'long' : undefined}>{question}</h1>
      <button
        type="button"
        className="linkbtn"
        aria-label="Edit the question"
        onClick={() => {
          setEditing(true);
        }}
      >
        Edit
      </button>
      <Versions versions={versions} now={props.now} />
    </div>
  );
}

/**
 * The form that revises the question: the text, an optional line that says why, Save, and Cancel. Save is off
 * until the text differs from the question. `onClose` runs after a save and on Cancel.
 */
export function QuestionForm(props: {
  readonly question: string;
  readonly onSave: (question: string, note: string) => Promise<void>;
  readonly onClose: () => void;
}): ReactElement {
  const [text, setText] = useState(props.question);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const ready = isRevision(props.question, text) && !saving;

  const save = (event: FormEvent): void => {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    setError(null);
    props.onSave(text.trim(), note.trim()).then(props.onClose, (failure: unknown) => {
      setError(messageOf(failure));
      setSaving(false);
    });
  };

  return (
    <form className="f-revise" onSubmit={save}>
      <label htmlFor={`${id}-text`}>The question</label>
      <textarea
        id={`${id}-text`}
        value={text}
        rows={3}
        maxLength={4000}
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <label htmlFor={`${id}-why`}>Why (optional)</label>
      <input
        id={`${id}-why`}
        type="text"
        value={note}
        maxLength={200}
        onChange={(event) => {
          setNote(event.target.value);
        }}
      />
      <div className="f-revise-row">
        <span className={error ? 'error' : undefined} role={error ? 'alert' : undefined}>
          {error ?? 'Every agent gets the new question. The earlier versions stay.'}
        </span>
        <button type="button" className="linkbtn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="submit" className="btn" disabled={!ready}>
          {saving ? 'Saving' : 'Save'}
        </button>
      </div>
    </form>
  );
}

/** The line that says how often the person revised the question. It unfolds the versions, oldest first. */
function Versions(props: {
  readonly versions: readonly QuestionVersion[];
  readonly now: Date;
}): ReactElement | null {
  const line = revisedLine(props.versions);
  if (line === null) return null;
  return (
    <details className="f-versions">
      <summary className="f-open">
        {line} <span className="closed">Show earlier versions</span>
        <span className="opened">Hide earlier versions</span>
      </summary>
      <ol>
        {props.versions.map((version, index) => (
          <li key={version.post ?? 'first'}>
            <time dateTime={version.at}>{dayClock(version.at, props.now)}</time>
            {index === props.versions.length - 1 ? <b>Current</b> : null}
            <p>{version.question}</p>
            {revisedBy(version) ? <p className="dim">{revisedBy(version)}</p> : null}
            {version.note && noteLabel(version) !== 'Why' ? (
              <Exact label={noteLabel(version)} text={version.note} />
            ) : version.note ? (
              <p className="dim">Why: {version.note}</p>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Return the line of the reruns that are wanted in a thread, or `null` when none is. */
function wantedIn(lab: LabView, thread: string, now: Date): string | null {
  const wanted = lab.reruns_wanted.filter((line) => line.thread === thread);
  return wantedLine(wanted, lab, now);
}

function number(summary: ThreadSummary): number {
  return Number(summary.thread.id.slice(2));
}

/**
 * Return the authors of some posts, each once, with the latest author first. The API does not say who is in a
 * thread now, so the page shows who posted last and, fainter, who posted before. The blind reruns of a lab from
 * before agents took reruns share one place, because they have no name.
 */
function authors(posts: readonly PostView[], agents: readonly AgentView[]): readonly string[] {
  const known = new Set(members(agents).map((view) => view.agent.id));
  const ids = [...new Set(posts.map((item) => item.post.author).reverse())];
  const rerun = ids.findIndex((id) => id !== PERSON && !known.has(id));
  return ids.filter((id, index) => id === PERSON || known.has(id) || index === rerun);
}

/** The most pictures that a row shows. A count of the others follows them, such as "+2". */
const MOST_PICTURES = 5;

/**
 * A row of pictures, and after them the time of the latest post when `last` gives it. The pictures after the
 * first are fainter, except in a team, where every member counts the same. A press on a picture opens the
 * member's profile.
 */
function Faces(props: {
  readonly ids: readonly string[];
  readonly agents: readonly AgentView[];
  readonly last?: string | null;
  readonly team?: boolean;
}): ReactElement {
  const more = props.ids.length - MOST_PICTURES;
  return (
    <div
      className="f-faces"
      role={props.team ? 'group' : undefined}
      aria-label={props.team ? 'The team' : undefined}
    >
      {props.ids.slice(0, MOST_PICTURES).map((id, index) => (
        <Who key={id} agents={props.agents} id={id} alone ghost={index > 0 && !props.team} />
      ))}
      {more > 0 ? <span className="o-plus">+{more}</span> : null}
      {props.last ? (
        <time dateTime={props.last} title="The latest post">
          {clock(props.last)}
        </time>
      ) : null}
    </div>
  );
}

/** Where a thread's ideas come from, or where they go: the linked threads by title, each with its agents. */
function Cross(props: {
  readonly label: string;
  readonly links: readonly ThreadLink[];
  readonly threads: readonly ThreadSummary[];
  readonly agents: readonly AgentView[];
}): ReactElement | null {
  const lines = crossLines(props.links, props.threads, props.agents);
  if (lines.length === 0) return null;
  return (
    <p className="f-cross">
      <b>{props.label}</b>
      {lines.map((line, index) => (
        <span key={line.thread}>
          <a href={href({ page: 'thread', id: line.thread, post: null })}>{line.title}</a> (
          {line.agents}){index < lines.length - 1 ? ',' : ''}
        </span>
      ))}
    </p>
  );
}

/**
 * The newest report that an agent wrote for the person: who wrote it and how long ago, where it stands when an
 * agent disputes it, what it says, and its detail. The detail is open, because a report's substance is in its
 * body, and the person can fold it. A long detail scrolls in its box. The link goes to the report in its thread,
 * where the earlier reports are.
 */
export function ReportCard(props: {
  readonly report: PostView;
  readonly agents: readonly AgentView[];
  readonly now: Date;
}): ReactElement {
  const { post, at, standing } = props.report;
  const chip = standingChip(post, standing);
  const minutes = minutesBetween(at, props.now);
  return (
    <section className="f-report" aria-labelledby="report-title">
      <div className="f-report-head">
        <h2 id="report-title">Where the lab is</h2>
        <span className="f-by">
          {authorName(props.agents, post.author)} reported{' '}
          <time dateTime={at} title={clock(at)}>
            {minutes < 1 ? 'just now' : `${duration(minutes)} ago`}
          </time>
        </span>
        {chip ? <ChipView chip={chip} /> : null}
        <a href={href({ page: 'thread', id: post.thread, post: post.id })}>See it in its thread</a>
      </div>
      <p className="f-report-text">{post.text}</p>
      {/* The key opens the detail of a new report, also after the person folded an earlier one. */}
      <Detail
        key={post.id}
        post={post.id}
        body={post.body}
        files={post.evidence}
        open
        label="Detail of the report"
      />
    </section>
  );
}

/**
 * How the lab reads the person's question, pinned above the report: the newest reading of an agent, who posted it
 * and how long ago, where it stands when an agent disputes it, what it says, its detail open as on the report card,
 * and a box for the person's reply to it. Without a reading, a line says that the lab has not said how it reads the
 * question, and how long ago the lab opened.
 */
export function ReadingCard(props: {
  readonly reading: PostView | null;
  readonly agents: readonly AgentView[];
  /** When the lab opened. */
  readonly opened: string;
  readonly now: Date;
  /** Post the person's reply to the reading. Without it, the lab has a desk, and the person writes in its chat. */
  readonly onReply?: ((text: string, to: Post) => Promise<void>) | undefined;
}): ReactElement {
  const { onReply } = props;
  const head = <h2 id="reading-title">How the lab reads your question</h2>;
  if (props.reading === null) {
    return (
      <section className="f-report" aria-labelledby="reading-title">
        <div className="f-report-head">{head}</div>
        <p className="dim">
          The lab has not said how it reads your question. It opened {ago(props.opened, props.now)}.
        </p>
      </section>
    );
  }
  const { post, at, standing } = props.reading;
  const chip = standingChip(post, standing);
  const author = authorName(props.agents, post.author);
  return (
    <section className="f-report" aria-labelledby="reading-title">
      <div className="f-report-head">
        {head}
        <span className="f-by">
          {author} posted it{' '}
          <time dateTime={at} title={clock(at)}>
            {ago(at, props.now)}
          </time>
        </span>
        {chip ? <ChipView chip={chip} /> : null}
        <a href={href({ page: 'thread', id: post.thread, post: post.id })}>See it in its thread</a>
      </div>
      <p className="f-report-text">{post.text}</p>
      {/* The key opens the detail of a new reading, also after the person folded an earlier one. */}
      <Detail
        key={post.id}
        post={post.id}
        body={post.body}
        files={post.evidence}
        open
        label="Detail of the reading"
      />
      {onReply ? (
        <Composer
          // A new reading gets an empty box.
          key={`reply-${post.id}`}
          variant="reply"
          label="Reply to the reading"
          placeholder="Say where the lab reads your question wrong"
          button="Reply"
          hint={`Your reply reaches ${author} and the agents that watch its thread.`}
          onSend={(text) => onReply(text, post)}
        />
      ) : (
        <p className="c-lead">
          To correct the reading, say so in the chat with the lab. The desk passes it on to {author}
          .
        </p>
      )}
    </section>
  );
}

/** What a candidate needs from the page beside the candidate itself. */
interface CandidatePlace {
  /** The ID of the question's thread. */
  readonly question: string;
  readonly open: boolean;
  readonly threads: readonly ThreadSummary[];
  readonly agents: readonly AgentView[];
  readonly now: Date;
}

/**
 * The candidate answers, as the server has them now. With none, a line says so. One candidate shows alone, and
 * several stand side by side, as many as the width holds, in the order that they came. With `answered`, the lab
 * is closed: the candidate that its close names shows alone, and the others are folded under it.
 */
function Candidates(
  props: CandidatePlace & { readonly view: CandidatesView; readonly answered: boolean },
): ReactElement {
  const { view, answered, ...place } = props;
  const named = answered ? view.closes_on : null;
  const rest = view.standing.filter((item) => item.candidate.post.id !== named?.candidate.post.id);
  const cards = (items: readonly CandidateView[]): ReactElement => (
    <div className="f-candidates">
      {items.map((item) => (
        <div key={item.candidate.post.id} className="f-candidate">
          <Candidate view={item} {...place} />
        </div>
      ))}
    </div>
  );
  if (named) {
    return (
      <>
        <Candidate view={named} {...place} />
        {rest.length > 0 ? (
          <details className="f-others">
            <summary className="f-open">
              {rest.length === 1 ? '1 other candidate' : `${rest.length} other candidates`}{' '}
              <span className="closed">Show</span>
              <span className="opened">Hide</span>
            </summary>
            {cards(rest)}
          </details>
        ) : null}
      </>
    );
  }
  const [only] = rest;
  if (only === undefined) return <NoCandidate gone={view.gone} agents={place.agents} />;
  return rest.length === 1 ? <Candidate view={only} {...place} /> : cards(rest);
}

/**
 * The line of a lab where no candidate stands: no agent has proposed an answer yet, or every proposal was conceded
 * or replaced. Those proposals are folded under the line, each with its author and a link to it.
 */
function NoCandidate(props: {
  readonly gone: readonly PostView[];
  readonly agents: readonly AgentView[];
}): ReactElement {
  const { gone } = props;
  if (gone.length === 0) return <p className="dim">No agent has proposed an answer yet.</p>;
  return (
    <details className="f-others">
      <summary className="f-open">
        {goneLine(gone.length)} <span className="closed">Show</span>
        <span className="opened">Hide</span>
      </summary>
      <ul className="f-gone">
        {gone.map((item) => (
          <li key={item.post.id}>
            <a href={href({ page: 'thread', id: item.post.thread, post: item.post.id })}>
              {item.post.text}
            </a>{' '}
            <span className="dim">
              {authorName(props.agents, item.post.author)} ·{' '}
              {item.standing === 'conceded' ? 'conceded' : 'replaced'}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * One candidate answer: its headline, where it stands, who proposed it and how long ago, its detail, its files,
 * and what it builds on. A candidate that builds on its author's own entry of a round has that entry's detail
 * and files too. With `open`, the detail follows the headline. Closed, the detail is behind "Read the detail", as
 * on a post in a thread, and a headline of more than 200 characters stops after four lines.
 */
function Candidate(props: CandidatePlace & { readonly view: CandidateView }): ReactElement {
  const { post, at, standing } = props.view.candidate;
  const entry = props.view.entry?.post ?? null;
  const minutes = minutesBetween(at, props.now);
  const under = breakthroughUnder(props.view);
  // An agent proposes in any thread for the whole lab. Outside the question's thread, the candidate names its thread.
  const elsewhere =
    post.thread === props.question
      ? null
      : props.threads.find((summary) => summary.thread.id === post.thread);
  // A headline that a tool takes from an agent shows whole. Only a longer one stops after four lines, closed.
  const look = isLong(post.text) ? (props.open ? 'long' : 'clamp long') : undefined;
  return (
    <>
      <p className={look}>{post.text}</p>
      <div className="f-card-st">
        <ChipView chip={standingChip(post, standing) ?? { label: 'Not checked', tone: 'none' }} />
        {/* The candidate has the badge only when the proposal itself got it. */}
        {hasBreakthrough(props.view.candidate) ? <BadgeChip badge="breakthrough" /> : null}
        <span className="f-by">
          {authorName(props.agents, post.author)} proposed it{' '}
          <time dateTime={at} title={clock(at)}>
            {minutes < 1 ? 'just now' : `${duration(minutes)} ago`}
          </time>
        </span>
      </div>
      {under ? (
        // A candidate that cites a post with the badge has no badge of its own: the line names what it builds on.
        <p className="f-earlier">
          <a href={href({ page: 'thread', id: under.post.thread, post: under.post.id })}>
            Builds on a Breakthrough
          </a>
        </p>
      ) : null}
      {props.view.to_earlier_question ? (
        <p className="f-earlier">This candidate is to an earlier version of the question.</p>
      ) : null}
      {elsewhere ? (
        <p className="f-earlier">
          Proposed in the thread{' '}
          <a href={href({ page: 'thread', id: post.thread, post: post.id })}>
            {elsewhere.thread.title}
          </a>
          .
        </p>
      ) : null}
      <Body id={post.id} body={post.body} open={props.open} />
      <Files post={post.id} files={post.evidence} />
      {entry ? (
        <>
          <p className="f-earlier">
            Proposed from{' '}
            <a href={href({ page: 'thread', id: entry.thread, post: entry.id })}>
              an entry to a round
            </a>
            .
          </p>
          <Body id={entry.id} body={entry.body} open={props.open} />
          <Files post={entry.id} files={entry.evidence} />
        </>
      ) : null}
      <Under view={props.view} open={props.open} />
    </>
  );
}

/** A post's detail: in full with `open`, and else one press away in place, as on a post in a thread. */
function Body(props: {
  readonly id: string;
  readonly body: string;
  readonly open: boolean;
}): ReactElement | null {
  return props.open && props.body ? (
    <div className="f-words">
      <Words text={props.body} />
    </div>
  ) : (
    <Detail post={props.id} body={props.body} files={[]} />
  );
}

/**
 * What a candidate answer builds on: how many posts, and how the results among them stand, such as "Rests on 5
 * results: 2 challenged, 2 reproduced only, 1 not checked". With `open`, each post follows with where it stands,
 * how checks tested it, and whether a result with files has no check of an independent rerun.
 */
function Under(props: {
  readonly view: CandidateView;
  readonly open: boolean;
}): ReactElement | null {
  const { builds_on: posts, no_blind_rerun: waits } = props.view;
  if (posts.length === 0) return null;
  const rests = restsOnLine(props.view.rests_on);
  return (
    <div className="f-under">
      <p>
        Builds on {posts.length === 1 ? '1 post' : `${posts.length} posts`}.
        {rests ? ` ${rests}` : null}
      </p>
      {props.open ? (
        <ul>
          {posts.map((item) => (
            <li key={item.post.id}>
              <ChipView
                chip={
                  standingChip(item.post, item.standing) ?? { label: 'Not checked', tone: 'none' }
                }
              />{' '}
              {testedChips(item.tested).map((mark) => (
                <ChipView key={mark.label} chip={mark} />
              ))}{' '}
              {hasBreakthrough(item) ? <BadgeChip badge="breakthrough" /> : null}{' '}
              <a href={href({ page: 'thread', id: item.post.thread, post: item.post.id })}>
                {clip(item.post.text)}
              </a>
              {waits.includes(item.post.id) ? (
                <span className="dim"> · no independent rerun</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * What waits for the person: the approvals first, then the answers, each with who asks, what, and how long it has
 * waited. A row goes to the Needs you page, where the person answers.
 */
function Waits(props: {
  readonly lab: LabView;
  readonly now: Date;
  /** The posts whose waits show as cards of their own, and not as rows here. */
  readonly skip: ReadonlySet<string>;
}): ReactElement | null {
  const groups = waitGroups(props.lab, props.now)
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => !props.skip.has(row.wait.post)),
    }))
    .filter((group) => group.rows.length > 0);
  const proposed = proposalRows(props.lab, props.now);
  if (groups.length === 0 && proposed.length === 0) return null;
  return (
    <div className="o-waits" id={WAITS_ID}>
      {groups.map((group) => (
        <div key={group.kind}>
          <p className="o-waits-head">{group.heading}</p>
          {group.rows.map((row) => (
            <a key={row.wait.post} className="o-wait" href={href({ page: 'needs' })}>
              <span>
                <b>{row.name}</b> {row.wait.what}
              </span>
              <time dateTime={row.wait.since}>{row.waited}</time>
              <em>{group.word}</em>
            </a>
          ))}
        </div>
      ))}
      {proposed.length > 0 ? (
        // A proposal waits for a second and blocks nothing. Its row goes to the post, where the person decides.
        <div>
          <p className="o-waits-head">{proposalsHeading(proposed.length)}</p>
          {proposed.map((row) => (
            <a
              key={row.proposal.post}
              className="o-wait"
              href={href({ page: 'thread', id: row.proposal.thread, post: row.proposal.post })}
            >
              <span>
                <b>{row.name}</b> proposes a Breakthrough badge
              </span>
              <time dateTime={row.proposal.at}>{row.waited}</time>
              <em>Decide</em>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The band above the wall of a lab where no agent is in a turn: for how long, what waits for the person, which
 * alarms are set, and the time left. It says what starts a turn, and it has no control that wakes agents.
 */
function QuietBand(props: { readonly lab: LabView; readonly now: Date }): ReactElement | null {
  const quiet = quietBand(props.lab, props.now);
  if (quiet === null) return null;
  return (
    <section className="o-quiet" aria-label={quiet.title}>
      <div>
        <h2>{quiet.title}</h2>
        <p>{quiet.text}</p>
      </div>
      <dl>
        <div className={quiet.waits > 0 ? 'hot' : undefined}>
          <dt>Wait for you</dt>
          <dd>{quiet.waits}</dd>
        </div>
        <div>
          <dt>Alarms set</dt>
          <dd>{quiet.alarms}</dd>
          <span>{quiet.next}</span>
        </div>
        <div>
          <dt>Time left</dt>
          <dd>{quiet.left}</dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * One thread on the wall, or an opened side thread. Closed, it shows the title, a status, a mark for new posts, how long ago its line's newest result came and its open obstacles, the headline of the thread's summary, the pictures of its team, the time of the latest post, the one status of the thread, and the threads that it builds on and that build on it. Open, it takes
 * the full width and shows who opened the thread, who a side thread is between, the
 * result that it stands on, and its turns.
 */
function Card(props: {
  readonly summary: ThreadSummary;
  /** Every thread of the lab, for the titles of the threads that this one is linked to. */
  readonly threads: readonly ThreadSummary[];
  readonly agents: readonly AgentView[];
  /** The thread's one status, or `null` when the lab gives none. */
  readonly need: Need | null;
  /** The line of the reruns that are wanted in the thread, or `null` when none is. */
  readonly wanted: string | null;
  /** Whether a post of the thread has a Breakthrough badge. The card shows nothing else about votes. */
  readonly breakthrough: boolean;
  readonly fresh: boolean;
  /** The thread's posts when the card is open, or `null` for a closed card. */
  readonly read: ThreadRead | null;
  readonly turns: (read: ThreadRead) => ReactElement;
  readonly now: Date;
}): ReactElement {
  const { summary, read } = props;
  const { id, title, opened_by: opener } = summary.thread;
  const open = read !== null;
  const status = cardStatus(summary);
  const head = read?.view ? headClaim(read.view.posts) : null;
  // Beside a headline the status is that post's own standing. The summary's count stands alone.
  const chip = head
    ? (standingChip(head.post, head.standing) ?? { label: 'Not checked', tone: 'none' as const })
    : null;
  // A closed card shows the thread's team. A thread without one shows who posted last.
  const team = !read?.view && summary.team.length > 0;
  const ids = read?.view
    ? authors(read.view.posts, props.agents)
    : team
      ? summary.team
      : summary.latest
        ? [summary.latest.author]
        : [];
  // The status says "No result yet" already when it shows. The facts do not say it twice.
  const said = chip || summary.thread.deliverable ? null : status.label;
  const facts = lineFacts(summary, props.now).filter((fact) => fact !== said);
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
        {open ? <p className="f-by">{authorName(props.agents, opener)} opened it</p> : null}
        {open && isSide(summary) ? (
          <p className="f-by">{betweenLine(summary.members, props.agents)}</p>
        ) : null}
        <div className="f-card-st">
          {chip ? (
            <ChipView chip={chip} />
          ) : summary.thread.deliverable ? null : (
            <span className={`f-st fs-count-${status.edge}`}>{status.label}</span>
          )}
          {testedChips(head?.tested).map((mark) => (
            <ChipView key={mark.label} chip={mark} />
          ))}
          {status.openAsks ? <span className="f-st fs-ask">{status.openAsks}</span> : null}
          {status.openCalls ? <span className="f-st fs-ask">{status.openCalls}</span> : null}
          {props.breakthrough ? <BadgeChip badge="breakthrough" /> : null}
        </div>
        {facts.length > 0 ? <p className="f-facts">{facts.join(' · ')}</p> : null}
        {head ? (
          <p className={isLong(head.post.text) ? 'f-head long' : 'f-head'}>{head.post.text}</p>
        ) : null}
        {/* A closed card says what the thread established, in its summary's headline. */}
        {!open && summary.summary ? (
          <p className={isLong(summary.summary.text) ? 'f-head long' : 'f-head'}>
            {summary.summary.text}
          </p>
        ) : null}
        <WorkList tasks={summary.tasks} open={open} agents={props.agents} now={props.now} />
        <Faces ids={ids} agents={props.agents} last={open ? null : summary.last_at} team={team} />
        {props.need ? (
          <div className="o-card-need">
            <span className={`o-st o-${props.need}`}>{NEED_WORDS[props.need]}</span>
          </div>
        ) : null}
        {props.wanted ? <p className="o-wanted">{props.wanted}</p> : null}
        <OpenedForYou summary={summary} agents={props.agents} />
        <Cross
          label="Builds on"
          links={summary.builds_on_threads}
          threads={props.threads}
          agents={props.agents}
        />
        <Cross
          label="Built on by"
          links={summary.built_on_by_threads}
          threads={props.threads}
          agents={props.agents}
        />
      </header>
      {read ? props.turns(read) : null}
    </section>
  );
}

/**
 * The pieces of work of a thread that an agent handed out and that are not done: what each asks for, and who is
 * on it for how long. A closed card lists a few, and the opened thread lists every one.
 */
function WorkList(props: {
  readonly tasks: readonly TaskCard[];
  readonly open: boolean;
  readonly agents: readonly AgentView[];
  readonly now: Date;
}): ReactElement | null {
  const { shown, more } = cardTasks(props.tasks, props.open);
  if (shown.length === 0) return null;
  return (
    <ul className="f-work" aria-label="Pieces of work">
      {shown.map((work) => (
        <li key={work.task} className={`fw-${work.state}`}>
          <span className="f-work-text">{work.text}</span>
          <span className="f-work-on">{onItLine(work, props.agents, props.now)}</span>
        </li>
      ))}
      {more > 0 ? (
        <li className="f-work-more">
          {more === 1 ? '1 more piece of work' : `${more} more pieces of work`}
        </li>
      ) : null}
    </ul>
  );
}

/**
 * The lab's obstacles after the cards: the ruled-out posts of its lines of work, in three groups. The open ones
 * show, and the taken-up and removed ones are folded with their counts. Each row has the obstacle's headline,
 * its thread, who posted it and how long ago, where it stands when that is not open, and for a taken-up or
 * removed obstacle a link to the post that builds on it. Nothing shows while the lab has no obstacle.
 */
export function Obstacles(props: {
  readonly obstacles: readonly Obstacle[];
  readonly threads: readonly ThreadSummary[];
  readonly agents: readonly AgentView[];
  readonly now: Date;
}): ReactElement | null {
  const groups = obstacleGroups(props.obstacles);
  if (groups.length === 0) return null;
  return (
    <section className="f-obstacles" aria-labelledby="obstacles-title">
      <h2 id="obstacles-title">Obstacles</h2>
      {groups.map((group) => (
        <details key={group.state} open={group.state === 'open'}>
          <summary>{group.label}</summary>
          <ul>
            {group.items.map((item) => (
              <ObstacleRow
                key={item.post.id}
                item={item}
                threads={props.threads}
                agents={props.agents}
                now={props.now}
              />
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}

function ObstacleRow(props: {
  readonly item: Obstacle;
  readonly threads: readonly ThreadSummary[];
  readonly agents: readonly AgentView[];
  readonly now: Date;
}): ReactElement {
  const { post, at, standing } = props.item;
  const title = props.threads.find((summary) => summary.thread.id === post.thread)?.thread.title;
  const chip = standingChip(post, standing);
  const builder = builderLine(props.item, (id) => called(props.agents, id));
  return (
    <li>
      <a href={href({ page: 'thread', id: post.thread, post: post.id })}>{post.text}</a>
      <span className="f-by">
        <a href={href({ page: 'thread', id: post.thread, post: null })}>{title ?? post.thread}</a>
        {' · '}
        {authorName(props.agents, post.author)}
        {' · '}
        <time dateTime={at} title={clock(at)}>
          {ago(at, props.now)}
        </time>
      </span>
      {chip ? <ChipView chip={chip} /> : null}
      {builder ? (
        <a className="f-by" href={href({ page: 'thread', id: builder.thread, post: builder.id })}>
          {builder.text}
        </a>
      ) : null}
    </li>
  );
}
