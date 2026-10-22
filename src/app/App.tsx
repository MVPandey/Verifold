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
  computeActions,
  labActions,
  type AppActions,
} from './actions.ts';
import type { ActOutcome } from './api.ts';
import { startActions, type StartActions } from './ask.ts';
import { ControlsContext, labControls } from './controls.ts';
import { callOpener, needsTick, typing } from './call.ts';
import { href, parseRoute, replaceRoute, type Route } from './route.ts';
import { isSearchKey, onMac } from './search.ts';
import { AgentPage } from './screens/AgentPage.tsx';
import { AnswerPage, type AnswerActions } from './screens/AnswerPage.tsx';
import { AskPage } from './screens/AskPage.tsx';
import { BringPage } from './screens/BringPage.tsx';
import { CallDialog } from './screens/CallDialog.tsx';
import { DiffPage } from './screens/DiffPage.tsx';
import { DirectionPage, type AgentActions } from './screens/DirectionPage.tsx';
import { LabHome, type LabActions } from './screens/LabHome.tsx';
import { NoLab, NotFound, Notice } from './screens/Notice.tsx';
import { AppHeader } from './components/AppHeader.tsx';
import { PodNeeds, PodsLine } from './components/Pods.tsx';
import { SetupPage } from './screens/Setup.tsx';
import { SettingsPage, type ComputeActions } from './screens/SettingsPage.tsx';
import {
  HistoryPage,
  HistoryRunPage,
  StartOverPage,
} from './screens/History.tsx';
import { HistoryContext, historyTools } from './history.ts';
import { setupActions, type SetupActions } from './setup.ts';
import { PostPage } from './screens/PostPage.tsx';
import { RunPage } from './screens/RunPage.tsx';
import { SearchDialog } from './screens/SearchDialog.tsx';
import { TurnScreen } from './screens/TurnScreen.tsx';
import type { LabStore, LabState } from './store.ts';
import { ToolsContext, type AppTools } from './tools.ts';
import { useNotify } from './useNotify.ts';

/** This page's route. A call's comes with the page that opened it, from the history state. */
function currentRoute(): Route {
  const route = parseRoute(location.hash);
  const under = route.page === 'call' ? callOpener(history.state) : null;
  return route.page === 'call' && under ? { ...route, under } : route;
}

function useRoute(): Route {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const update = (): void => setRoute(currentRoute());
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
const signedOutSetup = setupActions(null);
const signedOutStart = startActions(null);
const signedOutApp = appActions(null);
const signedOutCompute = computeActions(null);

/** How often a visible page tells Verifold that the person looks, as the desk's page does. */
export const lookMs = 60_000;

/**
 * Tell Verifold that the person looks at the lab: at once, each minute while
 * `page` shows, and when it shows again. A look after 30 minutes or more
 * away starts the "While you were away" digest. A refusal, such as from a
 * Verifold that takes no looks, would come again for each look, so the
 * looks stop after one, with a line in the console. Returns the stop.
 */
export function sendLooks(
  look: () => Promise<ActOutcome>,
  page: Pick<
    Document,
    'visibilityState' | 'addEventListener' | 'removeEventListener'
  >,
): () => void {
  let stopped = false;
  const tell = (): void => {
    if (stopped || page.visibilityState !== 'visible') return;
    void look().then((outcome) => {
      if (stopped || !('refused' in outcome)) return;
      stop();
      console.info(
        `Verifold refused the page's look, so it sends no more: ${outcome.refused}`,
      );
    });
  };
  const timer = setInterval(tell, lookMs);
  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
    page.removeEventListener('visibilitychange', tell);
  };
  page.addEventListener('visibilitychange', tell);
  tell();
  return stop;
}

function useLook(look: () => Promise<ActOutcome>): void {
  useEffect(() => sendLooks(look, document), [look]);
}

/**
 * ⌘K on a Mac, and Ctrl+K elsewhere, opens the search from any page. In a
 * text box, Ctrl+K stays the box's own key.
 */
function useSearchKey(open: () => void): void {
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (!isSearchKey(event, onMac, typing(event.target))) return;
      event.preventDefault();
      open();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [open]);
}

