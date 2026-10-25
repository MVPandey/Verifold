import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  Lab,
  Post,
  QuestionAnswer,
  Snapshot,
} from '../../protocol/api.ts';
import { signedOff } from '../answer.ts';
import type { ActOutcome } from '../api.ts';
import {
  boardLink,
  byNumber,
  filledPosts,
  joinPosts,
  threads,
  type OlderPosts,
} from '../board.ts';
import { ControlsContext } from '../controls.ts';
import { authorOf, cut } from '../format.ts';
import { mentionNames } from '../mentions.ts';
import { href, replaceRoute } from '../route.ts';
import type { Connection } from '../store.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { BoardThread, showPost } from '../components/BoardThread.tsx';
import { Composer } from '../components/Composer.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { DirectionRow } from '../components/DirectionRow.tsx';
import { NeedsYouLine } from '../components/NeedsYouLine.tsx';
import { StatusBar } from '../components/StatusBar.tsx';
import { AnswerLine } from '../components/AnswerLine.tsx';
import { AwayDigest } from '../components/AwayDigest.tsx';
import {
  Disputes,
  MoreTime,
  OpenDirection,
  WorksLine,
} from '../components/LabControls.tsx';
import { NotifyLine } from '../components/NotifyLine.tsx';
import { PodNeeds, PodsLine, type PodActions } from '../components/Pods.tsx';
import { waitingPods } from '../pods.ts';
import { failureOf } from '../call.ts';
import { ToolsContext } from '../tools.ts';
import {
  noDirectionsLine,
  plannerEndLine,
  plannerState,
} from '../../ui/lab-lines.ts';
import {
  StartAgain,
  canStartAgain,
  type AgentActions,
} from './DirectionPage.tsx';
import { PlannerComposer, Scoping, planQuestions } from './Scoping.tsx';

/** Pages of older posts that a gap fill reads at most, before it gives the older posts up. */
const gapPages = 10;

export interface LabActions {
  /** Write to the lab. `key` marks the person's intent (see intent.ts). */
  readonly post: (text: string, key: string) => Promise<ActOutcome>;
  readonly pause: (pause: boolean, key: string) => Promise<ActOutcome>;
  /** Answer a call with one of its options, by its index in the call. */
  readonly answer: (
    call: string,
    option: number,
    key: string,
  ) => Promise<ActOutcome>;
  /** Answer a call in the person's own words. */
  readonly words: (
    call: string,
    text: string,
    key: string,
  ) => Promise<ActOutcome>;
  readonly undo: (call: string, key: string) => Promise<ActOutcome>;
  /** Answer each of the planner's questions before the plan with its pick. */
  readonly skip: (key: string) => Promise<ActOutcome>;
  /** Answer the planner's questions before the plan together. */
  readonly questions: (
    answers: readonly QuestionAnswer[],
    key: string,
  ) => Promise<ActOutcome>;
}

/**
 * The lab's home: what needs the person, the directions with their live
 * lines, the board, and a box to write to the lab. One column, as on the v9
 * canvas ("8. The lab at work"). Depth opens on its own page. `show`: a post
 * on the board that a link to it (`#/board/<id>`) brings into view. Before
 * the plan, the planner's work and its questions take the place of the
 * directions ("6 Scoping"). A planner that ended before the plan leaves the
 * home as it is after the plan, with a line that says how it ended and, for
 * a crash, Start again. A lab whose planner did not start says so. With
 * `pods`, a pod that waits for the person
 * shows in Needs you, with Approve and Deny, and so do pod actions that
 * failed in the background and pod notices.
 */
