import type { ReactNode } from 'react';
import type { Lab, Thread } from '../../protocol/api.ts';
import { href } from '../route.ts';
import { postCount, threadChip, threadTitle } from '../thread-view.ts';
import { useView } from '../view-mode.ts';

/** Threads as rows: the title, the state, and the post count. Each row opens its thread. */
export function ThreadRows({
  threads,
  lab,
}: {
  readonly threads: readonly Thread[];
  readonly lab: Lab;
}): ReactNode {
  const { mode } = useView();
  return (
    <div className="card">
      {threads.map((thread) => {
        const chip = threadChip(thread, lab);
        return (
          <a
            key={thread.id}
            className="thread-row"
            href={href.thread(thread.id)}
          >
            <span className="thread-row__title">
              {threadTitle(thread, mode)}
            </span>
            <span className="thread-row__meta">
              <span className={`state state--flat state--${chip.tone}`}>
                {chip.label}
              </span>
              {postCount(thread)}
            </span>
          </a>
        );
      })}
    </div>
  );
}
