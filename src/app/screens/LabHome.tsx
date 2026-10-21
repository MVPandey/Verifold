import type { ReactNode } from 'react';
import type { Lab, Snapshot } from '../../protocol/api.ts';
import { signedOff } from '../answer.ts';
import type { ActOutcome } from '../api.ts';
import { threads } from '../board.ts';
import type { Connection } from '../store.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { BoardThread } from '../components/BoardThread.tsx';
import { Composer } from '../components/Composer.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { DirectionRow } from '../components/DirectionRow.tsx';
import { NeedsYouLine } from '../components/NeedsYouLine.tsx';
import { StatusBar } from '../components/StatusBar.tsx';
import { AnswerLine } from '../components/AnswerLine.tsx';
import { failureOf } from '../call.ts';
import { href } from '../route.ts';

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
}

/**
 * The lab's home: what needs the person, the directions with their live
 * lines, the board, and a box to write to the lab. One column, as on the v9
 * canvas ("8. The lab at work"). Depth opens on its own page.
 */
export function LabHome({
  snapshot,
  lab,
  connection,
  now,
  actions,
}: {
  readonly snapshot: Snapshot;
  readonly lab: Lab;
  readonly connection: Connection;
  readonly now: number;
  readonly actions: LabActions;
}): ReactNode {
  const agents = new Map(lab.agents.map((agent) => [agent.id, agent]));
  const [first, ...rest] = lab.needsYou;
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
            <StatusBar tone="ok">Nothing needs you.</StatusBar>
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
          {lab.directions.length > 0 ? (
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
          {lab.board.posts.length > 0 && (
            <section className="section section--board" aria-labelledby="board">
              <h2 id="board" className="section__title">
                Board
              </h2>
              {lab.board.more && (
                <span className="more">
                  Older posts are not shown here yet.
                </span>
              )}
              {threads(lab.board.posts).map((thread) => (
                <BoardThread key={thread.root.id} thread={thread} />
              ))}
            </section>
          )}
          {snapshot.trimmed && (
            <span className="more">
              This lab is large, so this page leaves out some older items.
            </span>
          )}
          <Composer
            label="Write to the lab"
            placeholder="Reply, or @mention an agent"
            maxLength={lab.postLimit}
            onSend={actions.post}
          />
        </div>
      </main>
    </div>
  );
}