export function LabHome({
  snapshot,
  lab,
  connection,
  now,
  actions,
  agentActions,
  pods,
  show = null,
}: {
  readonly snapshot: Snapshot;
  readonly lab: Lab;
  readonly connection: Connection;
  readonly now: number;
  readonly actions: LabActions;
  /** Without them, the lab before its plan shows as it does after it. */
  readonly agentActions?: AgentActions;
  readonly pods?: PodActions;
  readonly show?: string | null;
}): ReactNode {
  const agents = new Map(lab.agents.map((agent) => [agent.id, agent]));
  const planner = lab.planner ? agents.get(lab.planner) : undefined;
  const plannerDirection = lab.directions.find(
    (entry) => entry.id === planner?.direction,
  );
  const controls = useContext(ControlsContext);
  // The person can open a direction, and start a crashed planner again, from this tab.
  const act = controls !== null && lab.agentsHere;
  const state = plannerState(lab, planner?.status);
  const ended =
    planner && state && state !== 'missing'
      ? {
          line: plannerEndLine(state, act),
          restart: canStartAgain(planner, lab, controls),
        }
      : null;
  // Without a planner or directions, nothing works in the lab until the person acts.
  const stuck =
    ended !== null || (state === 'missing' && lab.directions.length === 0);
  const scoping =
    !lab.plan && !ended && planner && plannerDirection && agentActions
      ? { planner, direction: plannerDirection, agentActions }
      : null;
  // The planner's questions show as cards, so the Needs-you line leaves them out.
  const questions = scoping ? planQuestions(lab) : [];
  const asked = new Set(questions.map((call) => call.id));
  const announced = new Set(questions.map((call) => call.post));
  const [first, ...rest] = lab.needsYou.filter((call) => !asked.has(call.id));
  const compute = snapshot.compute;
  const waiting = compute && pods ? waitingPods(compute).length : 0;
  const tools = useContext(ToolsContext);
  const [replyTo, setReplyTo] = useState<Post | null>(null);
  const older = useOlderPosts(lab);
  // Older pages hold question posts too, so the filter applies after the join.
  const shownPosts = scoping
    ? older.posts.filter((post) => !announced.has(post.id))
    : older.posts;
  const replies = act ? controls : null;
  const box = useRef<HTMLDivElement>(null);
  // After the board rendered: then the post is on the page.
  useEffect(() => {
    if (!show) return;
    const link = boardLink(lab, show);
    if (link.show) showPost(link.show);
    replaceRoute(link.route);
  }, [show, lab]);
  return (
    <div className="page">
      <AppHeader
        project={snapshot.project}
        own={snapshot.ownProfile === true}
        lab={lab}
        now={now}
        onPause={actions.pause}
      />
      <main className="main">
        <div className="column">
          <ConnectionBar connection={connection} at={snapshot.at} />
          {lab.away && (
            <AwayDigest
              away={lab.away}
              now={now}
              onDismiss={tools?.dismissAway ?? null}
            />
          )}
          {first && (
            <NeedsYouLine
              call={first}
              more={rest.length}
              now={now}
              failure={failureOf(lab, first)?.text ?? null}
            />
          )}
          {compute && pods && (
            <PodNeeds compute={compute} lab={lab} now={now} actions={pods} />
          )}
          {/* A waiting pod leaves the paused bar: a pod that the person approves starts in a paused lab too. */}
          {first ? null : lab.paused ? (
            <StatusBar tone="muted">
              {lab.paused.reason === 'deadline'
                ? 'The time budget ended, so the lab is paused.'
                : 'Paused. Agents start no new turns until you resume.'}
            </StatusBar>
          ) : (
            // Before the plan, the planner's own line says what happens.
            !scoping &&
            !stuck &&
            !waiting && <StatusBar tone="ok">Nothing needs you.</StatusBar>
          )}
          {ended && planner && (
            <>
              <StatusBar tone="need">{ended.line}</StatusBar>
              {ended.restart && (
                <div className="start-again">
                  <StartAgain agent={planner.id} />
                </div>
              )}
            </>
          )}
          {lab.paused?.reason === 'deadline' && lab.agentsHere && <MoreTime />}
          <WorksLine lab={lab} />
          <PodsLine compute={compute} />
          {lab.answered.map((call) => (
            <AnswerLine
              key={call.id}
              call={call}
              lab={lab}
              now={now}
              question
              onUndo={actions.undo}
            />
          ))}
          {scoping ? (
            <Scoping
              lab={lab}
              planner={scoping.planner}
              direction={scoping.direction}
              now={now}
              actions={actions}
              agentActions={scoping.agentActions}
            />
          ) : lab.directions.length > 0 ? (
            <section className="section" aria-labelledby="directions">
              <div className="section__head">
                <h2 id="directions" className="section__title">
                  Directions
                </h2>
                <a className="section__link" href={href.answer}>
                  {signedOff(lab) ? 'The answer' : 'The answer so far'}
                </a>
              </div>
              <div className="rows">
                {lab.directions.map((direction) => (
                  <DirectionRow
                    key={direction.id}
                    direction={direction}
                    agent={agents.get(direction.agent)}
                    now={now}
                  />
                ))}
              </div>
              {lab.omitted.directions !== undefined && (
                <span className="more">
                  {lab.omitted.directions} more not shown
                </span>
              )}
            </section>
          ) : (
            <StatusBar tone={state === 'missing' ? 'need' : 'plan'}>
              {noDirectionsLine(state === 'missing', act)}
            </StatusBar>
          )}
          {!scoping && lab.agentsHere && <OpenDirection />}
          {shownPosts.length > 0 && (
            <section className="section section--board" aria-labelledby="board">
              <h2 id="board" className="section__title">
                Board
              </h2>
              <Disputes lab={lab} />
              {older.more && (
                <button
                  type="button"
                  className="link-button"
                  disabled={older.busy}
                  onClick={() => void older.show()}
                >
                  Show older posts
                </button>
              )}
              {older.gap && (
                <p className="turns__none">Reading the posts in between…</p>
              )}
              {older.problem && (
                <span role="alert" className="composer__error">
                  {older.problem}
                </span>
              )}
              {threads(shownPosts).map((thread) => (
                <BoardThread
                  key={thread.root.id}
                  thread={thread}
                  lab={lab}
                  {...(replies
                    ? {
                        onReply: (post: Post) => {
                          setReplyTo(post);
                          box.current?.querySelector('input')?.focus();
                        },
                      }
                    : {})}
                />
              ))}
            </section>
          )}
          {snapshot.trimmed && (
            <span className="more">
              This lab is large, so this page leaves out some older items.
            </span>
          )}
          {scoping ? (
            <PlannerComposer lab={lab} {...scoping} />
          ) : (
            <div ref={box}>
              <Composer
                label="Write to the lab"
                placeholder="Reply, or @mention an agent"
                maxLength={lab.postLimit}
                names={mentionNames(lab)}
                onSend={
                  replyTo && replies
                    ? (text, key) => replies.reply(replyTo.id, text, key)
                    : actions.post
                }
                replying={
                  replyTo
                    ? {
                        post: replyTo.id,
                        to: authorOf(replyTo),
                        text: cut(replyTo.text, 80),
                        onStop: () => setReplyTo(null),
                      }
                    : undefined
                }
                onSent={() => setReplyTo(null)}
              />
            </div>
          )}
          <NotifyLine />
        </div>
      </main>
    </div>
  );
}

