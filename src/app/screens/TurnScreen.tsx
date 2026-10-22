import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Lab, Snapshot, Step, TurnDetail } from '../../protocol/api.ts';
import { refreshKey, stepLines, turnSummary } from '../activity.ts';
import { clock } from '../format.ts';
import type { Connection } from '../store.ts';
import { byIndex, meet } from '../turns.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { Avatar } from '../components/Avatar.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { Chevron } from '../components/Icons.tsx';
import { StepGroup, StepRow } from '../components/StepList.tsx';
import { TurnMessage } from '../components/TurnMessage.tsx';
import { leftOut, type AgentActions } from './DirectionPage.tsx';
import type { LabActions } from './LabHome.tsx';

/**
 * One turn of an agent, opened: every step, newest page first, with "Show
 * earlier steps" for the rest. A command shows the end of its output, and
 * short commands in a row fold into one line. As on the v9 canvas ("11. One
 * turn, opened"). `back` leads to the direction's
 * page, or to the agent's own page for a checker.
 *
 * The newest page is read again whenever the turn's revision in the snapshot
 * moves. A failed read keeps the steps shown, with a note. Earlier pages
 * stay while they still meet the newest page, and merge by step index.
 */
export function TurnScreen({
  snapshot,
  lab,
  agentId,
  back,
  turnId,
  connection,
  now,
  actions,
  agentActions,
}: {
  readonly snapshot: Snapshot;
  readonly lab: Lab;
  readonly agentId: string;
  readonly back: { readonly href: string; readonly label: string };
  readonly turnId: string;
  readonly connection: Connection;
  readonly now: number;
  readonly actions: LabActions;
  readonly agentActions: AgentActions;
}): ReactNode {
  // The snapshot of a large lab can leave the agent out. Its turn still loads from the API.
  const agent = lab.agents.find((entry) => entry.id === agentId);
  const name = agent?.handle ?? agentId;
  const folded = agent?.turns.turns.find((turn) => turn.id === turnId);
  const [newest, setNewest] = useState<TurnDetail | null>(null);
  const [earlier, setEarlier] = useState<{
    readonly steps: readonly Step[];
    readonly more: boolean;
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [earlierProblem, setEarlierProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A ref, so two clicks in one frame read once.
  const loading = useRef(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    void agentActions
      .turn(agentId, turnId, {}, controller.signal)
      .then((loaded) => {
        if (controller.signal.aborted) return;
        if ('error' in loaded) {
          setProblem(loaded.error);
          return;
        }
        setProblem(null);
        setNewest(loaded.value);
        setEarlier((current) =>
          current && meet(current.steps, loaded.value.steps) ? current : null,
        );
      });
    return () => controller.abort();
    // The read depends on the turn's revision, not on the whole turn object.
  }, [agentId, turnId, folded ? refreshKey(folded) : '', agentActions]);
  const turn = newest?.turn ?? folded;
  const steps = byIndex([earlier?.steps ?? [], newest?.steps ?? []]);
  const more = earlier ? earlier.more : (newest?.more ?? false);
  const showEarlier = async (): Promise<void> => {
    const first = steps[0];
    if (!first || loading.current) return;
    loading.current = true;
    setBusy(true);
    const controller = new AbortController();
    pending.current = controller;
    const loaded = await agentActions.turn(
      agentId,
      turnId,
      { before: first.index },
      controller.signal,
    );
    loading.current = false;
    setBusy(false);
    if (controller.signal.aborted) return;
    if ('error' in loaded) {
      setEarlierProblem(loaded.error);
      return;
    }
    setEarlierProblem(null);
    setEarlier((current) => ({
      steps: byIndex([loaded.value.steps, current?.steps ?? []]),
      more: loaded.value.more,
    }));
  };
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
          <a className="back" href={back.href}>
            <Chevron to="left" />
            {back.label}
          </a>
          <div className="turn-head">
            <h1 className="turn-head__title">
              {turn
                ? `${name} at ${clock(turn.startedAt)}`
                : `A turn of ${name}`}
            </h1>
            {turn && (
              <span className="turn-head__meta">{turnSummary(turn, now)}</span>
            )}
          </div>
          {!agent && <p className="turns__none">{leftOut}</p>}
          {!newest && !problem && (
            <p className="turns__none">Reading the steps…</p>
          )}
          {problem && (
            <p
              role={newest ? 'status' : 'alert'}
              className={newest ? 'steps__problem' : 'composer__error'}
            >
              {newest ? `Can't refresh these steps: ${problem}` : problem}
            </p>
          )}
          {more && (
            <button
              type="button"
              className="link-button"
              disabled={busy}
              onClick={() => void showEarlier()}
            >
              Show earlier steps
            </button>
          )}
          {earlierProblem && (
            <span role="alert" className="composer__error">
              {earlierProblem}
            </span>
          )}
          {steps.length > 0 && (
            <ol className="step-rows" aria-label="Steps">
              {stepLines(steps).map((line) =>
                'step' in line ? (
                  <StepRow key={line.step.index} step={line.step} />
                ) : (
                  <StepGroup
                    key={line.steps[0]?.index}
                    steps={line.steps}
                    commands={line.commands}
                  />
                ),
              )}
            </ol>
          )}
          {turn?.message && (
            <article className="turn">
              {agent && (
                <Avatar
                  who={{ harness: agent.harness, handle: agent.handle }}
                  size="lg"
                />
              )}
              <div className="turn__body">
                <TurnMessage message={turn.message} rest={null} />
              </div>
            </article>
          )}
        </div>
      </main>
    </div>
  );
}
