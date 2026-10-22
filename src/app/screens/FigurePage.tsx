import { useContext, useEffect, useState, type ReactNode } from 'react';
import type { Lab, PostThread, Snapshot } from '../../protocol/api.ts';
import type { Loaded } from '../api.ts';
import { threads } from '../board.ts';
import { ControlsContext } from '../controls.ts';
import { href } from '../route.ts';
import { size } from '../runs.ts';
import type { Connection } from '../store.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { BoardThread } from '../components/BoardThread.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { Chevron } from '../components/Icons.tsx';
import type { LabActions } from './LabHome.tsx';

/**
 * A figure that a post cites, such as p-12.0, above its post. The page reads
 * both once. An agent made the figure, so an image shows only in an `<img>`,
 * where an SVG runs no script, and a PDF is a download.
 */
export function FigurePage({
  snapshot,
  lab,
  proof,
  connection,
  now,
  actions,
  read,
}: {
  readonly snapshot: Snapshot;
  readonly lab: Lab;
  readonly proof: string;
  readonly connection: Connection;
  readonly now: number;
  readonly actions: LabActions;
  readonly read: (
    post: string,
    signal?: AbortSignal,
  ) => Promise<Loaded<PostThread>>;
}): ReactNode {
  const controls = useContext(ControlsContext);
  const [post = '', index = ''] = proof.split('.');
  const [thread, setThread] = useState<PostThread | null>(null);
  const [figure, setFigure] = useState<Loaded<Blob> | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void read(post, controller.signal).then((loaded) => {
      if (!controller.signal.aborted && 'value' in loaded)
        setThread(loaded.value);
    });
    return () => controller.abort();
  }, [post, read]);
  useEffect(() => {
    if (!controls) return;
    const controller = new AbortController();
    let made: string | null = null;
    void controls.figure(proof, controller.signal).then((loaded) => {
      if (controller.signal.aborted) return;
      setFigure(loaded);
      if ('value' in loaded) {
        made = URL.createObjectURL(loaded.value);
        setUrl(made);
      }
    });
    return () => {
      controller.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [controls, proof]);
  const cited = thread?.posts[0]?.proof[Number(index)];
  const path = cited?.type === 'figure' ? cited.path : null;
  const name = path?.split('/').at(-1) ?? 'figure';
  const type = figure && 'value' in figure ? figure.value.type : null;
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
          <a className="back" href={href.post(post)}>
            <Chevron to="left" />
            The post
          </a>
          <div className="direction-head">
            <h1 className="page-title">
              {path ? `Figure ${name}` : 'A figure'}
            </h1>
            {cited?.type === 'figure' && (
              <p className="direction-head__meta">
                {cited.path} at {cited.commit.slice(0, 7)}, as {post} pinned it.
              </p>
            )}
          </div>
          {!controls && (
            <p className="turns__none">
              Open this page from Verifold to see the figure.
            </p>
          )}
          {controls && !figure && (
            <p className="turns__none">Reading the figure…</p>
          )}
          {figure && 'error' in figure && (
            <p role="alert" className="composer__error">
              {figure.error}
            </p>
          )}
          {url &&
            (type === 'application/pdf' ? (
              <p>
                <a className="button" href={url} download={name}>
                  Download the PDF
                  {cited?.type === 'figure' && ` (${size(cited.bytes)})`}
                </a>
              </p>
            ) : (
              <img
                className={
                  type === 'image/svg+xml'
                    ? 'figure-view figure-view--svg'
                    : 'figure-view'
                }
                src={url}
                alt={`The figure ${name} that ${post} cites`}
              />
            ))}
          {thread && (
            <section className="section section--board">
              {threads(thread.posts).map((entry) => (
                <BoardThread key={entry.root.id} thread={entry} />
              ))}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
