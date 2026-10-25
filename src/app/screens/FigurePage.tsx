import { useContext, useEffect, useState, type ReactNode } from 'react';
import type { Lab, PostThread, Snapshot } from '../../protocol/api.ts';
import type { Loaded, SentFile } from '../api.ts';
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

/** A figure's bytes as a `data:` URL. A browser opens a data: URL only with an origin of its own, never as a page of Verifold. */
function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('read'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read'));
    reader.readAsDataURL(blob);
  });
}

/** The name to save a figure as: Verifold's name for it, else `figure` with the extension of its type. */
export function savedName(file: SentFile): string {
  if (file.name) return file.name;
  const subtype = file.blob.type.split('/')[1] ?? '';
  const extension =
    subtype === 'svg+xml' ? 'svg' : subtype === 'jpeg' ? 'jpg' : subtype;
  return extension ? `figure.${extension}` : 'figure';
}

/**
 * A figure that a post cites, such as p-12.0, above its post. The page reads
 * both once. An agent made the figure, so it reaches the page only as a
 * `data:` URL: an image in an `<img>`, where an SVG runs no script, and a
 * PDF as a download.
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
  const [thread, setThread] = useState<Loaded<PostThread> | null>(null);
  const [figure, setFigure] = useState<Loaded<SentFile> | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void read(post, controller.signal).then((loaded) => {
      if (!controller.signal.aborted) setThread(loaded);
    });
    return () => controller.abort();
  }, [post, read]);
  useEffect(() => {
    if (!controls) return;
    const controller = new AbortController();
    void controls.figure(proof, controller.signal).then(async (loaded) => {
      if (controller.signal.aborted) return;
      setFigure(loaded);
      if (!('value' in loaded)) return;
      const made = await dataUrl(loaded.value.blob).catch(() => null);
      if (controller.signal.aborted) return;
      if (made) setUrl(made);
      else setFigure({ error: 'This page could not read the figure.' });
    });
    return () => controller.abort();
  }, [controls, proof]);
  const posts = thread && 'value' in thread ? thread.value.posts : null;
  const cited = posts?.[0]?.proof[Number(index)];
  const path = cited?.type === 'figure' ? cited.path : null;
  const name = path?.split('/').at(-1) ?? 'figure';
  const file = figure && 'value' in figure ? figure.value : null;
  const type = file?.blob.type ?? null;
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
            file &&
            (type === 'application/pdf' ? (
              <p>
                <a className="button" href={url} download={savedName(file)}>
                  Download the PDF ({size(file.blob.size)})
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
          {thread && 'error' in thread && (
            <p className="turns__none">{thread.error}</p>
          )}
          {posts && (
            <section className="section section--board">
              {threads(posts).map((entry) => (
                <BoardThread key={entry.root.id} thread={entry} />
              ))}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
