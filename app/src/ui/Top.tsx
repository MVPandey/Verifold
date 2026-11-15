import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { Api } from '../api/client.ts';
import { messageOf } from '../api/client.ts';
import { GUEST } from '../api/types.ts';
import type {
  Agent,
  AgentView,
  FolderView,
  HarnessOption,
  Invitation,
  LabView,
  ThreadSummary,
} from '../api/types.ts';
import {
  costLine,
  face,
  harnessTitle,
  labTotal,
  listed,
  memberLine,
  workingLine,
} from '../model/agents.ts';
import { href } from '../model/route.ts';
import type { Route } from '../model/route.ts';
import { stopLine } from '../model/settings.ts';
import { clockLine, endLine, moreTime } from '../model/time.ts';
import { FaceView } from './parts.tsx';

/** What the top bar shows for a started lab. */
export interface TopLab {
  readonly lab: LabView;
  /** The lab's threads, so that the member list can name the thread where each member works. */
  readonly threads: readonly ThreadSummary[];
  readonly harnesses: readonly HarnessOption[];
  readonly needs: number;
  readonly now: Date;
  readonly api: Api;
  readonly onChange: () => void;
}

/** The top bar: the wordmark, the project, the pages, and for a started lab its members and its clock. */
export function Top(props: {
  readonly folder: string;
  readonly route: Route;
  readonly open: TopLab | null;
}): ReactElement {
  const name = props.folder.split('/').filter(Boolean).pop() ?? props.folder;
  const { open, route } = props;
  const place = href(route);
  // The invitation is here, and not in the member list, because the list starts again on every new page. It holds
  // the only copy of the agent's token, so it stays until the person closes it.
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const current = (on: boolean): 'page' | undefined => (on ? 'page' : undefined);

  // Escape closes an open panel, and so does a press anywhere outside it.
  useEffect(() => {
    const close = (event: KeyboardEvent | PointerEvent): void => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      for (const panel of document.querySelectorAll<HTMLDetailsElement>('.f-pop[open]')) {
        const inside = event.target instanceof Node && panel.contains(event.target);
        if (event instanceof KeyboardEvent || !inside) panel.open = false;
      }
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', close);
    };
  }, []);
  return (
    <header className="f-top">
      <a className="f-brand" href={href({ page: 'lab' })}>
        verifold
      </a>
      <span>{open ? name : 'New lab'}</span>
      <nav className="f-nav" aria-label="Pages">
        {open ? (
          <>
            <a
              href={href({ page: 'lab' })}
              aria-current={current(route.page === 'lab' || route.page === 'thread')}
            >
              Lab
            </a>
            <a href={href({ page: 'needs' })} aria-current={current(route.page === 'needs')}>
              Needs you
              {open.needs > 0 ? <span className="count">{open.needs}</span> : null}
            </a>
          </>
        ) : null}
        <a href={href({ page: 'settings' })} aria-current={current(route.page === 'settings')}>
          Settings
        </a>
      </nav>
      {open ? (
        <>
          <span className="grow" />
          {/* A new key closes an open panel when the person goes to another page or thread. */}
          <Members
            key={`who${place}`}
            api={open.api}
            onChange={open.onChange}
            lab={open.lab}
            threads={open.threads}
            harnesses={open.harnesses}
            now={open.now}
            invitation={invitation}
            onInvitation={setInvitation}
          />
          <details key={place} className="f-pop f-time" name="top">
            <summary>{clockLine(open.lab, open.now)}</summary>
            <TimePanel lab={open.lab} now={open.now} api={open.api} onChange={open.onChange} />
          </details>
        </>
      ) : null}
    </header>
  );
}

/**
 * The member list: who is in the lab, the role and the status that each gave itself, the thread where each works,
 * what each does now, and what each has cost.
 */
