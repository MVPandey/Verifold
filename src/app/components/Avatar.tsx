import type { ReactNode } from 'react';
import type { Harness } from '../../protocol/api.ts';
import { harnessName } from '../format.ts';

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
            who.harness === 'claude' ? 'Cl' : 'Cx',
            `${harnessName(who.harness)}, ${who.handle}`,
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
