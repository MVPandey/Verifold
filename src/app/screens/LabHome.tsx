import type { ReactNode } from 'react';
import type { Lab, Snapshot } from '../../protocol/api.ts';
import { threads } from '../board.ts';
import { clock } from '../format.ts';
import type { Connection } from '../store.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { BoardThread } from '../components/BoardThread.tsx';
import { Composer } from '../components/Composer.tsx';
import { DirectionRow } from '../components/DirectionRow.tsx';
import { NeedsYouLine } from '../components/NeedsYouLine.tsx';
import { StatusBar } from '../components/StatusBar.tsx';

export interface LabActions {
  /** Write to the lab. Resolves to Verifold's reason when it refused. */
  readonly post: (text: string) => Promise<string | null>;
  readonly pause: (pause: boolean) => Promise<string | null>;
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
          {connection === 'reconnecting' && (
            <StatusBar tone="muted">
              Reconnecting to Verifold. This shows the lab as of{' '}
              {clock(snapshot.at)}.
            </StatusBar>
          )}
          {first ? (
            <NeedsYouLine call={first} more={rest.length} now={now} />
          ) : lab.paused ? (
            <StatusBar tone="muted">
              {lab.paused.reason === 'deadline'
                ? 'The time budget ended, so the lab is paused.'
                : 'Paused. Agents start no new turns until you resume.'}
            </StatusBar>
          ) : (
            <StatusBar tone="ok">Nothing needs you.</StatusBar>
          )}
          {lab.directions.length > 0 ? (
            <section className="section" aria-labelledby="directions">
              <h2 id="directions" className="section__title">
                Directions
              </h2>
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
            onSend={actions.post}
          />
        </div>
      </main>
    </div>
  );
}
