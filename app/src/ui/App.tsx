import type { ReactElement } from 'react';

import type { Api } from '../api/client.ts';
import type { LabView } from '../api/types.ts';
import { href } from '../model/route.ts';
import type { Route } from '../model/route.ts';
import { runStatus } from '../model/time.ts';
import { useLab, useNow, useRoute } from './hooks.ts';
import { LabPage } from './LabPage.tsx';
import { NeedsPage } from './NeedsPage.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import { SetupPage } from './SetupPage.tsx';
import { ThreadPage } from './ThreadPage.tsx';

/** The app: the setup screen until the folder has a lab, and the lab's pages after that. */
export function App(props: { readonly api: Api; readonly token: string }): ReactElement {
  const data = useLab(props.api, props.token);
  const route = useRoute();
  const now = useNow();

  if (data.setup === null) {
    return <Message text={data.error ?? 'Loading the lab.'} />;
  }
  if (data.lab === null) {
    return (
      <>
        <Header folder={data.setup.folder} lab={null} route={route} now={now} needs={0} />
        <main className="page">
          {route.page === 'settings' ? (
            <SettingsPage api={props.api} labOpen={false} harnesses={data.setup.harnesses} />
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
  return (
    <>
      <Header
        folder={data.setup.folder}
        lab={data.lab}
        route={route}
        now={now}
        needs={data.needs.length}
      />
      {data.error ? (
        <p className="banner" role="alert">
          {data.error}
        </p>
      ) : null}
      <main className="page">
        {route.page === 'needs' ? (
          <NeedsPage {...shared} />
        ) : route.page === 'settings' ? (
          <SettingsPage api={props.api} labOpen harnesses={data.setup.harnesses} />
        ) : route.page === 'thread' ? (
          <ThreadPage key={route.id} {...shared} id={route.id} />
        ) : (
          <LabPage {...shared} />
        )}
      </main>
    </>
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

function Header(props: {
  readonly folder: string;
  readonly lab: LabView | null;
  readonly route: Route;
  readonly now: Date;
  readonly needs: number;
}): ReactElement {
  const name = props.folder.split('/').filter(Boolean).pop() ?? props.folder;
  const lab = props.lab;
  return (
    <header className="top">
      <a className="brand" href={href({ page: 'lab' })}>
        <img src="/verifold-symbol.webp" alt="" />
        <span>verifold</span>
      </a>
      <span className="crumb-lab">
        <b>{lab ? name : 'New lab'}</b>
      </span>
      {lab ? (
        <>
          <nav className="tabs" aria-label="Pages">
            <a
              href={href({ page: 'lab' })}
              aria-current={
                props.route.page === 'lab' || props.route.page === 'thread' ? 'page' : undefined
              }
            >
              Lab
            </a>
            <a
              href={href({ page: 'needs' })}
              aria-current={props.route.page === 'needs' ? 'page' : undefined}
            >
              Needs you
              {props.needs > 0 ? <span className="count">{props.needs}</span> : null}
            </a>
          </nav>
          <span className="run">
            <span className={`dot${lab.out_of_time ? ' stop' : ''}`} />
            {runStatus(lab, props.now)}
          </span>
        </>
      ) : null}
      <a
        className="settingslink"
        href={href({ page: 'settings' })}
        aria-current={props.route.page === 'settings' ? 'page' : undefined}
      >
        Settings
      </a>
    </header>
  );
}
