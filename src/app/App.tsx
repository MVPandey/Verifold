import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { labActions } from './actions.ts';
import { needsTick } from './call.ts';
import { parseRoute, type Route } from './route.ts';
import { CallDialog } from './screens/CallDialog.tsx';
import { LabHome, type LabActions } from './screens/LabHome.tsx';
import { ComingSoon, NotFound, Notice } from './screens/Notice.tsx';
import type { LabStore, LabState } from './store.ts';

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const update = (): void => setRoute(parseRoute(location.hash));
    addEventListener('hashchange', update);
    return () => removeEventListener('hashchange', update);
  }, []);
  return route;
}

/**
 * The time, again every 30 seconds for "waiting 12 min" and live durations,
 * and every second while an answer is applied or can be undone, so its line
 * changes, and its Undo goes, at once.
 */
function useNow(fast: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), fast ? 1_000 : 30_000);
    return () => clearInterval(timer);
  }, [fast]);
  return now;
}

/** The page for a state and a route. Separate from the hooks, so tests render it directly. */
export function Screen({
  state,
  route,
  now,
  actions,
}: {
  readonly state: LabState;
  readonly route: Route;
  readonly now: number;
  readonly actions: LabActions;
}): ReactNode {
  const { snapshot, connection, retrying } = state;
  if (connection === 'signed-out')
    return (
      <Notice title="Open Verifold from your terminal">
        <p>
          This tab has no access key, or Verifold started again with a new one.
          Run <code>verifold</code> in the project folder, or type{' '}
          <code>/app</code> in its terminal, to open the app with a fresh link.
        </p>
      </Notice>
    );
  if (connection === 'outdated')
    return (
      <Notice title="This page is older than Verifold. Reload it.">
        <p>
          <button
            type="button"
            className="button button--primary"
            onClick={() => location.reload()}
          >
            Reload
          </button>
        </p>
      </Notice>
    );
  if (route.page === 'unknown') return <NotFound />;
  if (route.page !== 'lab' && route.page !== 'call')
    return <ComingSoon page={route.page} />;
  if (!snapshot)
    return connection === 'unreachable' ? (
      <Notice title="Can't reach Verifold. Is it running?">
        <p>
          {retrying
            ? 'This page keeps trying, and shows the lab as soon as Verifold answers.'
            : 'Verifold refused the connection. Reload this page to try again.'}
        </p>
      </Notice>
    ) : (
      <Notice title="Connecting to Verifold">
        <p>The lab shows here in a moment.</p>
      </Notice>
    );
  if (!snapshot.lab)
    return (
      <Notice title={`${snapshot.project} has no lab yet`}>
        <p>
          Start one from the desk for now: <a href="/">open the desk</a>. The
          new app's first-run and Ask pages come in a later step.
        </p>
      </Notice>
    );
  return (
    <>
      <LabHome
        snapshot={snapshot}
        lab={snapshot.lab}
        connection={connection}
        now={now}
        actions={actions}
      />
      {route.page === 'call' && (
        <CallDialog
          key={route.id}
          lab={snapshot.lab}
          id={route.id}
          now={now}
          actions={actions}
        />
      )}
    </>
  );
}

export function App({
  store,
  token,
}: {
  readonly store: LabStore;
  readonly token: string | null;
}): ReactNode {
  const state = useSyncExternalStore(store.subscribe, store.get);
  const route = useRoute();
  const [fast, setFast] = useState(false);
  const now = useNow(fast);
  useEffect(() => {
    setFast(needsTick(state.snapshot?.lab, Date.now()));
  }, [state, now]);
  const [actions] = useState(() => labActions(token));
  return <Screen state={state} route={route} now={now} actions={actions} />;
}
