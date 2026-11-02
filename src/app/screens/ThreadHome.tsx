import { useContext, useEffect, type ReactNode } from 'react';
import type { Lab, Snapshot } from '../../protocol/api.ts';
import { reachLine } from '../agent-rows.ts';
import { signedOff } from '../answer.ts';
import { mentionNames } from '../mentions.ts';
import { waitingPods } from '../pods.ts';
import { href, replaceRoute } from '../route.ts';
import type { Connection } from '../store.ts';
import { openThreads } from '../thread-view.ts';
import { ToolsContext } from '../tools.ts';
import { AgentList } from '../components/AgentList.tsx';
import { AnswerLine } from '../components/AnswerLine.tsx';
import { AppHeader } from '../components/AppHeader.tsx';
import { BriefCard } from '../components/BriefCard.tsx';
import { Composer } from '../components/Composer.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import {
  Disputes,
  MoreTime,
  OpenDirection,
  WorksLine,
} from '../components/LabControls.tsx';
import { NeedsList } from '../components/NeedsList.tsx';
import { NotifyLine } from '../components/NotifyLine.tsx';
import { PodNeeds, PodsLine, type PodActions } from '../components/Pods.tsx';
import { StatusBar } from '../components/StatusBar.tsx';
import { ThreadRows } from '../components/ThreadRows.tsx';
import type { LabActions } from './LabHome.tsx';

/** Open threads that the home lists. The rest are one link away. */
const homeThreads = 5;

/**
 * The home of a lab with threads, as in step 1 of the v10 spec: the question,
 * what needs the person, the brief, who does what, the open threads, and the
 * box. A lab before its plan and a lab from before threads keep `LabHome`.
 * `show`: a post that a link to the old board names. This home has no board,
 * so the post opens on its own page.
 */
export function ThreadHome({
  snapshot,
  lab,
  connection,
  now,
  actions,
  pods,
  show = null,
}: {
  readonly snapshot: Snapshot;
  readonly lab: Lab;
  readonly connection: Connection;
  readonly now: number;
  readonly actions: LabActions;
  readonly pods?: PodActions;
  readonly show?: string | null;
}): ReactNode {
  const tools = useContext(ToolsContext);
  useEffect(() => {
    if (show) replaceRoute(href.post(show));
  }, [show]);
  const { compute } = snapshot;
  const waiting = compute && pods ? waitingPods(compute).length : 0;
  const quiet =
    !lab.needsYou.length && !lab.waits?.some((wait) => wait.on === 'person');
  const threads = lab.threads ?? [];
  const total = threads.length + (lab.omitted.threads ?? 0);
  const open = openThreads(threads, homeThreads);
  return (
    <div className="page">
      <AppHeader
        project={snapshot.project}
        own={snapshot.ownProfile === true}
        lab={lab}
        now={now}
        onPause={actions.pause}
      />
      <main className="main">
        <div className="column column--lab">
          <ConnectionBar connection={connection} at={snapshot.at} />
          <h1 className="lab-question">{lab.question}</h1>
          <NeedsList lab={lab} now={now} />
          {compute && pods && (
            <PodNeeds compute={compute} lab={lab} now={now} actions={pods} />
          )}
          {lab.paused ? (
            <StatusBar tone="muted">
              {lab.paused.reason === 'deadline'
                ? 'The time budget ended, so the lab is paused.'
                : 'Paused. Agents start no new turns until you resume.'}
            </StatusBar>
          ) : (
            quiet &&
            !waiting && <StatusBar tone="ok">Nothing needs you.</StatusBar>
          )}
          {lab.paused?.reason === 'deadline' && lab.agentsHere && <MoreTime />}
          <WorksLine lab={lab} />
          <PodsLine compute={compute} />
          {lab.answered.map((call) => (
            <AnswerLine
              key={call.id}
              call={call}
              lab={lab}
              now={now}
              question
              onUndo={actions.undo}
            />
          ))}
          {lab.brief && (
            <BriefCard
              lab={lab}
              brief={lab.brief}
              now={now}
              onDismiss={tools?.dismissAway ?? null}
            />
          )}
          <AgentList
            lab={lab}
            now={now}
            answer={signedOff(lab) ? 'The answer' : 'The answer so far'}
          />
          <Disputes lab={lab} />
          {total > 0 && (
            <section aria-labelledby="open-threads">
              <div className="section-head">
                <h2 id="open-threads" className="section-title">
                  Open threads
                </h2>
                <a className="section-link" href={href.threads}>
                  All {total} {total === 1 ? 'thread' : 'threads'}
                </a>
              </div>
              {open.length ? (
                <ThreadRows threads={open} lab={lab} />
              ) : (
                <p className="reach">This page shows no open thread.</p>
              )}
            </section>
          )}
          {snapshot.trimmed && (
            <span className="more">
              This lab is large, so this page leaves out some older items.
            </span>
          )}
          <Composer
            label="Write to the lab"
            placeholder="Write to the lab"
            hint={reachLine(lab)}
            maxLength={lab.postLimit}
            names={mentionNames(lab)}
            onSend={actions.post}
          />
          {lab.agentsHere && <OpenDirection />}
          <NotifyLine />
        </div>
      </main>
    </div>
  );
}
