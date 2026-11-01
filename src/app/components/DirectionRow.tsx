import type { ReactNode } from 'react';
import type { Agent, Direction } from '../../protocol/api.ts';
import { directionLine, shownVerdict } from '../../ui/lab-lines.ts';
import { agentDetail, roleName } from '../format.ts';
import { href } from '../route.ts';
import { Avatar } from './Avatar.tsx';
import { Verdict } from './Verdict.tsx';

/**
 * One direction: its verdict, title, one line, and its agent. The line is
 * the agent's live step while it works. Otherwise it is the evidence for the
 * verdict, with a wait for the person after it.
 */
export function DirectionRow({
  direction,
  agent,
  now,
}: {
  readonly direction: Direction;
  readonly agent: Agent | undefined;
  readonly now: number;
}): ReactNode {
  const line = directionLine(
    direction.evidence?.text ?? null,
    agent?.live ?? null,
    now,
  );
  const detail = agent ? agentDetail(agent) : null;
  return (
    <a
      className={`row${shownVerdict(direction) === 'disputed' ? ' row--disputed' : ''}`}
      href={href.direction(direction.id)}
    >
      <Verdict direction={direction} />
      <span className="row__body">
        <b>{direction.title}</b>
        {agent && detail && (
          <span className="row__who">
            {roleName(agent.handle)} · {detail}
          </span>
        )}
        {line.working ? (
          <span className="row__live">
            <span className="dot" aria-hidden="true" />
            {line.text}
          </span>
        ) : (
          <span className="row__line">{line.text}</span>
        )}
      </span>
      {agent && (
        <Avatar
          who={{ harness: agent.harness, handle: agent.handle }}
          size="md"
          labelled
        />
      )}
    </a>
  );
}
