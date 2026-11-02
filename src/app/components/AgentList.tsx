import type { ReactNode } from 'react';
import type { Lab } from '../../protocol/api.ts';
import { agentRows, type AgentRow } from '../agent-rows.ts';
import { shortTime } from '../brief-view.ts';
import {
  agentDetail,
  clock,
  harnessLabel,
  roleName,
  since,
} from '../format.ts';
import { href } from '../route.ts';
import { useView } from '../view-mode.ts';
import { Avatar } from './Avatar.tsx';
import { IdText } from './IdText.tsx';

function Row({
  row,
  now,
}: {
  readonly row: AgentRow;
  readonly now: number;
}): ReactNode {
  const { mode } = useView();
  const { agent, direction, chip } = row;
  const technical = mode === 'technical';
  const detail =
    technical && direction
      ? `${agent.job ? `${agent.job}, ` : ''}${direction.id} · ${harnessLabel(agent.harness)}`
      : agentDetail(agent);
  return (
    <div className="agent-row">
      <Avatar
        who={{ harness: agent.harness, handle: agent.handle }}
        size="lg"
        labelled
      />
      <div className="agent-row__top">
        <a
          className="agent-row__name"
          href={direction ? href.direction(direction.id) : href.agent(agent.id)}
        >
          {roleName(agent.handle)}
        </a>
        {detail && (
          <span className="agent-row__job">
            <IdText text={detail} />
          </span>
        )}
        <span className={`state state--${chip.tone}`}>{chip.label}</span>
      </div>
      <div className="agent-row__line">
        <IdText text={technical ? row.line : (row.ended ?? row.line)} />
        {row.statusAt && (
          <span className="agent-row__at">
            {' '}
            {clock(row.statusAt)}, {since(row.statusAt, now)} ago
          </span>
        )}
      </div>
      {technical && row.next && (
        <div className="agent-row__line agent-row__more">
          Next: <IdText text={row.next} />
        </div>
      )}
      {technical && row.run && (
        <div className="agent-row__line agent-row__more">
          <IdText text={row.run} />
        </div>
      )}
      {row.wait && (
        <div className="agent-row__line agent-row__more">
          <IdText text={row.wait} />
        </div>
      )}
      {row.helpers && (
        <div className="agent-row__line agent-row__more">{row.helpers}</div>
      )}
    </div>
  );
}

/** Who is doing what: the agents, and what the lab has read. */
export function AgentList({
  lab,
  now,
  answer,
}: {
  readonly lab: Lab;
  readonly now: number;
  /** The words of the link to the answer. */
  readonly answer: string;
}): ReactNode {
  const { reading } = lab;
  return (
    <section aria-labelledby="who">
      <div className="section-head">
        <h2 id="who" className="section-title">
          Who is doing what
        </h2>
        <a className="section-link" href={href.answer}>
          {answer}
        </a>
      </div>
      <div className="card">
        {agentRows(lab, now).map((row) => (
          <Row key={row.agent.id} row={row} now={now} />
        ))}
        {reading && (
          <p className="lit">
            <span>
              Reading map: {reading.papers}{' '}
              {reading.papers === 1 ? 'paper' : 'papers'}.{' '}
              {reading.lastPaperAt
                ? `Last paper read at ${shortTime(reading.lastPaperAt, now)}.`
                : 'No paper read yet.'}
            </span>
            {reading.lastPaperAt && (
              <span className="state state--wait state--flat">
                {since(reading.lastPaperAt, now)} ago
              </span>
            )}
          </p>
        )}
      </div>
    </section>
  );
}
