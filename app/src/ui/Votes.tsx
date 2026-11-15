import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';

import { messageOf } from '../api/client.ts';
import type {
  AgentView,
  BadgeLine,
  BadgeRequest,
  Direction,
  Given,
  PostView,
} from '../api/types.ts';
import { PERSON } from '../api/types.ts';
import { ownName } from '../model/agents.ts';
import {
  BADGE_WORDS,
  MAX_WHY,
  canMarkPromising,
  givenBy,
  orderVotes,
  proposedLine,
  secondedBy,
  standingBadges,
  votesLeftOut,
  votesLine,
  waitingProposal,
  yourVote,
} from '../model/votes.ts';

/** The person's moves on a post's votes and badges. Each one ends when the server took it. */
export interface MarkActions {
  readonly onVote: (postId: string, direction: Direction, reason: string) => Promise<void>;
  readonly onBadge: (request: BadgeRequest) => Promise<void>;
}

/** One badge as a chip. A Breakthrough badge has its own color, which nothing else on the page uses. */
export function BadgeChip(props: { readonly badge: BadgeLine['badge'] }): ReactElement {
  return (
    <span className={`v-badge${props.badge === 'breakthrough' ? ' rare' : ''}`}>
      {BADGE_WORDS[props.badge]}
    </span>
  );
}

/** The badges that stand on a post, beside where it stands. A Breakthrough that waits for its second is not one. */
export function Badges(props: { readonly item: PostView }): ReactElement {
  return (
    <>
      {standingBadges(props.item).map((line) => (
        <BadgeChip key={line.badge} badge={line.badge} />
      ))}
    </>
  );
}

/** What the one-line field is for: a vote up or down, or the Promising badge. */
export type Asking = 'up' | 'down' | 'promising';

const SUBMIT: Readonly<Record<Asking, string>> = {
  up: 'Vote up',
  down: 'Vote down',
  promising: 'Mark as promising',
};

/**
 * The votes of one post: a count up and a count down, and a list that opens under them with each vote and its
 * reason, and with who gave each badge. A press on a count opens a field for the reason of the person's own
 * vote. The count belongs to the post: nothing here counts for an agent, and nothing is sorted by votes.
 *
 * Without `actions`, the counts and the list show and nothing can be pressed.
 */
export function Votes(props: {
  readonly item: PostView;
  readonly agents: readonly AgentView[];
  readonly actions?: MarkActions | undefined;
}): ReactElement | null {
  const { item, agents, actions } = props;
  const { post } = item;
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const up = item.up ?? 0;
  const down = item.down ?? 0;
  const badges = standingBadges(item);
  const proposal = waitingProposal(item);
  const yours = yourVote(item);
  // The person votes on the posts of others. Their own post shows the votes that it got.
  const can = actions !== undefined && post.author !== PERSON;
  if (!can && up + down === 0 && badges.length === 0 && proposal === null) return null;

  const run = (move: Promise<void>): void => {
    setError(null);
    move.catch((failure: unknown) => {
      setError(messageOf(failure));
    });
  };
  const count = (direction: 'up' | 'down', votes: number): ReactElement => {
    const mine = yours?.direction === direction;
    const label = `${votes} ${direction}${mine ? ', with your vote' : ''}`;
    const body = (
      <>
        <i className={`v-arrow ${direction}`} /> {votes}
      </>
    );
    return can ? (
      <button
        type="button"
        className={`v-count${mine ? ' mine' : ''}`}
        aria-label={label}
        title={direction === 'up' ? 'Vote up' : 'Vote down'}
        onClick={() => {
          setAsking(direction);
        }}
      >
        {body}
      </button>
    ) : (
      <span className={`v-count${mine ? ' mine' : ''}`} role="img" aria-label={label}>
        {body}
      </span>
    );
  };

  return (
    <div className="v-box">
      {proposal ? (
        <Proposal item={item} line={proposal} agents={agents} actions={actions} run={run} />
      ) : null}
      <p className="v-row">
        {count('up', up)}
        {count('down', down)}
        {up + down > 0 || badges.length > 0 ? (
          <button
            type="button"
            className="v-more"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
            }}
          >
            {open ? 'Hide the votes' : votesLine(item)}
          </button>
        ) : null}
        {can && canMarkPromising(item) ? (
          <button
            type="button"
            className="v-vote v-give"
            onClick={() => {
              setAsking('promising');
            }}
          >
            Mark as promising
          </button>
        ) : null}
      </p>
      {asking && actions ? (
        <Why
          key={asking}
          asking={asking}
          onCancel={() => {
            setAsking(null);
          }}
          onSend={(reason) =>
            (asking === 'promising'
              ? actions.onBadge({ post: post.id, badge: 'promising', action: 'give', reason })
              : actions.onVote(post.id, asking, reason)
            ).then(() => {
              setAsking(null);
            })
          }
        />
      ) : null}
      {error ? (
        <p className="v-note error" role="alert">
          {error}
        </p>
      ) : null}
      {open ? <VoteDetail item={item} agents={agents} actions={actions} run={run} /> : null}
    </div>
  );
}

