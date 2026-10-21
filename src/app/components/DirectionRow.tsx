import type { ReactNode } from 'react';
import type { Agent, Direction } from '../../protocol/api.ts';
import { since } from '../format.ts';
import { href } from '../route.ts';
import { Avatar } from './Avatar.tsx';
import { Check, Cross, Ring, Up, Warning } from './Icons.tsx';

type Shown =
  | 'holds'
  | 'disputed'
  | 'ruled-out'
  | 'leading'
  | 'open'
  | 'stopped';

/** The label of a direction. An objection that no check settled shows over the verdict. */
export function shownVerdict(direction: Direction): Shown {
  if (direction.verdict === 'ruled-out') return 'ruled-out';
  if (direction.disputed) return 'disputed';
  if (direction.verdict === 'holds-up') return 'holds';
  if (direction.verdict === 'leading') return 'leading';
  return direction.state === 'open' ? 'open' : 'stopped';
}

const labels: Record<Shown, string> = {
  holds: 'Holds up',
  disputed: 'Disputed',
  'ruled-out': 'Ruled out',
  leading: 'Leading',
  open: 'Not settled',
  stopped: 'Stopped',
};

const icons: Record<Shown, () => ReactNode> = {
  holds: () => <Check />,
  disputed: () => <Warning />,
  'ruled-out': () => <Cross />,
  leading: () => <Up />,
  open: () => <Ring />,
  stopped: () => <Ring />,
};

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
  const shown = shownVerdict(direction);
  const live = agent?.live;
  return (
    <a
      className={`row${shown === 'disputed' ? ' row--disputed' : ''}`}
      href={href.direction(direction.id)}
    >
      <span className={`verdict verdict--${shown}`}>
        {icons[shown]()}
        {labels[shown]}
      </span>
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