/** Go to `to` in place of this page, after it renders. */
function Redirect({ to }: { readonly to: string }): ReactNode {
  useEffect(() => replaceRoute(to), [to]);
  return null;
}

interface ScreenProps {
  readonly state: LabState;
  readonly route: Route;
  readonly now: number;
  readonly actions: LabActions;
  readonly agentActions: AgentActions;
  readonly answers?: AnswerActions;
  readonly setup?: SetupActions;
  readonly start?: StartActions;
  readonly startLab?: AppActions['startLab'];
  readonly compute?: ComputeActions;
}

/**
 * The page for a state and a route. Separate from the hooks, so tests
 * render it directly. A call shows over the page that opened it, or over
 * the lab home. That page stays in the same place in the tree, so it keeps
 * its scroll and its open folds while the call opens and closes.
 */
export function Screen(props: ScreenProps): ReactNode {
  const { state, route, now, actions } = props;
  const call = route.page === 'call' ? route : null;
  const shown =
    state.connection !== 'signed-out' && state.connection !== 'outdated'
      ? state.snapshot
      : null;
  const lab = shown?.project ? shown.lab : null;
  return (
    <>
      <Page {...props} route={call ? (call.under ?? { page: 'lab' }) : route} />
      {call && lab && (
        <CallDialog
          key={call.id}
          lab={lab}
          id={call.id}
          now={now}
          actions={actions}
          back={
            call.under && call.under.page !== 'lab' ? 'Back' : 'Back to the lab'
          }
        />
      )}
    </>
  );
}

