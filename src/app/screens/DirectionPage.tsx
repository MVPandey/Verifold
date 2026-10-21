import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type {
  Agent,
  Call,
  Direction,
  Lab,
  PostKind,
  Snapshot,
  Turn,
  TurnDetail,
  TurnPage,
} from '../../protocol/api.ts';
import type { ActOutcome, Loaded, StepQuery } from '../api.ts';
import { foldQuery, refreshKey, stepTotal, turnSummary } from '../activity.ts';
import { clock, harnessName, modelName, since } from '../format.ts';
import { href } from '../route.ts';
import type { Connection } from '../store.ts';
import { byStart, filled, joinTurns, type Older } from '../turns.ts';
import { ActivityFold } from '../components/ActivityFold.tsx';
import { AppHeader } from '../components/AppHeader.tsx';
import { Avatar } from '../components/Avatar.tsx';
import { Composer } from '../components/Composer.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { Chevron } from '../components/Icons.tsx';
import { RunChip } from '../components/RunChip.tsx';
import { StepList } from '../components/StepList.tsx';
import { TurnMessage } from '../components/TurnMessage.tsx';
import { Verdict } from '../components/Verdict.tsx';
import type { LabActions } from './LabHome.tsx';

/** What the direction and turn pages ask of Verifold. */
export interface AgentActions {
  /**
   * Write to a direction's agent: the person's post in its direction. The
   * lab wakes the direction's agent for it, and puts it into a running turn
   * when the harness takes it.
   */
  readonly message: (
    direction: string,
    text: string,
    key: string,
  ) => Promise<ActOutcome>;
  /** The page of an agent's turns before the turn `before`. */
  readonly turns: (
    agent: string,
    before: string,
    signal?: AbortSignal,
  ) => Promise<Loaded<TurnPage>>;
  /** A page of a turn's steps. */
  readonly turn: (
    agent: string,
    turn: string,
    query: StepQuery,
    signal?: AbortSignal,
  ) => Promise<Loaded<TurnDetail>>;
}

/** Pages of older turns that a gap fill reads at most, before it gives the older turns up. */
const gapPages = 10;

/** A bar or a line, as part of a sentence: no end stop, and a lowercase first word unless it is an acronym. */
function clause(text: string): string {
  const bare = text.trim().replace(/[.!]+$/, '');
  return /^[A-Z][a-z]/.test(bare)
    ? bare.charAt(0).toLowerCase() + bare.slice(1)
    : bare;
}

function sentence(text: string): string {
  return `${text.trim().replace(/[.!]+$/, '')}.`;
}

/** "claude-2 · Claude Opus 5.5 (1M) · Holds up if …. 3 runs, noise ±0.02. Now: …." */
function DirectionHead({
  direction,
  agent,
}: {
  readonly direction: Direction;
  readonly agent: Agent | undefined;
}): ReactNode {
  const repeats =
    direction.runs !== null
      ? `${direction.runs} ${direction.runs === 1 ? 'run' : 'runs'}${direction.noise ? `, noise ${direction.noise}` : ''}`
      : null;
  const rest = [
    direction.bar ? sentence(`Holds up if ${clause(direction.bar)}`) : null,
    repeats ? sentence(repeats) : null,
    direction.evidence ? sentence(`Now: ${direction.evidence.text}`) : null,
  ].filter((part) => part !== null);
  return (
    <div className="direction-head">
      <div className="direction-head__top">
        <Verdict direction={direction} />
        <h1 className="direction-head__title">{direction.title}</h1>
      </div>
      <p className="direction-head__meta">
        <b>{agent?.handle ?? direction.agent}</b>
        {agent && (
          <>
            {' · '}
            {harnessName(agent.harness)}
            {agent.model && (
              <>
                {' '}
                <span title={agent.model}>{modelName(agent.model)}</span>
              </>
            )}
          </>
        )}
        {rest.length > 0 && ` · ${rest.join(' ')}`}
      </p>
    </div>
  );
}

const postNames: Record<PostKind, string> = {
  plan: 'Plan',
  claim: 'Claim',
  evidence: 'Evidence',
  objection: 'Objection',
  question: 'Question',
  rerun: 'Rerun',
  'ruled-out': 'Ruled-out note',
  status: 'Note',
};

/**
 * What a turn left behind: the runs and posts that its tool calls made. A
 * run or post that the snapshot leaves out shows by its ID. An older server
 * names none, and the turn shows none.
 */
