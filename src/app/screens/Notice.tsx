import type { ReactNode } from 'react';
import type { Snapshot } from '../../protocol/api.ts';
import type { ActOutcome } from '../api.ts';
import { href } from '../route.ts';
import { useAction } from '../useAction.ts';

/** A short page with a title, a line, and a way on. */
export function Notice({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <main className="notice">
      <h1>{title}</h1>
      {children}
    </main>
  );
}

export function NotFound(): ReactNode {
  return (
    <Notice title="This page does not exist">
      <p>
        <a href={href.lab}>Back to the lab</a>
      </p>
    </Notice>
  );
}

/**
 * A project without a lab: its question, why its lab's last start failed,
 * and Start the lab. A project without a question starts from the desk.
 */
export function NoLab({
  snapshot,
  onStart,
}: {
  readonly snapshot: Snapshot;
  readonly onStart: (question: string, key: string) => Promise<ActOutcome>;
}): ReactNode {
  const action = useAction(onStart);
  const question = snapshot.question ?? null;
  return (
    <Notice title={`${snapshot.project} has no lab yet`}>
      {question ? (
        <>
          <p>Its question: {question}</p>
          {snapshot.startProblem && (
            <p role="alert">The lab did not start: {snapshot.startProblem}</p>
          )}
          <p>
            <button
              type="button"
              className="button button--primary"
              disabled={action.busy}
              onClick={() => void action.submit(question)}
            >
              Start the lab
            </button>
          </p>
          {action.error && <p role="alert">{action.error}</p>}
        </>
      ) : (
        <p>
          This project has no question yet. Add one in the desk:{' '}
          <a href="/">open the desk</a>.
        </p>
      )}
      <p>
        You can <a href={href.setup('agents')}>change your profile</a> here.
      </p>
    </Notice>
  );
}
