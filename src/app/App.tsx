import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { act } from './api.ts';
import { parseRoute, type Route } from './route.ts';
import { LabHome, type LabActions } from './screens/LabHome.tsx';
import { ComingSoon, Notice } from './screens/Notice.tsx';
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

/** The time, again every 30 seconds, for "waiting 12 min" and live durations. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
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
  const { snapshot, connection } = state;
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
  if (!snapshot)
    return (
      <Notice title="Connecting to Verifold">
        <p>The lab shows here in a moment.</p>
      </Notice>
    );
  if (!snapshot.lab)
    return (
      <Notice title={`${snapshot.project} has no lab yet`}>
        <p>
          Start one from the desk for now: <a href="/">open the desk</a>. The
          new app's Ask page comes in a later step.
        </p>
      </Notice>
    );
  if (route.page !== 'lab') return <ComingSoon route={route} />;
  return (
    <LabHome
      snapshot={snapshot}
      lab={snapshot.lab}
      connection={connection}
      now={now}
      actions={actions}
    />
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
  const now = useNow();
  const actions: LabActions = {
    post: (text) =>
      token
        ? act(token, 'lab-post', { text })
        : Promise.resolve('No access key.'),
    pause: (pause) =>
      token
        ? act(token, pause ? 'lab-pause' : 'lab-resume', {})
        : Promise.resolve('No access key.'),
  };
  return <Screen state={state} route={route} now={now} actions={actions} />;
}
