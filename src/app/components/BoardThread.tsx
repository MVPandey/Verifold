import type { ReactNode } from 'react';
import type { Post, PostKind, Proof } from '../../protocol/api.ts';
import type { Thread } from '../board.ts';
import { href } from '../route.ts';
import { Avatar, type Who } from './Avatar.tsx';

const chips: Partial<Record<PostKind, string>> = {
  plan: 'Plan of record',
  claim: 'Claim',
  evidence: 'Evidence',
  objection: 'Objection',
  question: 'Question',
  rerun: 'Rerun',
  'ruled-out': 'Ruled out',
};

function who(post: Post): Who {
  if (post.author === 'person') return 'person';
  if (post.harness && post.handle)
    return { harness: post.harness, handle: post.handle };
  return 'verifold';
}

function name(post: Post): string {
  return post.author === 'person' ? 'You' : (post.handle ?? 'Verifold');
}

function proofLabel(proof: Proof): string {
  if (proof.type === 'run') return `Run ${proof.run}`;
  if (proof.type === 'figure') return 'Figure';
  if (proof.type === 'diff') return 'Diff';
  return proof.path.split('/').at(-1) ?? proof.path;
}

function proofHref(post: Post, proof: Proof, index: number): string {
  return proof.type === 'run'
    ? href.run(proof.run)
    : href.proof(`${post.id}.${index}`);
}

/** A post's name line and text, with its kind and its proof as chips. */
function PostLines({ post }: { readonly post: Post }): ReactNode {
  // The person's posts and Verifold's status lines carry no kind chip.
  const chip = post.author === 'person' ? undefined : chips[post.kind];
  return (
    <>
      <div className="post__head">
        <b>{name(post)}</b>
        {chip && <span className={`chip chip--${post.kind}`}>{chip}</span>}
      </div>
      <div className="post__text">
        <span>{post.text}</span>
        {post.proof.map((proof, index) => (
          <a key={index} className="proof" href={proofHref(post, proof, index)}>
            {proofLabel(proof)}
          </a>
        ))}
      </div>
    </>
  );
}

/**
 * A thread: the first post, and its replies on a rail. Replies to the
 * person's own post are short answers to them, so they show as quiet lines
 * under it, as on the v9 canvas.
 */
export function BoardThread({
  thread,
}: {
  readonly thread: Thread;
}): ReactNode {
  const { root, replies } = thread;
  if (root.author === 'person')
    return (
      <article className="post">
        <Avatar who="person" size="lg" />
        <div className="post__body post__body--person">
          <div>
            <PostLines post={root} />
          </div>
          {replies.map((reply) => (
            <div key={reply.id} className="ack">
              <Avatar who={who(reply)} size="xs" />
              <span>
                <span className="ack__name">{name(reply)}</span> {reply.text}
                {reply.proof.map((proof, index) => (
                  <a
                    key={index}
                    className="proof ack__proof"
                    href={proofHref(reply, proof, index)}
                  >
                    {proofLabel(proof)}
                  </a>
                ))}
              </span>
            </div>
          ))}
        </div>
      </article>
    );
  return (
    <article className="post">
      <Avatar who={who(root)} size="lg" />
      <div className="post__body">
        <div>
          <PostLines post={root} />
        </div>
        {replies.length > 0 && (
          <div className="thread">
            <div className="thread__rail" />
            <div className="thread__replies">
              {replies.map((reply) => (
                <div key={reply.id} className="reply">
                  <Avatar who={who(reply)} size="sm" />
                  <div>
                    <PostLines post={reply} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
