import type { ReactNode } from 'react';
import type { Harness, Post } from '../../protocol/api.ts';
import { authorHead, avatarText, harnessName, roleName } from '../format.ts';

export type Who =
  | { readonly harness: Harness; readonly handle: string }
  | 'person'
  | 'verifold';

/**
 * A round mark for an agent, the person, or Verifold. `labelled`: the avatar
 * names the agent on its own, as in a direction row. Next to a name it is
 * decoration.
 */
export function Avatar({
  who,
  size,
  labelled = false,
}: {
  readonly who: Who;
  readonly size: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  readonly labelled?: boolean;
}): ReactNode {
  const [kind, text, label] =
    who === 'person'
      ? ['you', 'You', 'You']
      : who === 'verifold'
        ? ['verifold', 'V', 'Verifold']
        : [
            who.harness,
            avatarText(who),
            `${harnessName(who.harness)}, ${roleName(who.handle)}`,
          ];
  return (
    <span
      className={`avatar avatar--${size} avatar--${kind}`}
      {...(labelled
        ? { role: 'img', 'aria-label': label }
        : { 'aria-hidden': true })}
    >
      {text}
    </span>
  );
}

/** A post's author in its head: the name, then the job and the harness in small text. */
export function PostAuthor({ post }: { readonly post: Post }): ReactNode {
  const { name, detail } = authorHead(post);
  return (
    <>
      <b>{name}</b>
      {detail && <span className="post__job">{detail}</span>}
    </>
  );
}
