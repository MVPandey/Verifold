import type { ReactNode } from 'react';
import type { Lab, Post, PostKind, Proof } from '../../protocol/api.ts';
import type { Thread } from '../board.ts';
import { href } from '../route.ts';
import { Avatar, type Who } from './Avatar.tsx';
import { PlanCard } from './PlanCard.tsx';

const chips: Partial<Record<PostKind, string>> = {
  plan: 'Plan of record',
  claim: 'Claim',
  evidence: 'Evidence',
  objection: 'Objection',
  question: 'Question',
  rerun: 'Rerun',
  'ruled-out': 'Ruled out',
};

/** Bring a post on the page into view, and give it focus. */
export function showPost(post: string): void {
  const element = document.getElementById(`post-${post}`);
  if (!element) return;
  element.scrollIntoView({ block: 'center' });
  element.focus({ preventScroll: true });
}

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

/**
 * A post's proof, as chips. A chip opens the page of the direction that
 * holds the proof, when the post names one: the direction's page shows its
 * runs and files.
 */
function ProofLinks({ post }: { readonly post: Post }): ReactNode {
  return (
    <>
      {post.proof.map((proof, index) => {
        const direction =
          proof.type === 'run'
            ? post.direction
            : (proof.direction ?? post.direction);
        return direction ? (
          <a key={index} className="proof" href={href.direction(direction)}>
            {proofLabel(proof)}
          </a>
        ) : (
          <span key={index} className="proof">
            {proofLabel(proof)}
          </span>
        );
      })}
    </>
  );
}

/**
 * A post's name line and text, with its kind and its proof as chips. The
 * plan of record shows as its card. A plan before it is an earlier plan.
 */
function PostLines({
  post,
  lab,
}: {
  readonly post: Post;
  readonly lab?: Lab | undefined;
}): ReactNode {
  if (post.kind === 'plan' && lab?.plan?.post === post.id)
    return <PlanCard plan={lab.plan} lab={lab} />;
  // The person's posts and Verifold's status lines carry no kind chip.
  const chip =
    post.author === 'person'
      ? undefined
      : post.kind === 'plan' && lab?.plan
        ? 'Earlier plan'
        : chips[post.kind];
  return (
    <>
      <div className="post__head">
        <b>{name(post)}</b>
        {chip && <span className={`chip chip--${post.kind}`}>{chip}</span>}
      </div>
      <div className="post__text">
        <span>{post.text}</span>
        <ProofLinks post={post} />
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
  lab,
}: {
  readonly thread: Thread;
  /** The lab, so the plan of record shows as its card, first in its thread. */
  readonly lab?: Lab;
}): ReactNode {
  // A changed plan replies to the plan before it. The plan of record leads its thread.
  const current = lab?.plan?.post;
  const promoted = thread.replies.find((reply) => reply.id === current);
  const root = promoted ?? thread.root;
  const replies = promoted
    ? [thread.root, ...thread.replies.filter((reply) => reply !== promoted)]
    : thread.replies;
  if (root.author === 'person')
    return (
      <article id={`post-${root.id}`} tabIndex={-1} className="post">
        <Avatar who="person" size="lg" />
        <div className="post__body post__body--person">
          <div>
            <PostLines post={root} lab={lab} />
          </div>
          {replies.map((reply) => (
            <div
              key={reply.id}
              id={`post-${reply.id}`}
              tabIndex={-1}
              className="ack"
            >
              <Avatar who={who(reply)} size="xs" />
              <span>
                <span className="ack__name">{name(reply)}</span> {reply.text}
                <ProofLinks post={reply} />
              </span>
            </div>
          ))}
        </div>
      </article>
    );
  return (
    <article id={`post-${root.id}`} tabIndex={-1} className="post">
      <Avatar who={who(root)} size="lg" />
      <div className="post__body">
        <div>
          <PostLines post={root} lab={lab} />
        </div>
        {replies.length > 0 && (
          <div className="thread">
            <div className="thread__rail" />
            <div className="thread__replies">
              {replies.map((reply) => (
                <div
                  key={reply.id}
                  id={`post-${reply.id}`}
                  tabIndex={-1}
                  className="reply"
                >
                  <Avatar who={who(reply)} size="sm" />
                  <div>
                    <PostLines post={reply} lab={lab} />
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