function Members(props: {
  readonly api: Api;
  readonly onChange: () => void;
  readonly lab: LabView;
  readonly threads: readonly ThreadSummary[];
  readonly harnesses: readonly HarnessOption[];
  readonly now: Date;
  /** The invitation that shows now, or `null`. */
  readonly invitation: Invitation | null;
  readonly onInvitation: (invitation: Invitation | null) => void;
}): ReactElement {
  const { lab } = props;
  const reruns = lab.agents.filter((view) => view.agent.checks !== null);
  const first = reruns[0];
  const busy = lab.agents.some((view) => view.activity.state === 'working');
  const dot = lab.out_of_time ? 'stop' : busy ? 'live' : 'idle';
  const row = (view: AgentView): ReactElement => {
    const state = memberLine(view, lab.out_of_time || lab.state === 'closed', props.now);
    return (
      <>
        <p>
          <b>{view.agent.name}</b>
          {view.role ? <span className="f-role">{view.role}</span> : null}
          <span className="f-tag">{harnessTitle(props.harnesses, view.agent.harness)}</span>
        </p>
        {view.status ? <p className="f-own">{view.status}</p> : null}
        <p className="f-status">
          <span className={`dot ${state.dot}`} /> {state.text}
        </p>
        <Where view={view} threads={props.threads} />
        <p className="f-where">{costLine(view)}</p>
        {view.agent.harness === GUEST && !view.left ? (
          <InviteAgain
            api={props.api}
            agent={view.agent.id}
            onInvited={props.onInvitation}
            onChange={props.onChange}
          />
        ) : null}
        {view.stopped && !view.left ? (
          <StartAgain api={props.api} agent={view.agent.id} onChange={props.onChange} />
        ) : null}
        <OpenFolder api={props.api} agent={view.agent} />
        {view.agent.checks === null && !view.left ? (
          <RemoveAgent api={props.api} agent={view.agent} onChange={props.onChange} />
        ) : null}
      </>
    );
  };
  return (
    <details className="f-pop f-members" name="top">
      <summary className="f-live">
        <span className={`dot ${dot}`} /> {workingLine(lab.agents)}
        <u>
          <span className="closed">Who</span>
          <span className="opened">Hide</span>
        </u>
      </summary>
      <div className="f-panel">
        <ul>
          {listed(lab.agents).map((view) => (
            <li key={view.agent.id}>
              <FaceView face={face(lab.agents, view.agent.id)} />
              <div>{row(view)}</div>
            </li>
          ))}
          {first ? (
            <li>
              <FaceView face={face(lab.agents, first.agent.id)} />
              <div>
                <p>
                  <b>{reruns.length === 1 ? '1 blind rerun' : `${reruns.length} blind reruns`}</b>
                </p>
                <p className="f-where">
                  Outside checkers on the other model family. Each leaves after one check.
                </p>
                <details className="f-each">
                  <summary>What each did and cost</summary>
                  <ul>
                    {reruns.map((view) => (
                      <li key={view.agent.id}>{row(view)}</li>
                    ))}
                  </ul>
                </details>
              </div>
            </li>
          ) : null}
        </ul>
        <p className="f-total">
          <span>
            {lab.posts} {lab.posts === 1 ? 'post' : 'posts'} in {lab.threads}{' '}
            {lab.threads === 1 ? 'thread' : 'threads'}
          </span>
          <span>
            Lab total <b>{labTotal(lab.agents)}</b>
          </span>
        </p>
        <div className="f-add">
          <OpenFolder api={props.api} />
        </div>
        <AddAgent api={props.api} harnesses={props.harnesses} onChange={props.onChange} />
        <InviteAgent api={props.api} onInvited={props.onInvitation} onChange={props.onChange} />
        {props.invitation ? (
          <InvitationText
            key={props.invitation.text}
            invitation={props.invitation}
            onClose={() => {
              props.onInvitation(null);
            }}
          />
        ) : null}
      </div>
    </details>
  );
}

/**
 * The way to add one agent to the lab that runs. The agent uses the harness's own defaults, reads the board, and
 * chooses its work as the others do.
 */
