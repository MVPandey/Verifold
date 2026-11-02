import type { ReactNode } from 'react';
import { idParts } from '../ids.ts';
import { useView } from '../view-mode.ts';
import { DecideLink } from './DecideLink.tsx';

/** A text. In the Technical view of a lab with threads, its IDs link to their records. */
export function IdText({ text }: { readonly text: string }): ReactNode {
  const { mode, threaded } = useView();
  if (!threaded || mode === 'simple') return text;
  return idParts(text).map((part, index) => {
    if (typeof part === 'string') return part;
    return part.href ? (
      <a key={index} className="id" href={part.href}>
        {part.id}
      </a>
    ) : (
      <DecideLink key={index} call={part.id} className="id">
        {part.id}
      </DecideLink>
    );
  });
}
