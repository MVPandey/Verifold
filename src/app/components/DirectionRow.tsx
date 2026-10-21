import type { ReactNode } from 'react';
import type { Agent, Direction } from '../../protocol/api.ts';
import { since } from '../format.ts';
import { href } from '../route.ts';
import { Avatar } from './Avatar.tsx';
import { shownVerdict, Verdict } from './Verdict.tsx';

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
  const live = agent?.live;
  return (
    <a
      className={`row${shownVerdict(direction) === 'disputed' ? ' row--disputed' : ''}`}
      href={href.direction(direction.id)}
    >
      <Verdict direction={direction} />
      <span className="row__body">
        <b>{direction.title}</b>
        {live?.state === 'working' ? (
          <span className="row__live">
            <span className="dot" aria-hidden="true" />
            {live.text}
            {live.since && ` · ${since(live.since, now)}`}
          </span>
        ) : (
          <span className="row__line">
            {direction.evidence
              ? `${direction.evidence.text}${live?.state === 'waiting' ? ` · ${lower(live.text)}` : ''}`
              : (live?.text ?? '')}
          </span>
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

function lower(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