function AddAgent(props: {
  readonly api: Api;
  readonly harnesses: readonly HarnessOption[];
  readonly onChange: () => void;
}): ReactElement | null {
  const ready = props.harnesses.filter((harness) => harness.available);
  const [harness, setHarness] = useState(ready[0]?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (ready.length === 0) return null;
  const add = (): void => {
    setBusy(true);
    setError(null);
    props.api.addAgents({ harness, count: 1 }).then(
      () => {
        setBusy(false);
        props.onChange();
      },
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure));
      },
    );
  };
  return (
    <div className="f-add">
      <label>
        Add an agent
        <select
          value={harness}
          onChange={(event) => {
            setHarness(event.target.value);
          }}
        >
          {ready.map((option) => (
            <option key={option.name} value={option.name}>
              {option.title}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={add} disabled={busy}>
        {busy ? 'Adding' : 'Add'}
      </button>
      {error ? (
        <span className="error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The way to invite an agent that the person runs themselves, in any harness that speaks MCP. Verifold starts
 * nothing for it.
 */
function InviteAgent(props: {
  readonly api: Api;
  readonly onInvited: (invitation: Invitation) => void;
  readonly onChange: () => void;
}): ReactElement {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invite = (): void => {
    setBusy(true);
    setError(null);
    props.api.invite(name.trim() || undefined).then(
      (made) => {
        setBusy(false);
        setName('');
        props.onInvited(made);
        props.onChange();
      },
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure));
      },
    );
  };
  return (
    <div className="f-add f-invite">
      <label>
        Invite an agent
        <input
          value={name}
          maxLength={40}
          placeholder="Name, if you want one"
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>
      <button type="button" onClick={invite} disabled={busy}>
        {busy ? 'Inviting' : 'Invite'}
      </button>
      <p className="f-where">
        For an agent that you run yourself. Verifold does not start it or stop it.
      </p>
      {error ? (
        <span className="error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The way to give an invited agent a new invitation: when the first one is lost, or when its token is no longer
 * private. The agent's earlier token then opens nothing.
 */
function InviteAgain(props: {
  readonly api: Api;
  readonly agent: string;
  readonly onInvited: (invitation: Invitation) => void;
  readonly onChange: () => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const again = (): void => {
    setBusy(true);
    setError(null);
    props.api.inviteAgain(props.agent).then(
      (made) => {
        setBusy(false);
        props.onInvited(made);
        props.onChange();
      },
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure));
      },
    );
  };
  return (
    <p className="f-where">
      <button
        className="linkbtn"
        type="button"
        onClick={again}
        disabled={busy}
        title="Makes a new token. The old token stops working."
      >
        Invite again
      </button>
      {error ? (
        <span className="error" role="alert">
          {' '}
          {error}
        </span>
      ) : null}
    </p>
  );
}

/**
 * The way to start an agent that Verifold stopped because its harness failed too often in a row. The agent keeps
 * its name, its folder, and its posts.
 */
function StartAgain(props: {
  readonly api: Api;
  readonly agent: string;
  readonly onChange: () => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const again = (): void => {
    setBusy(true);
    setError(null);
    props.api.startAgain(props.agent).then(
      () => {
        setBusy(false);
        props.onChange();
      },
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure));
      },
    );
  };
  return (
    <p className="f-where">
      Its harness failed too often, so Verifold stopped it.{' '}
      <button className="linkbtn" type="button" onClick={again} disabled={busy}>
        Start again
      </button>
      {error ? (
        <span className="error" role="alert">
          {' '}
          {error}
        </span>
      ) : null}
    </p>
  );
}

/**
 * The way to the folder where an agent works, or without `agent`, to the folder that holds every agent's folder.
 * A browser cannot open a folder, so the server opens it in the file manager of its computer. The path shows
 * after the press, for the person to copy.
 */
function OpenFolder(props: { readonly api: Api; readonly agent?: Agent }): ReactElement {
  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState<FolderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = (): void => {
    setBusy(true);
    setError(null);
    props.api.openFolder(props.agent?.id).then(
      (view) => {
        setBusy(false);
        setFolder(view);
      },
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure));
      },
    );
  };
  return (
    <p className="f-where f-folder">
      <button
        className="linkbtn"
        type="button"
        // Every row has this button, so its name says whose folder it opens.
        aria-label={props.agent ? `Open the folder of ${props.agent.name}` : undefined}
        onClick={open}
        disabled={busy}
      >
        {props.agent ? 'Open folder' : 'Open the agents’ folder'}
      </button>
      <FolderLine folder={folder} />
      {error ? (
        <span className="error" role="alert">
          {' '}
          {error}
        </span>
      ) : null}
    </p>
  );
}

/**
 * Where a folder is, after the person asked to open it. When the server opened nothing, as on a computer without
 * a desktop or after `--no-browser`, the line says so, and the path is still there to copy. The line is in the
 * page before it has text, so that a screen reader announces the text when it comes.
 */
export function FolderLine(props: { readonly folder: FolderView | null }): ReactElement {
  return (
    <span role="status">
      {props.folder ? (
        <>
          {props.folder.opened ? 'Opened' : 'No file manager opened. The folder is'}{' '}
          <code>{props.folder.path}</code>
        </>
      ) : null}
    </span>
  );
}

/**
 * The way to remove one agent from the lab. The first press asks, in the row itself, and the second removes. The
 * agent's posts stay, and the agent does not come back.
 */
