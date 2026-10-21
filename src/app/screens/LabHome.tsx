import { useContext, useEffect, type ReactNode } from 'react';
import type { Lab, QuestionAnswer, Snapshot } from '../../protocol/api.ts';
import { signedOff } from '../answer.ts';
import type { ActOutcome } from '../api.ts';
import { boardLink, threads } from '../board.ts';
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
import { NotifyLine } from '../components/NotifyLine.tsx';
import { failureOf } from '../call.ts';
import { ToolsContext } from '../tools.ts';
import type { AgentActions } from './DirectionPage.tsx';
import { PlannerComposer, Scoping, planQuestions } from './Scoping.tsx';

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
 * directions ("6 Scoping").
 */
export function LabHome({
  snapshot,
  lab,
  connection,
  now,
  actions,
  agentActions,
  show = null,
}: {
  readonly snapshot: Snapshot;
  readonly lab: Lab;
  readonly connection: Connection;
  readonly now: number;
  readonly actions: LabActions;
  /** Without them, the lab before its plan shows as it does after it. */
  readonly agentActions?: AgentActions;
  readonly show?: string | null;
}): ReactNode {
  const agents = new Map(lab.agents.map((agent) => [agent.id, agent]));
  const planner = lab.planner ? agents.get(lab.planner) : undefined;
  const plannerDirection = lab.directions.find(
    (entry) => entry.id === planner?.direction,
  );
  const scoping =
    !lab.plan && planner && plannerDirection && agentActions
      ? { planner, direction: plannerDirection, agentActions }
      : null;
  // The planner's questions show as cards, so the Needs-you line leaves them out.
  const questions = scoping ? planQuestions(lab) : [];
  const asked = new Set(questions.map((call) => call.id));
  const announced = new Set(questions.map((call) => call.post));
  const [first, ...rest] = lab.needsYou.filter((call) => !asked.has(call.id));
  const posts = scoping
    ? lab.board.posts.filter((post) => !announced.has(post.id))
    : lab.board.posts;
  const tools = useContext(ToolsContext);
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
          {first ? (
            <NeedsYouLine
              call={first}
              more={rest.length}
              now={now}
              failure={failureOf(lab, first)?.text ?? null}
            />
          ) : lab.paused ? (
            <StatusBar tone="muted">
              {lab.paused.reason === 'deadline'
                ? 'The time budget ended, so the lab is paused.'
                : 'Paused. Agents start no new turns until you resume.'}
            </StatusBar>
          ) : (
            // Before the plan, the planner's own line says what happens.
            !scoping && <StatusBar tone="ok">Nothing needs you.</StatusBar>
          )}
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
            <StatusBar tone="plan">
              The planner is reading. Directions show here when the plan is
              ready.
            </StatusBar>
          )}
          {posts.length > 0 && (
            <section className="section section--board" aria-labelledby="board">
              <h2 id="board" className="section__title">
                Board
              </h2>
              {lab.board.more && (
                <span className="more">
                  Older posts are not shown here yet.
                </span>
              )}
              {threads(posts).map((thread) => (
                <BoardThread key={thread.root.id} thread={thread} lab={lab} />
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
            <Composer
              label="Write to the lab"
              placeholder="Reply, or @mention an agent"
              maxLength={lab.postLimit}
              onSend={actions.post}
            />
          )}
          <NotifyLine />
        </div>
      </main>
    </div>
  );
}