function Page({
  state,
  route,
  now,
  actions,
  agentActions,
  answers = signedOutAnswers,
  setup = signedOutSetup,
  start = signedOutStart,
  startLab = signedOutApp.startLab,
  compute = signedOutCompute,
}: ScreenProps): ReactNode {
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
  if (route.page === 'setup')
    return (
      <SetupPage
        step={route.step}
        actions={setup}
        // Null until the first snapshot says whether a project exists.
        project={snapshot ? snapshot.project : null}
      />
    );
  // Without a project, the app asks the question of a new one, after the first run.
  if (snapshot && !snapshot.project)
    return route.page === 'ask' ? (
      <AskPage setup={setup} start={start} now={now} connection={connection} />
    ) : (
      <SetupPage step={null} actions={setup} project="" />
    );
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
  // The Ask page is for a folder without a project. With one, the lab opens.
  if (route.page === 'ask') return <Redirect to={href.lab} />;
  // A project's settings and pods open with or without a lab.
  if (route.page === 'settings')
    return (
      <SettingsPage
        snapshot={snapshot}
        connection={connection}
        now={now}
        actions={compute}
        onPause={actions.pause}
      />
    );
  // History, and Start over, open with or without a lab.
  const pageProps = {
    snapshot,
    connection,
    now,
    onPause: actions.pause,
  };
  if (route.page === 'history') return <HistoryPage {...pageProps} />;
  if (route.page === 'history-run')
    return <HistoryRunPage key={route.id} {...pageProps} id={route.id} />;
  if (route.page === 'start-over') return <StartOverPage {...pageProps} />;
  // A project whose current run is from the earlier research flow opens it in History.
  if (!snapshot.lab && snapshot.researchRun && route.page === 'lab')
    return <HistoryRunPage key="current" {...pageProps} id="current" />;
  const lab = snapshot.lab;
  if (!lab)
    return (
      <div className="page">
        <AppHeader
          project={snapshot.project}
          lab={null}
          now={now}
          onPause={actions.pause}
        />
        {/* The pods need the person with or without a lab. */}
        {snapshot.compute && (
          <section className="pods-panel" aria-label="Pods">
            <PodNeeds
              compute={snapshot.compute}
              lab={null}
              now={now}
              actions={compute}
            />
            <PodsLine compute={snapshot.compute} />
          </section>
        )}
        <NoLab snapshot={snapshot} onStart={startLab} />
      </div>
    );
  if (route.page === 'lab' || route.page === 'call')
    return (
      <LabHome
        snapshot={snapshot}
        lab={lab}
        connection={connection}
        now={now}
        actions={actions}
        agentActions={agentActions}
        pods={compute}
        show={route.page === 'lab' ? (route.post ?? null) : null}
      />
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
  if (route.page === 'post')
    return (
      <PostPage
        key={route.id}
        snapshot={snapshot}
        lab={lab}
        id={route.id}
        connection={connection}
        now={now}
        actions={actions}
        read={agentActions.thread}
      />
    );
  if (route.page === 'run')
    return (
      <RunPage
        key={route.id}
        snapshot={snapshot}
        lab={lab}
        id={route.id}
        connection={connection}
        now={now}
        actions={actions}
      />
    );
  if (route.page === 'agent')
    return (
      <AgentPage
        key={route.id}
        snapshot={snapshot}
        lab={lab}
        id={route.id}
        connection={connection}
        now={now}
        actions={actions}
        agentActions={agentActions}
      />
    );
  if (route.page === 'agent-turn') {
    const handle =
      lab.agents.find((entry) => entry.id === route.agent)?.handle ??
      route.agent;
    return (
      <TurnScreen
        key={`${route.agent}/${route.turn}`}
        snapshot={snapshot}
        lab={lab}
        agentId={route.agent}
        back={{ href: href.agent(route.agent), label: handle }}
        turnId={route.turn}
        connection={connection}
        now={now}
        actions={actions}
        agentActions={agentActions}
      />
    );
  }
  const direction = lab.directions.find(
    (entry) => entry.id === route.direction,
  );
  if (!direction)
    return (
      <Notice
        title={
          lab.omitted.directions !== undefined
            ? 'This view of a large lab leaves out this direction'
            : 'This direction is not in the lab'
        }
      >
        <p>
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
    return (
      <DirectionPage key={direction.id} {...page} run={route.run ?? null} />
    );
  if (route.page === 'diff')
    return (
      <DiffPage
        key={`${direction.id}/${route.proof ?? ''}`}
        snapshot={snapshot}
        lab={lab}
        direction={direction}
        proof={route.proof ?? null}
        connection={connection}
        now={now}
        actions={actions}
      />
    );
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
  const handle =
    lab.agents.find((entry) => entry.id === direction.agent)?.handle ??
    direction.agent;
  return (
    <TurnScreen
      key={`${direction.id}/${route.turn}`}
      snapshot={snapshot}
      lab={lab}
      agentId={direction.agent}
      back={{
        href: href.direction(direction.id),
        label: `${handle}'s direction`,
      }}
      turnId={route.turn}
      connection={connection}
      now={now}
      actions={actions}
      agentActions={agentActions}
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
  const [setup] = useState(() => setupActions(token));
  const [start] = useState(() => startActions(token));
  const [app] = useState(() => appActions(token));
  const [history] = useState(() => historyTools(token));
  const [controls] = useState(() => (token ? labControls(token) : null));
  const [compute] = useState(() => computeActions(token));
  // The search opens only over a lab that the page shows: without one, there is nothing to find.
  const lab =
    state.connection === 'signed-out' || state.connection === 'outdated'
      ? null
      : (state.snapshot?.lab ?? null);
  const shown = lab !== null;
  const hasLab = useRef(false);
  hasLab.current = shown;
  const [searching, setSearching] = useState(false);
  const openSearch = useCallback(() => {
    if (hasLab.current) setSearching(true);
  }, []);
  // A search open when the lab goes stays closed when it comes back.
  useEffect(() => {
    if (!shown) setSearching(false);
  }, [shown]);
  useSearchKey(openSearch);
  useLook(app.look);
  const notify = useNotify(state.snapshot);
  const tools = useMemo<AppTools>(
    () => ({ openSearch, dismissAway: app.dismissAway, notify }),
    [openSearch, app, notify],
  );
  return (
    <ToolsContext.Provider value={tools}>
      <ControlsContext.Provider value={controls}>
        <HistoryContext.Provider value={history}>
          <Screen
            state={state}
            route={route}
            now={now}
            actions={actions}
            agentActions={agent}
            answers={answers}
            setup={setup}
            start={start}
            startLab={app.startLab}
            compute={compute}
          />
        </HistoryContext.Provider>
        {searching && lab && (
          <SearchDialog
            lab={lab}
            run={app.search}
            onClose={() => setSearching(false)}
          />
        )}
      </ControlsContext.Provider>
    </ToolsContext.Provider>
  );
}
