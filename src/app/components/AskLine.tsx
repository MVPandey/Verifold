import type { ReactNode } from 'react';
import type { Wait } from '../../protocol/api.ts';
import { roleName } from '../../ui/lab-lines.ts';
import { since } from '../format.ts';
import { href } from '../route.ts';

/**
 * The oldest ask that names the person: its text, who asks, and how long it
 * has waited. Reply leads to the post on the board.
 */
export function AskLine({
  ask,
  more,
  now,
}: {
  readonly ask: Wait;
  /** Other asks after this one. */
  readonly more: number;
  readonly now: number;
}): ReactNode {
  return (
    <div className="needs">
      <span className="needs__label">Needs you</span>
      <span className="needs__body">
        <b>{ask.text}</b>
        <span className="needs__meta">
          {ask.waiterHandle ? roleName(ask.waiterHandle) : 'An agent'} asks ·
          waiting {since(ask.since, now)}
          {more > 0 &&
            ` · ${more} more ${more === 1 ? 'ask' : 'asks'} after this`}
        </span>
      </span>
      <a className="button button--dark" href={href.board(ask.post)}>
        Reply
      </a>
    </div>
  );
}
