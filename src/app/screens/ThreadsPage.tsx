import type { ReactNode } from 'react';
import type { Lab, Snapshot } from '../../protocol/api.ts';
import { href } from '../route.ts';
import type { Connection } from '../store.ts';
import { threadGroups } from '../thread-view.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { Chevron } from '../components/Icons.tsx';
import { ThreadRows } from '../components/ThreadRows.tsx';
import type { LabActions } from './LabHome.tsx';

/** All threads of a lab by state, open first. */
export function ThreadsPage({
  snapshot,
  lab,
  connection,
  now,
  actions,
}: {
  readonly snapshot: Snapshot;
  readonly lab: Lab;
  readonly connection: Connection;
  readonly now: number;
  readonly actions: LabActions;
}): ReactNode {
  const groups = threadGroups(lab.threads ?? []);
  const left = lab.omitted.threads ?? 0;
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
          <a className="back" href={href.lab}>
            <Chevron to="left" />
            The lab
          </a>
          <h1 className="thread-title">Threads</h1>
          {groups.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <div className="section-head">
                <h2 className="section-title">{group.label}</h2>
              </div>
              <ThreadRows threads={group.threads} lab={lab} />
            </section>
          ))}
          {left > 0 && (
            <span className="more">
              {left} older {left === 1 ? 'thread' : 'threads'} not shown.
            </span>
          )}
        </div>
      </main>
    </div>
  );
}
