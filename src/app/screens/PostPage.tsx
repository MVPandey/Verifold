import { useContext, useEffect, useState, type ReactNode } from 'react';
import type { Lab, Post, PostThread, Snapshot } from '../../protocol/api.ts';
import type { Loaded } from '../api.ts';
import { threads } from '../board.ts';
import { ControlsContext } from '../controls.ts';
import { authorOf, clock } from '../format.ts';
import { mentionNames } from '../mentions.ts';
import { href } from '../route.ts';
import type { Connection } from '../store.ts';
import { AppHeader } from '../components/AppHeader.tsx';
import { BoardThread, showPost } from '../components/BoardThread.tsx';
import { Composer } from '../components/Composer.tsx';
import { ConnectionBar } from '../components/ConnectionBar.tsx';
import { Chevron } from '../components/Icons.tsx';
import type { LabActions } from './LabHome.tsx';

function title(post: Post): string {
  const owner =
    post.author === 'person' ? 'Your' : `${post.handle ?? 'Verifold'}'s`;
  return `${owner} post at ${clock(post.at)}`;
}

/**
 * A post that the lab home's board leaves out, such as an older one that a
 * search found: the post and the replies below it, as the lab's agents read
 * a thread. The page reads them once when it opens.
 */
export function PostPage({
  snapshot,
  lab,
  id,
  connection,
  now,
  actions,
  read,
}: {
  readonly snapshot: Snapshot;
  readonly lab: Lab;
  readonly id: string;
  readonly connection: Connection;
  readonly now: number;
  readonly actions: LabActions;
  readonly read: (
    post: string,
    signal?: AbortSignal,
  ) => Promise<Loaded<PostThread>>;
}): ReactNode {
  const controls = useContext(ControlsContext);
  const [loaded, setLoaded] = useState<Loaded<PostThread> | null>(null);
  // A reply that went through reads the thread again, so it shows.
  const [replies, setReplies] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void read(id, controller.signal).then((value) => {
      if (!controller.signal.aborted) setLoaded(value);
    });
    return () => controller.abort();
  }, [id, read, replies]);
  const thread = loaded && 'value' in loaded ? loaded.value : null;
  useEffect(() => {
    if (thread) showPost(id);
  }, [thread, id]);
  const post = thread?.posts[0];
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
          <a className="back" href={href.lab}>
            <Chevron to="left" />
            The lab
          </a>
          <h1 className="turn-head__title">{post ? title(post) : 'A post'}</h1>
          {!loaded && <p className="turns__none">Reading the post…</p>}
          {loaded && 'error' in loaded && (
            <p role="alert" className="turns__none">
              {loaded.error}
            </p>
          )}
          {thread && (
            <section className="section section--board">
              {post?.replyTo && (
                <a className="more" href={href.post(post.replyTo)}>
                  It answers an earlier post
                </a>
              )}
              {threads(thread.posts).map((entry) => (
                <BoardThread key={entry.root.id} thread={entry} />
              ))}
              {thread.more && (
                <span className="more">
                  This post has more replies than this page shows.
                </span>
              )}
            </section>
          )}
          {post && controls && lab.agentsHere && (
            <Composer
              label={`Reply to ${authorOf(post)}`}
              placeholder="Write a reply, or @mention an agent"
              maxLength={lab.postLimit}
              names={mentionNames(lab)}
              onSend={(text, key) => controls.reply(post.id, text, key)}
              onSent={() => setReplies((count) => count + 1)}
            />
          )}
        </div>
      </main>
    </div>
  );
}
