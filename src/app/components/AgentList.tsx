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
import { foldsTeams, teamRows, troubles } from '../team-view.ts';
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

/** What the lab has read, with its way to the idea map. */
function ReadingLine({
  lab,
  now,
}: {
  readonly lab: Lab;
  readonly now: number;
}): ReactNode {
  const reading = lab.reading ? readingWords(lab.reading, now) : null;
  if (!reading) return null;
  return (
    <a className="lit" href={href.ideas}>
      <span>{reading.line}</span>
      {reading.age && (
        <span className="state state--wait state--flat">{reading.age}</span>
      )}
    </a>
  );
}

/** The agents in trouble past 6 agents: each by name, with its wait. */
function NeedsALook({
  lab,
  now,
}: {
  readonly lab: Lab;
  readonly now: number;
}): ReactNode {
  const { mode } = useView();
  const list = troubles(lab, mode, now);
  const total = lab.agents.filter((agent) => agent.direction !== null).length;
  return (
    <section aria-labelledby="look">
      <div className="section-head">
        <h2 id="look" className="section-title">
          Needs a look · {list.length} of {total} agents
        </h2>
      </div>
      {list.length ? (
        <div className="card">
          {list.map(({ agent, line, chip }) => (
            <div key={agent.id} className="row2">
              <span className="row2__text">
                <a
                  className="agent-row__name"
                  href={
                    agent.direction
                      ? href.direction(agent.direction)
                      : href.agent(agent.id)
                  }
                >
                  {roleName(agent.handle)}
                </a>{' '}
                <IdText text={line} />
              </span>
              <span className={`state state--${chip.tone}`}>{chip.label}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="reach">No agent needs a look now.</p>
      )}
    </section>
  );
}

/** The agents by team past 6 agents. A team opens its agents. */
function Teams({
  lab,
  now,
  answer,
}: {
  readonly lab: Lab;
  readonly now: number;
  readonly answer: string;
}): ReactNode {
  const { mode } = useView();
  const teams = teamRows(lab, mode, now);
  return (
    <section aria-labelledby="teams">
      <div className="section-head">
        <h2 id="teams" className="section-title">
          Teams · {teams.length}
        </h2>
        <span className="section-links">
          <a className="section-link" href={href.team}>
            How they work together
          </a>
          <a className="section-link" href={href.answer}>
            {answer}
          </a>
        </span>
      </div>
      <div className="card">
        {teams.map((team) => (
          <details key={team.name} className="team">
            <summary className="row2">
              <b>
                {team.name} · {team.members}
              </b>
              <span className={`state state--${team.chip.tone}`}>
                {team.chip.label}
              </span>
              <span className="row2__sub">
                <IdText text={team.line} />
                {team.helpers && ` ${team.helpers}`}
              </span>
            </summary>
            {team.rows.map((row) => (
              <Row key={row.agent.id} row={row} now={now} />
            ))}
          </details>
        ))}
        <ReadingLine lab={lab} now={now} />
      </div>
    </section>
  );
}

/**
 * Who is doing what: the agents, and what the lab has read. Past 6 agents, the
 * agents in trouble show by name and the rest fold into teams.
 */
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
  if (foldsTeams(lab))
    return (
      <>
        <NeedsALook lab={lab} now={now} />
        <Teams lab={lab} now={now} answer={answer} />
      </>
    );
  return (
    <section aria-labelledby="who">
      <div className="section-head">
        <h2 id="who" className="section-title">
          Who is doing what
        </h2>
        <span className="section-links">
          <a className="section-link" href={href.team}>
            How they work together
          </a>
          <a className="section-link" href={href.answer}>
            {answer}
          </a>
        </span>
      </div>
      <div className="card">
        {agentRows(lab, now).map((row) => (
          <Row key={row.agent.id} row={row} now={now} />
        ))}
        <ReadingLine lab={lab} now={now} />
      </div>
    </section>
  );
}