/**
 * The list under a post's counts: each vote with who cast it and why, and who gave each badge. The person's vote
 * comes first, then the coordinator's, then the others as they were cast. `run` makes a move and shows a refusal.
 */
export function VoteDetail(props: {
  readonly item: PostView;
  readonly agents: readonly AgentView[];
  readonly actions?: MarkActions | undefined;
  readonly run: (move: Promise<void>) => void;
}): ReactElement {
  const { item, agents, actions, run } = props;
  const { post } = item;
  const badges = standingBadges(item);
  return (
    <div className="v-detail">
      <ul>
        {orderVotes(item.votes ?? [], agents).map((vote) => (
          <li key={vote.by} className={vote.by === PERSON ? 'you' : undefined}>
            <i
              className={`v-arrow ${vote.direction}`}
              role="img"
              aria-label={vote.direction === 'up' ? 'Up' : 'Down'}
            />
            <b>{ownName(agents, vote.by)}</b>
            {agents.some((view) => view.agent.id === vote.by && view.coordinator) ? (
              <span className="i-seat coord">Coordinator</span>
            ) : null}
            <span>{vote.reason}</span>
            {vote.by === PERSON && actions ? (
              <button
                type="button"
                className="v-more"
                onClick={() => run(actions.onVote(post.id, 'none', ''))}
              >
                Take it back
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {votesLeftOut(item) > 0 ? (
        <p className="v-note">
          {votesLeftOut(item) === 1
            ? '1 earlier vote is not in this list.'
            : `${votesLeftOut(item)} earlier votes are not in this list.`}
        </p>
      ) : null}
      {badges.map((line) => (
        <p key={line.badge} className="v-badge-line">
          <BadgeChip badge={line.badge} />
          {line.badge === 'breakthrough' ? (
            <Seconded line={line} post={post.id} agents={agents} actions={actions} run={run} />
          ) : (
            line.given.map((given) => (
              <Giver
                key={given.by}
                given={given}
                agents={agents}
                onBack={
                  actions
                    ? () =>
                        run(
                          actions.onBadge({
                            post: post.id,
                            badge: line.badge,
                            action: 'take_back',
                            giver: given.by,
                          }),
                        )
                    : undefined
                }
              />
            ))
          )}
        </p>
      ))}
    </div>
  );
}

/** One giver of a badge: who, why, the post that it named, and the control that takes the badge back. */
function Giver(props: {
  readonly given: Given;
  readonly agents: readonly AgentView[];
  readonly onBack?: (() => void) | undefined;
}): ReactElement {
  const { given, onBack } = props;
  return (
    <span className="v-giver">
      {givenBy(given, props.agents)} <q>{given.reason}</q>
      {given.proof ? ` It names ${given.proof}.` : null}
      {onBack ? (
        <button type="button" className="v-more" onClick={onBack}>
          {given.by === PERSON ? 'Take it back' : 'Remove it'}
        </button>
      ) : null}
    </span>
  );
}

/** A Breakthrough badge that stands: who proposed it, who seconded it, and why. The person can remove it. */
function Seconded(props: {
  readonly line: BadgeLine;
  readonly post: string;
  readonly agents: readonly AgentView[];
  readonly actions?: MarkActions | undefined;
  readonly run: (move: Promise<void>) => void;
}): ReactElement {
  const { line, actions } = props;
  const proposer = line.given[0];
  return (
    <span className="v-giver">
      {secondedBy(line, props.agents)} {proposer ? <q>{proposer.reason}</q> : null}
      {line.second?.reason ? (
        <>
          {' '}
          <q>{line.second.reason}</q>
        </>
      ) : null}
      {actions && proposer ? (
        <button
          type="button"
          className="v-more"
          onClick={() =>
            props.run(
              actions.onBadge({
                post: props.post,
                badge: 'breakthrough',
                action: 'take_back',
                giver: proposer.by,
              }),
            )
          }
        >
          Remove it
        </button>
      ) : null}
    </span>
  );
}

/**
 * A Breakthrough badge that an agent proposed and that waits for its second. The person seconds it in one move,
 * with a line or without one, or declines it. It blocks nothing.
 */
function Proposal(props: {
  readonly item: PostView;
  readonly line: BadgeLine;
  readonly agents: readonly AgentView[];
  readonly actions?: MarkActions | undefined;
  readonly run: (move: Promise<void>) => void;
}): ReactElement {
  const { item, line, actions } = props;
  const [reason, setReason] = useState('');
  const proposer = line.given[0];
  const second = (event: FormEvent): void => {
    event.preventDefault();
    if (!actions) return;
    props.run(
      actions.onBadge({
        post: item.post.id,
        badge: 'breakthrough',
        action: 'second',
        reason: reason.trim(),
      }),
    );
  };
  return (
    <form className="v-proposal" onSubmit={second}>
      <p>
        {proposedLine(item, line, props.agents)} {proposer ? <q>{proposer.reason}</q> : null}
      </p>
      {actions && proposer && item.post.author !== PERSON ? (
        <div className="v-why">
          <input
            type="text"
            value={reason}
            maxLength={MAX_WHY}
            aria-label="A line for your second (optional)"
            placeholder="A line for your second (optional)"
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
          <button type="submit" className="v-vote">
            Second it
          </button>
          <button
            type="button"
            className="v-more"
            onClick={() =>
              props.run(
                actions.onBadge({
                  post: item.post.id,
                  badge: 'breakthrough',
                  action: 'take_back',
                  giver: proposer.by,
                }),
              )
            }
          >
            Not this one
          </button>
        </div>
      ) : null}
    </form>
  );
}

/** The one-line field for the reason of the person's vote or badge. A vote and a badge need a reason. */
export function Why(props: {
  readonly asking: Asking;
  readonly onSend: (reason: string) => Promise<void>;
  readonly onCancel: () => void;
}): ReactElement {
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = reason.trim() !== '' && !sending;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (!ready) return;
    setSending(true);
    setError(null);
    props.onSend(reason.trim()).catch((failure: unknown) => {
      setError(messageOf(failure));
      setSending(false);
    });
  };
  return (
    <form className="v-why" onSubmit={send}>
      {props.asking === 'promising' ? (
        <BadgeChip badge="promising" />
      ) : (
        <i className={`v-arrow ${props.asking}`} />
      )}
      <input
        type="text"
        autoFocus
        value={reason}
        maxLength={MAX_WHY}
        aria-label="Why, in one line"
        placeholder="Why, in one line"
        onChange={(event) => {
          setReason(event.target.value);
        }}
      />
      <button type="submit" className="v-vote" disabled={!ready}>
        {SUBMIT[props.asking]}
      </button>
      <button type="button" className="v-more" onClick={props.onCancel}>
        Cancel
      </button>
      {error ? (
        <span className="error" role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}
