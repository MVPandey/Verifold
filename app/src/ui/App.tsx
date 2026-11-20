import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';

import type { Api } from '../api/client.ts';
import { useLab, useNow, useRoute } from './hooks.ts';
import { FilePage } from './FilePage.tsx';
import { LabPage } from './LabPage.tsx';
import { Manifold } from './Manifold.tsx';
import { NeedsPage } from './NeedsPage.tsx';
import { NormsPage } from './NormsPage.tsx';
import { Profiles } from './Picture.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { SetupPage } from './SetupPage.tsx';
import { Top } from './Top.tsx';

/** The app: the setup screen until the folder has a lab, and the lab's pages after that. */
export function App(props: { readonly api: Api; readonly token: string }): ReactElement {
  const data = useLab(props.api, props.token);
  const route = useRoute();
  const now = useNow();
  // The agent whose profile shows over the page, or `null`. A press on any name or picture sets it.
  const [shown, show] = useState<string | null>(null);
  const profiles = useMemo(() => ({ shown, show }), [shown]);

  if (data.setup === null) {
    return <Message text={data.error ?? 'Loading the lab.'} />;
  }
  if (data.lab === null) {
    return (
      <>
        <Top folder={data.setup.folder} route={route} open={null} />
        <main className="page">
          {route.page === 'settings' ? (
            <SettingsPage
              api={props.api}
              labOpen={false}
              harnesses={data.setup.harnesses}
              onChanged={data.reload}
            />
          ) : route.page === 'norms' ? (
            <NormsPage api={props.api} labOpen={false} />
          ) : (
            <SetupPage
              api={props.api}
              setup={data.setup}
              onStarted={data.reload}
              onRefresh={data.reload}
            />
          )}
        </main>
      </>
    );
  }
  const shared = { api: props.api, data: { ...data, lab: data.lab }, now };
  const onWall = route.page === 'lab' || route.page === 'thread' || route.page === 'dashboard';
  return (
    <Profiles value={profiles}>
      {onWall ? <Manifold /> : null}
      <Top
        folder={data.setup.folder}
        route={route}
        open={{
          lab: data.lab,
          threads: data.threads,
          harnesses: data.setup.harnesses,
          needs: data.needs.length,
          now,
          api: props.api,
          onChange: data.reload,
        }}
      />
      {data.error ? (
        <p className="banner" role="alert">
          {data.error}
        </p>
      ) : null}
      <main className={onWall ? 'wall' : 'page'}>
        {route.page === 'needs' ? (
          <NeedsPage {...shared} />
        ) : route.page === 'file' ? (
          <FilePage api={props.api} post={route.post} path={route.path} />
        ) : route.page === 'norms' ? (
          <NormsPage api={props.api} labOpen />
        ) : route.page === 'settings' ? (
          <SettingsPage
            api={props.api}
            labOpen
            harnesses={data.setup.harnesses}
            onChanged={data.reload}
          />
        ) : (
          <LabPage
            {...shared}
            open={route.page === 'thread' ? route.id : null}
            post={route.page === 'thread' ? route.post : null}
            tab={route.page === 'dashboard' ? 'dashboard' : 'wall'}
          />
        )}
      </main>
    </Profiles>
  );
}

/** A page with one message, such as the one for a link without the person's token. */
export function Message(props: { readonly text: string }): ReactElement {
  return (
    <main className="page">
      <p className="lone" role="status">
        {props.text}
      </p>
    </main>
  );
}

/** What the app shows in place of a page that failed to render: what happened, and the way to load the page again. */
export function Failed(): ReactElement {
  return (
    <main className="page">
      <p className="lone" role="alert">
        Verifold could not show this page. The lab runs on, and its record is safe.{' '}
        <a
          href="."
          onClick={(event) => {
            event.preventDefault();
            window.location.reload();
          }}
        >
          Load the page again
        </a>
      </p>
    </main>
  );
}