function TurnProof({
  turn,
  lab,
}: {
  readonly turn: Turn;
  readonly lab: Lab;
}): ReactNode {
  const runIds = turn.runs ?? [];
  const postIds = turn.posts ?? [];
  if (!runIds.length && !postIds.length) return null;
  const runs = new Map(lab.runs.map((run) => [run.id, run]));
  const posts = new Map(lab.board.posts.map((post) => [post.id, post]));
  return (
    <div
      className="turn__proof"
      {...(turn.proofByTime
        ? {
            title:
              'Matched by the time the turn ran, because the harness named its calls in a way that the records do not carry.',
          }
        : {})}
    >
      {runIds.map((id) => (
        <RunChip key={id} id={id} runs={runs} />
      ))}
      {postIds.map((id) => {
        const post = posts.get(id);
        return (
          <a key={id} className="proof" href={href.lab}>
            {post ? postNames[post.kind] : 'Post'} on the board
          </a>
        );
      })}
    </div>
  );
}

/**
 * One turn: when it began, its work folded into one line, its last message,
 * and what it left behind. An open fold reads the turn's newest tool calls,
 * and reads them again whenever the turn's revision moves: a step starts or
 * ends, its output grows, or text arrives. A failed read keeps what the fold
 * shows, with a note.
 */
function TurnItem({
  turn,
  agent,
  direction,
  lab,
  now,
  agentActions,
}: {
  readonly turn: Turn;
  readonly agent: Agent;
  readonly direction: Direction;
  readonly lab: Lab;
  readonly now: number;
  readonly agentActions: AgentActions;
}): ReactNode {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<TurnDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void agentActions
      .turn(agent.id, turn.id, foldQuery(turn), controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        if ('error' in loaded) setProblem(loaded.error);
        else {
          setSteps(loaded.value);
          setProblem(null);
        }
      });
    return () => controller.abort();
    // The read depends on the turn's revision, not on the whole turn object.
  }, [open, agent.id, turn.id, refreshKey(turn), agentActions]);
  const turnHref = href.turn(direction.id, turn.id);
  return (
    <article className="turn">
      <Avatar
        who={{ harness: agent.harness, handle: agent.handle }}
        size="lg"
      />
      <div className="turn__body">
        <div className="turn__head">
          <span className="turn__time">{clock(turn.startedAt)}</span>
          <ActivityFold
            summary={turnSummary(turn, now)}
            open={open}
            controls={listId}
            onToggle={() => setOpen(!open)}
          />
        </div>
        {open &&
          (steps ? (
            <>
              <StepList
                id={listId}
                steps={steps.steps}
                total={stepTotal(turn)}
                turnHref={turnHref}
              />
              {problem && (
                <p role="status" className="steps__problem">
                  Can't refresh these steps: {problem}
                </p>
              )}
            </>
          ) : (
            <p
              id={listId}
              role={problem ? 'alert' : undefined}
              className="steps steps--note"
            >
              {problem ?? 'Reading the steps…'}
            </p>
          ))}
        {turn.message && <TurnMessage message={turn.message} rest={turnHref} />}
        <TurnProof turn={turn} lab={lab} />
      </div>
    </article>
  );
}

/**
 * The agent now, from harness events: what it runs, or that it waits for
 * the person, with the call to decide.
 */
function LiveLine({
  agent,
  call,
  now,
}: {
  readonly agent: Agent;
  readonly call: Call | undefined;
  readonly now: number;
}): ReactNode {
  const { live } = agent;
  return (
    <>
      {live.state === 'working' && (
        <div role="status" className="live live--working">
          <span className="dot" aria-hidden="true" />
          <span className="live__text">
            {live.text}
            {live.since && ` · ${since(live.since, now)}`}
          </span>
        </div>
      )}
      {call && (
        <div role="status" className="live live--need">
          <span className="dot" aria-hidden="true" />
          <span className="live__text">
            Waiting for your answer · {since(call.at, now)}
          </span>
          <a className="button button--dark" href={href.call(call.id)}>
            Decide
          </a>
        </div>
      )}
      {live.state !== 'working' && !call && (
        <div role="status" className="live live--quiet">
          <span className="live__text">{live.text}</span>
        </div>
      )}
    </>
  );
}

/** When a message to the agent reaches it, from how the lab delivers the person's posts. */
function reach(agent: Agent, lab: Lab): string {
  if (lab.paused)
    return `The lab is paused. ${agent.handle} reads your message after you resume it.`;
  if (agent.live.state === 'working')
    return `${agent.handle} is working. Your message reaches it during this turn, or at the start of its next one.`;
  return `${agent.handle} reads your message at the start of its next turn.`;
}

/**
 * The agent's turns: older ones read on request, then the snapshot's newest
 * page. When new turns push the older ones' anchor out of the page, the
 * turns between are read before anything older shows again, so no turn is
 * ever missing from the list.
 */
