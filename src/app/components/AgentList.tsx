import type { ReactNode } from 'react';
import type { Lab } from '../../protocol/api.ts';
import {
  agentRows,
  readingWords,
  rowAge,
  rowDetail,
  rowMore,
  type AgentRow,
} from '../agent-rows.ts';
import { roleName } from '../format.ts';
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
  const detail = rowDetail(row, mode);
  const age = rowAge(row, now);
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
        <IdText text={row.line} />
        {age && <span className="agent-row__at"> {age}</span>}
      </div>
      {rowMore(row, mode).map((line) => (
        <div key={line} className="agent-row__line agent-row__more">
          <IdText text={line} />
        </div>
      ))}
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
  const reading = lab.reading ? readingWords(lab.reading, now) : null;
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
            <span>{reading.line}</span>
            {reading.age && (
              <span className="state state--wait state--flat">
                {reading.age}
              </span>
            )}
          </p>
        )}
      </div>
    </section>
  );
}
