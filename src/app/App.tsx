import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  agentActions,
  answerActions,
  appActions,
  labActions,
} from './actions.ts';
import { needsTick } from './call.ts';
import { href, parseRoute, type Route } from './route.ts';
import { isSearchKey } from './search.ts';
import { AnswerPage, type AnswerActions } from './screens/AnswerPage.tsx';
import { BringPage } from './screens/BringPage.tsx';
import { CallDialog } from './screens/CallDialog.tsx';
import { DirectionPage, type AgentActions } from './screens/DirectionPage.tsx';
import { LabHome, type LabActions } from './screens/LabHome.tsx';
import { ComingSoon, NotFound, Notice } from './screens/Notice.tsx';
import { SearchDialog } from './screens/SearchDialog.tsx';
import { TurnScreen } from './screens/TurnScreen.tsx';
import type { LabStore, LabState } from './store.ts';
import { ToolsContext, type AppTools } from './tools.ts';
import { useNotify } from './useNotify.ts';

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

/** Answer and bring-in actions for a page without a token: each one is refused. */
const signedOutAnswers = answerActions(null);

/** How often a visible page tells Verifold that the person looks, as the desk's page does. */
const lookMs = 60_000;

/**
 * Tell Verifold that the person looks at the lab: at once, each minute while
 * the page shows, and when it shows again. A look after 30 minutes or more
 * away starts the "While you were away" digest.
 */
function useLook(look: () => Promise<unknown>): void {
  useEffect(() => {
    const tell = (): void => {
      if (document.visibilityState === 'visible') void look();
    };
    tell();
    const timer = setInterval(tell, lookMs);
    document.addEventListener('visibilitychange', tell);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tell);
    };
  }, [look]);
}

/** ⌘K, or Ctrl+K off a Mac, opens the search from any page. */
function useSearchKey(open: () => void): void {
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (!isSearchKey(event)) return;
      event.preventDefault();
      open();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [open]);
}

/** The page for a state and a route. Separate from the hooks, so tests render it directly. */
export function Screen({
  state,
  route,
  now,
  actions,
  agentActions,
  answers = signedOutAnswers,
}: {
  readonly state: LabState;
  readonly route: Route;
  readonly now: number;
  readonly actions: LabActions;
  readonly agentActions: AgentActions;
  readonly answers?: AnswerActions;
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
  if (route.page === 'first-run') return <ComingSoon page={route.page} />;
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
  const lab = snapshot.lab;
  if (!lab)
    return (
      <Notice title={`${snapshot.project} has no lab yet`}>
        <p>
          Start one from the desk for now: <a href="/">open the desk</a>. The
          new app's first-run and Ask pages come in a later step.
        </p>
      </Notice>
    );
  if (route.page === 'lab' || route.page === 'call')
    return (
      <>
        <LabHome
          snapshot={snapshot}
          lab={lab}
          connection={connection}
          now={now}
          actions={actions}
        />
        {route.page === 'call' && (
          <CallDialog
            key={route.id}
            lab={lab}
            id={route.id}
            now={now}
            actions={actions}
          />
        )}
      </>
    );
  if (route.page === 'answer')
    return (
      <AnswerPage
        snapshot={snapshot}
        lab={lab}
        connection={connection}
        now={now}
        actions={actions}
        answerActions={answers}
      />
    );
  const direction = lab.directions.find(
    (entry) => entry.id === route.direction,
  );
  if (!direction)
    return (
      <Notice title="This direction is not in the lab">
        <p>
          {lab.omitted.directions !== undefined
            ? 'This view of a large lab leaves out some directions. '
            : ''}
          <a href={href.lab}>Back to the lab</a>
        </p>
      </Notice>
    );
  const page = {
    snapshot,
    lab,
    direction,
    connection,
    now,
    actions,
    agentActions,
  };
  // Keyed by the route, so no state carries from one direction or turn to another.
  if (route.page === 'direction')
    return <DirectionPage key={direction.id} {...page} />;
  if (route.page === 'bring')
    return (
      <BringPage
        key={direction.id}
        snapshot={snapshot}
        lab={lab}
        direction={direction}
        connection={connection}
        now={now}
        actions={actions}
        answerActions={answers}
      />
    );
  return (
    <TurnScreen
      key={`${direction.id}/${route.turn}`}
      {...page}
      turnId={route.turn}
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
  const [fast, setFast] = useState(false);
  const now = useNow(fast);
  useEffect(() => {
    setFast(needsTick(state.snapshot?.lab, Date.now()));
  }, [state, now]);
  const [actions] = useState(() => labActions(token));
  const [agent] = useState(() => agentActions(token));
  const [answers] = useState(() => answerActions(token));
  const [app] = useState(() => appActions(token));
  const lab = state.snapshot?.lab ?? null;
  // The search opens only over a lab: before one, there is nothing to find.
  const hasLab = useRef(false);
  hasLab.current = lab !== null;
  const [searching, setSearching] = useState(false);
  const openSearch = useCallback(() => {
    if (hasLab.current) setSearching(true);
  }, []);
  useSearchKey(openSearch);
  useLook(app.look);
  const notify = useNotify(state.snapshot);
  const tools = useMemo<AppTools>(
    () => ({ openSearch, dismissAway: app.dismissAway, notify }),
    [openSearch, app, notify],
  );
  const board = useMemo(
    () => new Set(lab?.board.posts.map((post) => post.id)),
    [lab],
  );
  return (
    <ToolsContext.Provider value={tools}>
      <Screen
        state={state}
        route={route}
        now={now}
        actions={actions}
        agentActions={agent}
        answers={answers}
      />
      {searching && lab && (
        <SearchDialog
          board={board}
          run={app.search}
          onClose={() => setSearching(false)}
        />
      )}
    </ToolsContext.Provider>
  );
}