function RemoveAgent(props: {
  readonly api: Api;
  readonly agent: Agent;
  readonly onChange: () => void;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = (): void => {
    setBusy(true);
    setError(null);
    props.api.removeAgent(props.agent.id).then(
      () => {
        props.onChange();
      },
      (failure: unknown) => {
        setBusy(false);
        setError(messageOf(failure));
      },
    );
  };
  if (!confirming) {
    return (
      <p className="f-where">
        <button
          className="linkbtn"
          type="button"
          onClick={() => {
            setConfirming(true);
          }}
        >
          Remove
        </button>
      </p>
    );
  }
  return (
    <p className="f-where">
      Remove {props.agent.name} from the lab? Its posts stay, and it cannot come back. Programs that
      it started in the background run on until the lab stops.{' '}
      <button className="btn small danger" type="button" onClick={remove} disabled={busy}>
        {busy ? 'Removing' : 'Remove'}
      </button>{' '}
      <button
        className="linkbtn"
        type="button"
        disabled={busy}
        onClick={() => {
          setConfirming(false);
          setError(null);
        }}
      >
        Keep
      </button>
      {error ? (
        <span className="error" role="alert">
          {' '}
          {error}
        </span>
      ) : null}
    </p>
  );
}

/** An invitation, as text to copy. It holds the agent's token, and Verifold does not show it again. */
export function InvitationText(props: {
  readonly invitation: Invitation;
  readonly onClose: () => void;
}): ReactElement {
  const { invitation } = props;
  const [copied, setCopied] = useState<boolean | null>(null);
  const copy = (): void => {
    navigator.clipboard.writeText(invitation.text).then(
      () => {
        setCopied(true);
      },
      () => {
        setCopied(false);
      },
    );
  };
  return (
    <div className="f-invitation">
      <p>
        <b>Invitation for {invitation.name}</b>
      </p>
      <p className="f-where">
        Give this text to the agent. It holds the agent’s token, and it shows only until you close
        it. If you lose it, use Invite again.
      </p>
      <textarea readOnly rows={8} value={invitation.text} aria-label="Invitation text" />
      <button type="button" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
      <button className="linkbtn" type="button" onClick={props.onClose}>
        Close
      </button>
      {copied === false ? (
        <span className="error" role="alert">
          The browser did not copy the text. Select it and copy it yourself.
        </span>
      ) : null}
    </div>
  );
}

/**
 * The thread where a member works, as a link: the thread of its latest plan or result. It shows nothing when the
 * member works in none or the page lacks the thread. The state line above says whether a turn runs now.
 */
function Where(props: {
  readonly view: AgentView;
  readonly threads: readonly ThreadSummary[];
}): ReactElement | null {
  const { view } = props;
  const thread = props.threads.find((summary) => summary.thread.id === view.thread)?.thread;
  if (!thread) return null;
  return (
    <p className="f-where">
      Works in <a href={href({ page: 'thread', id: thread.id, post: null })}>{thread.title}</a>
    </p>
  );
}

/** The lab's time: when it ends, more time, and the stop with its confirmation. */
function TimePanel(props: {
  readonly lab: LabView;
  readonly now: Date;
  readonly api: Api;
  readonly onChange: () => void;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { lab } = props;

  const setTime = (minutes: number): void => {
    setError(null);
    props.api.setTime(minutes).then(
      () => {
        setConfirming(false);
        props.onChange();
      },
      (failure: unknown) => {
        setError(messageOf(failure));
      },
    );
  };

  return (
    <div className="f-panel timebox">
      <p>{endLine(lab, props.now)}</p>
      <div className="timeacts">
        {lab.ends_at !== null ? (
          <>
            <button
              className="btn small"
              type="button"
              onClick={() => setTime(moreTime(lab, 30, new Date()))}
            >
              30 more min
            </button>
            <button
              className="btn small"
              type="button"
              onClick={() => setTime(moreTime(lab, 60, new Date()))}
            >
              1 more hour
            </button>
          </>
        ) : null}
        {lab.out_of_time ? null : confirming ? (
          <button className="btn small danger" type="button" onClick={() => setTime(0)}>
            Stop every agent now
          </button>
        ) : (
          <button className="linkbtn" type="button" onClick={() => setConfirming(true)}>
            Stop the lab
          </button>
        )}
      </div>
      {confirming && !lab.out_of_time ? (
        <p className="quiet stopline">
          {stopLine(lab.settings)} <a href={href({ page: 'settings' })}>Change this</a>
        </p>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
