import type { ReactNode } from 'react';
import type { Lab, Snapshot } from '../../protocol/api.ts';
import { checkLine } from '../answer.ts';
import { harnessName, modelName } from '../format.ts';
import { href } from '../route.ts';
import type { Connection } from '../store.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { Avatar } from '../components/Avatar.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { Chevron } from '../components/Icons.tsx';
import { Turns, type AgentActions } from './DirectionPage.tsx';
import type { LabActions } from './LabHome.tsx';

/**
 * An agent on its own page, such as a checker, which owns no direction: who
 * it is, what it does, and its turns, folded as on a direction's page.
 */
export function AgentPage({
  snapshot,
  lab,
  id,
  connection,
  now,
  actions,
  agentActions,
}: {
  readonly snapshot: Snapshot;
  readonly lab: Lab;
  readonly id: string;
  readonly connection: Connection;
  readonly now: number;
  readonly actions: LabActions;
  readonly agentActions: AgentActions;
}): ReactNode {
  const agent = lab.agents.find((entry) => entry.id === id);
  const check = lab.checks.filter((entry) => entry.agent === id).at(-1);
  const owned = lab.directions.find((entry) => entry.agent === id);
  const checked = check
    ? lab.directions.find((entry) => entry.id === check.direction)
    : undefined;
  return (
    <div className="page">
      <AppHeader
        project={snapshot.project}
        lab={lab}
        now={now}
        onPause={actions.pause}
      />
      <main className="main">
        <div className="column column--detail">
          <ConnectionBar connection={connection} at={snapshot.at} />
          <a className="back" href={href.lab}>
            <Chevron to="left" />
            The lab
          </a>
          {agent ? (
            <>
              <div className="agent-head">
                <Avatar
                  who={{ harness: agent.harness, handle: agent.handle }}
                  size="lg"
                />
                <div className="agent-head__text">
                  <h1 className="page-title">{agent.handle}</h1>
                  <p className="direction-head__meta">
                    {harnessName(agent.harness)}
                    {agent.model && (
                      <>
                        {' '}
                        <span title={agent.model}>
                          {modelName(agent.model)}
                        </span>
                      </>
                    )}
                    {owned && (
                      <>
                        {' · Works on '}
                        <a href={href.direction(owned.id)}>{owned.title}</a>
                      </>
                    )}
                    {check && (
                      <>
                        {' · Checks '}
                        <a href={href.post(check.post)}>{check.post}</a>
                        {checked && (
                          <>
                            {' in '}
                            <a href={href.direction(checked.id)}>
                              {checked.title}
                            </a>
                          </>
                        )}
                        {check.blind
                          ? ", without the author's reasoning"
                          : ", and could read the lab's records"}
                      </>
                    )}
                  </p>
                  {check && (
                    <p className="direction-head__meta">
                      {checkLine(lab, check.post)}.
                    </p>
                  )}
                </div>
              </div>
              <Turns
                agent={agent}
                turnHref={(turn) => href.agentTurn(id, turn)}
                lab={lab}
                now={now}
                run={null}
                agentActions={agentActions}
              />
            </>
          ) : (
            <p className="turns__none">
              {lab.omitted.agents !== undefined
                ? 'This view of a large lab leaves out this agent.'
                : 'This agent is not in the lab.'}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