/**
 * The board: older pages read on request, then the snapshot's newest page.
 * When new posts push the older pages' anchor out of the newest page, the
 * posts between are read before anything older shows again, so no post is
 * ever missing from the list, as with an agent's turns.
 */
function useOlderPosts(lab: Lab): {
  /** Every post to show, oldest first. */
  readonly posts: readonly Post[];
  readonly more: boolean;
  /** The posts between the older pages and the newest page are being read. */
  readonly gap: boolean;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly show: () => Promise<void>;
} {
  const controls = useContext(ControlsContext);
  const [older, setOlder] = useState<OlderPosts | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A ref, so two clicks in one frame read once.
  const loading = useRef(false);
  // A gap fill makes reads that started before it stale.
  const epoch = useRef(0);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const { posts, gap } = joinPosts(older, lab.board.posts);
  const anchor = older?.anchor ?? null;
  useEffect(() => {
    if (!controls || !gap || !older) return;
    const controller = new AbortController();
    const mine = ++epoch.current;
    void (async () => {
      const pages: (readonly Post[])[] = [];
      let before = gap;
      for (let page = 0; page < gapPages; page++) {
        const loaded = await controls.board(before, controller.signal);
        if (controller.signal.aborted || mine !== epoch.current) return;
        if ('error' in loaded) {
          // The list stays whole: the newest page alone, and "Show older posts" again.
          setOlder(null);
          setProblem(loaded.error);
          return;
        }
        pages.push(loaded.value.posts);
        const first = loaded.value.posts[0];
        if (
          !first ||
          !loaded.value.more ||
          loaded.value.posts.some((post) => post.id === older.anchor)
        )
          break;
        before = first.id;
      }
      setOlder(filledPosts(older, pages, gap));
    })();
    return () => controller.abort();
    // The fill depends on the gap and the anchor, not on each new `older`.
  }, [gap, anchor, controls]);
  return {
    posts,
    more: controls !== null && !gap && (older ? older.more : lab.board.more),
    gap: gap !== null,
    busy,
    problem,
    show: async () => {
      const first = posts[0];
      if (!controls || !first || loading.current) return;
      loading.current = true;
      setBusy(true);
      const controller = new AbortController();
      pending.current = controller;
      const mine = epoch.current;
      const loaded = await controls.board(first.id, controller.signal);
      loading.current = false;
      setBusy(false);
      if (controller.signal.aborted || mine !== epoch.current) return;
      if ('error' in loaded) {
        setProblem(loaded.error);
        return;
      }
      setProblem(null);
      setOlder((current) => ({
        posts: byNumber([loaded.value.posts, current?.posts ?? []]),
        more: loaded.value.more,
        anchor: current?.anchor ?? first.id,
      }));
    },
  };
}
