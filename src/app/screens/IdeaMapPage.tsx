import { useCallback, useContext, type ReactNode } from 'react';
import type { IdeaPage, Lab, Snapshot } from '../../protocol/api.ts';
import { ControlsContext, useControl } from '../controls.ts';
import {
  drawEmpty,
  drawHead,
  drawState,
  ideaGroups,
  ideaHead,
  shareLine,
  shotLine,
  shotTag,
  untestedLine,
} from '../idea-view.ts';
import { href } from '../route.ts';
import type { Connection } from '../store.ts';
import { useRead } from '../useRead.ts';
import { useView } from '../view-mode.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { Chevron } from '../components/Icons.tsx';
import type { LabActions } from './LabHome.tsx';

/** One group of ideas as chips. */
function Chips({
  name,
  ideas,
  fresh = false,
}: {
  readonly name: string;
  readonly ideas: IdeaPage['ideas'];
  readonly fresh?: boolean;
}): ReactNode {
  if (!ideas.length) return null;
  return (
    <div className="chips">
      <span className="chips__name">{name}</span>
      {ideas.map((idea) => (
        <span key={idea.id} className={fresh ? 'idea idea--new' : 'idea'}>
          {idea.text}
        </span>
      ))}
    </div>
  );
}

/** Draw again and Stop long shots. A draw that cannot run says why. */
function DrawControls({
  page,
  reread,
}: {
  readonly page: IdeaPage;
  readonly reread: () => void;
}): ReactNode {
  const draw = useControl<null>((controls, _value, key) => controls.draw(key));
  const stop = useControl<null>((controls, _value, key) =>
    controls.stopLongShots(key),
  );
  if (!draw.controls) return null;
  const line = drawState(page);
  return (
    <>
      <div className="acts acts--flat">
        <button
          type="button"
          className="act"
          disabled={draw.action.busy}
          onClick={() =>
            void draw.action.submit(null).then((ran) => ran && reread())
          }
        >
          Draw again
        </button>
        <button
          type="button"
          className="act"
          disabled={stop.action.busy}
          onClick={() =>
            void stop.action.submit(null).then((ran) => ran && reread())
          }
        >
          Stop long shots
        </button>
      </div>
      {[draw.action.error, stop.action.error].map(
        (error) =>
          error && (
            <p key={error} role="alert" className="composer__error">
              {error}
            </p>
          ),
      )}
      {line && <p className="reach">{line}</p>}
    </>
  );
}

/** The idea map, as in step 6 of the v10 spec, with the reading map's papers. */
export function IdeaMapPage({
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
        ? controls.ideas(signal)
        : Promise.resolve({ error: 'This page cannot read the idea map.' }),
    [controls],
  );
  const { value: page, failed, reread } = useRead(read, snapshot.at);
  const groups = page ? ideaGroups(page) : null;
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
          <h1 className="thread-title">Idea map</h1>
          {failed && (
            <p role="alert" className="composer__error">
              {failed}
            </p>
          )}
          {page && groups ? (
            <>
              <section aria-labelledby="ideas">
                <div className="section-head">
                  <h2 id="ideas" className="section-title">
                    {ideaHead(page)}
                  </h2>
                </div>
                {page.ideas.length ? (
                  <div className="card">
                    <Chips name="Tried in this lab" ideas={groups.tried} />
                    <Chips name="Not tried yet" ideas={groups.untried} fresh />
                  </div>
                ) : (
                  <p className="reach">No agent added an idea yet.</p>
                )}
              </section>
              {page.draws.map((draw) => {
                const empty = drawEmpty(draw);
                return (
                  <section key={draw.at} aria-label={drawHead(draw, now)}>
                    <div className="section-head">
                      <h2 className="section-title">{drawHead(draw, now)}</h2>
                    </div>
                    {empty ? (
                      <p className="reach">{empty}</p>
                    ) : (
                      <div className="card">
                        {draw.shots.map((shot) => (
                          <div key={shot.post} className="row2">
                            <a
                              className="row2__link"
                              href={href.thread(shot.thread)}
                            >
                              {shot.question}
                            </a>
                            <span className="alien-tag">{shotTag(mode)}</span>
                            <span className="row2__sub">{shotLine(shot)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
              <DrawControls page={page} reread={reread} />
              <p className="reach">{shareLine(lab)}</p>
              <p className="reach">{untestedLine}</p>
              <section aria-labelledby="papers">
                <div className="section-head">
                  <h2 id="papers" className="section-title">
                    Reading map · {page.sourceCount}{' '}
                    {page.sourceCount === 1 ? 'paper' : 'papers'}
                  </h2>
                </div>
                {page.sources.length ? (
                  <div className="card">
                    {page.sources.map((source) => (
                      <div key={source.id} className="row2">
                        <a
                          className="row2__link row2__link--out"
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {source.title}
                        </a>
                        <span className="row2__date">{source.date}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="reach">No agent added a paper yet.</p>
                )}
              </section>
            </>
          ) : (
            !failed && <p className="turns__none">Reading the idea map…</p>
          )}
        </div>
      </main>
    </div>
  );
}
