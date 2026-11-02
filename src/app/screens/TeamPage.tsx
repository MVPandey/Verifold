import { useCallback, useContext, type ReactNode } from 'react';
import type { Lab, Snapshot } from '../../protocol/api.ts';
import {
  disagreementRows,
  gpuRows,
  needCollabRows,
  objectionRow,
  type CollabRow,
} from '../collab-view.ts';
import { ControlsContext } from '../controls.ts';
import { href } from '../route.ts';
import type { Connection } from '../store.ts';
import { useRead } from '../useRead.ts';
import { useView } from '../view-mode.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { Chevron } from '../components/Icons.tsx';
import { IdText } from '../components/IdText.tsx';
import type { LabActions } from './LabHome.tsx';

/** One row: what it is about, its state, and Verifold's line from the records. */
function Row({ row }: { readonly row: CollabRow }): ReactNode {
  return (
    <div className="row2">
      {row.to ? (
        <a className="row2__link" href={row.to}>
          {row.title}
        </a>
      ) : (
        <b>{row.title}</b>
      )}
      {row.chip && (
        <span className={`state state--${row.chip.tone}`}>
          {row.chip.label}
        </span>
      )}
      <span className="row2__sub">
        <IdText text={row.sub} />
      </span>
    </div>
  );
}

/** How the agents work together, as in step 3 of the v10 spec. Verifold writes this page from the records, and it never counts messages. */
export function TeamPage({
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
  const { mode } = useView();
  const controls = useContext(ControlsContext);
  const read = useCallback(
    (signal: AbortSignal) =>
      controls
        ? controls.collab(signal)
        : Promise.resolve({ error: 'This page cannot read the records.' }),
    [controls],
  );
  const { value: page, failed } = useRead(read, snapshot.at);
  const needs = page
    ? [...needCollabRows(page, mode, now), ...gpuRows(page, mode)]
    : [];
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
          <h1 className="thread-title">How they work together</h1>
          {failed && (
            <p role="alert" className="composer__error">
              {failed}
            </p>
          )}
          {page ? (
            <>
              <section aria-labelledby="disagreements">
                <div className="section-head">
                  <h2 id="disagreements" className="section-title">
                    Disagreements
                  </h2>
                </div>
                <div className="card">
                  {disagreementRows(page, mode).map((row) => (
                    <Row key={row.key} row={row} />
                  ))}
                  <Row row={objectionRow(page)} />
                </div>
              </section>
              <section aria-labelledby="needs">
                <div className="section-head">
                  <h2 id="needs" className="section-title">
                    Who needs whom
                  </h2>
                </div>
                {needs.length ? (
                  <div className="card">
                    {needs.map((row) => (
                      <Row key={row.key} row={row} />
                    ))}
                  </div>
                ) : (
                  <p className="reach">No agent waits on another now.</p>
                )}
              </section>
            </>
          ) : (
            !failed && <p className="turns__none">Reading the records…</p>
          )}
        </div>
      </main>
    </div>
  );
}