function Turns({
  agent,
  direction,
  lab,
  now,
  agentActions,
}: {
  readonly agent: Agent;
  readonly direction: Direction;
  readonly lab: Lab;
  readonly now: number;
  readonly agentActions: AgentActions;
}): ReactNode {
  const [older, setOlder] = useState<Older | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A ref, so two clicks in one frame read once.
  const loading = useRef(false);
  // A gap fill and a reset make reads that started before them stale.
  const epoch = useRef(0);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const newest = agent.turns.turns;
  const { turns, gap } = joinTurns(older, newest);
  const anchor = older?.anchor ?? null;
  useEffect(() => {
    if (!gap || !older) return;
    const controller = new AbortController();
    const mine = ++epoch.current;
    void (async () => {
      const pages: (readonly Turn[])[] = [];
      let before = gap;
      for (let page = 0; page < gapPages; page++) {
        const loaded = await agentActions.turns(
          agent.id,
          before,
          controller.signal,
        );
        if (controller.signal.aborted || mine !== epoch.current) return;
        if ('error' in loaded) {
          // The list stays whole: the newest page alone, and "Show older turns" again.
          setOlder(null);
          setProblem(loaded.error);
          return;
        }
        pages.push(loaded.value.turns);
        const first = loaded.value.turns[0];
        if (
          !first ||
          !loaded.value.more ||
          loaded.value.turns.some((turn) => turn.id === older.anchor)
        )
          break;
        before = first.id;
      }
      setOlder(filled(older, pages, gap));
    })();
    return () => controller.abort();
    // The fill depends on the gap and the anchor, not on each new `older`.
  }, [gap, anchor, agent.id, agentActions]);
  const more = !gap && (older ? older.more : agent.turns.more);
  const showOlder = async (): Promise<void> => {
    const first = turns[0];
    if (!first || loading.current) return;
    loading.current = true;
    setBusy(true);
    const controller = new AbortController();
    pending.current = controller;
    const mine = epoch.current;
    const loaded = await agentActions.turns(
      agent.id,
      first.id,
      controller.signal,
    );
    loading.current = false;
    setBusy(false);
    if (controller.signal.aborted || mine !== epoch.current) return;
    if ('error' in loaded) {
      setProblem(loaded.error);
      return;
    }
    setProblem(null);
    setOlder((current) => ({
      turns: byStart([loaded.value.turns, current?.turns ?? []]),
      more: loaded.value.more,
      anchor: current?.anchor ?? first.id,
    }));
  };
  const call = lab.needsYou.find((entry) =>
    entry.askers.some((asker) => asker.agent === agent.id),
  );
  return (
    <section className="turns" aria-label={`What ${agent.handle} did`}>
      {more && (
        <button
          type="button"
          className="link-button"
          disabled={busy}
          onClick={() => void showOlder()}
        >
          Show older turns
        </button>
      )}
      {gap && <p className="turns__none">Reading the turns in between…</p>}
      {problem && (
        <span role="alert" className="composer__error">
          {problem}
        </span>
      )}
      {turns.length === 0 && (
        <p className="turns__none">{agent.handle} has no turns yet.</p>
      )}
      {turns.map((turn) => (
        <TurnItem
          key={turn.id}
          turn={turn}
          agent={agent}
          direction={direction}
          lab={lab}
          now={now}
          agentActions={agentActions}
        />
      ))}
      <LiveLine agent={agent} call={call} now={now} />
    </section>
  );
}

/**
 * A direction on its own page: its verdict and bar, what its agent did turn
 * by turn, folded the way the Claude Code and Codex apps fold their work,
 * and a box to write to that agent. As on the v9 canvas ("10. A direction").
 */
export function DirectionPage({
  snapshot,
  lab,
  direction,
  connection,
  now,
  actions,
  agentActions,
}: {
  readonly snapshot: Snapshot;
  readonly lab: Lab;
  readonly direction: Direction;
  readonly connection: Connection;
  readonly now: number;
  readonly actions: LabActions;
  readonly agentActions: AgentActions;
}): ReactNode {
  const agent = lab.agents.find((entry) => entry.id === direction.agent);
  const ended =
    direction.state !== 'open' || !agent || agent.live.state === 'ended';
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
          <DirectionHead direction={direction} agent={agent} />
          {agent ? (
            <Turns
              agent={agent}
              direction={direction}
              lab={lab}
              now={now}
              agentActions={agentActions}
            />
          ) : (
            <p className="turns__none">{leftOut}</p>
          )}
          {ended || !agent ? (
            <p className="composer__hint">
              {agent
                ? `${agent.handle} has stopped, so messages no longer reach it.`
                : 'Messages reach the agents through the lab.'}{' '}
              <a href={href.lab}>Write to the lab</a> instead.
            </p>
          ) : (
            <Composer
              label={`Message ${agent.handle}`}
              placeholder={`Message ${agent.handle}`}
              maxLength={lab.postLimit}
              hint={reach(agent, lab)}
              onSend={(text, key) =>
                agentActions.message(direction.id, text, key)
              }
            />
          )}
        </div>
      </main>
    </div>
  );
}

/** What the direction and turn pages say when the snapshot of a large lab leaves out the agent. */
export const leftOut =
  "This view of a large lab leaves out the direction's agent.";
