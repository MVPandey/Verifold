import { useContext, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import type { Api } from '../api/client.ts';
import { messageOf } from '../api/client.ts';
import { GUEST } from '../api/types.ts';
import type {
  Agent,
  AgentView,
  FolderView,
  Invitation,
  LabView,
  ThreadSummary,
} from '../api/types.ts';
import { costLine } from '../model/agents.ts';
import { wrapFocus } from '../model/focus.ts';
import { dayClock } from '../model/format.ts';
import {
  ROLE_LIMIT,
  editLine,
  giveRole,
  outcomeLines,
  pictureBefore,
  seatBeside,
  seatSwitches,
  takeBackRole,
  takeBacks,
} from '../model/identity.ts';
import type { SeatAction } from '../model/identity.ts';
import { seatLines } from '../model/pace.ts';
import { href } from '../model/route.ts';
import { whereLine } from '../model/status.ts';
import { Detail } from './Markdown.tsx';
import { SeatPaceControls } from './Pace.tsx';
import { Mark, MarksAndRoles, Picture, Profiles } from './Picture.tsx';

/**
 * Everything about one member, over the page: who it is, what it does now, what became of its posts, what the
 * person or a coordinator changed, and what the person can do to its seat. It opens from a press on any name or
 * picture. Escape closes it, and so does a press outside it. While it is open, Tab stays inside it, and when it
 * closes, focus goes back to the control that opened it.
 */
export function ProfileSheet(props: {
  readonly view: AgentView;
  readonly lab: LabView;
  readonly threads: readonly ThreadSummary[];
  readonly now: Date;
  readonly api: Api;
  /** The invitation that shows now, or `null`. The sheet shows it when it is for this agent. */
  readonly invitation: Invitation | null;
  readonly onInvitation: (invitation: Invitation | null) => void;
  readonly onChange: () => void;
  readonly onClose: () => void;
}): ReactElement {
  const { view, lab, api, onChange, onClose } = props;
  const { agent } = view;
  const seat = seatBeside(view);
  const thread = props.threads.find((summary) => summary.thread.id === view.thread)?.thread;
  const member = agent.checks === null && !view.left;
  const chose = seat !== null || view.about !== '' || view.picture !== null;
  const sheet = useRef<HTMLDivElement>(null);
  const closer = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    closer.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const keys = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !sheet.current) return;
      const controls = [...sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const at = controls.findIndex((control) => control === document.activeElement);
      const next = wrapFocus(controls.length, at, event.shiftKey);
      if (next === null) return;
      event.preventDefault();
      controls[next]?.focus();
    };
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('keydown', keys);
    };
  }, [onClose]);

  return (
    <div className="i-over" onClick={onClose}>
      <div
        ref={sheet}
        className="i-profile"
        role="dialog"
        aria-modal="true"
        aria-label={`Profile of ${agent.name}`}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="i-profile-top">
          <Mark view={view} size={52} dot={false} />
          <div>
            <p className="i-profile-name">{agent.name}</p>
            {seat ? <p className="i-prov">{seat}</p> : null}
            <MarksAndRoles view={view} />
          </div>
          <button ref={closer} className="i-x" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        {view.about ? (
          <>
            <p className="i-about">{view.about}</p>
            {view.about_by !== null && view.about_by !== agent.id ? (
              <p className="i-prov">Written by the coordinator.</p>
            ) : null}
          </>
        ) : (
          <p className="i-about none">
            {chose
              ? 'This agent has not written an about line.'
              : 'This agent has not chosen a name, a picture or an about line.'}
          </p>
        )}
        {view.flag ? (
          <p className="i-flag">
            <b>Flagged by the coordinator.</b> {view.flag}
          </p>
        ) : null}
        <dl>
          {view.status && !view.left ? (
            <>
              <dt>Status</dt>
              <dd>{view.status}</dd>
            </>
          ) : null}
          <dt>Now</dt>
          <dd>{whereLine(view, lab, props.now, null)}</dd>
          <dt>Model family</dt>
          <dd>{agent.model.family}</dd>
          {thread && !view.left ? (
            <>
              <dt>Works in</dt>
              <dd>
                <a href={href({ page: 'thread', id: thread.id, post: null })} onClick={onClose}>
                  {thread.title}
                </a>
              </dd>
            </>
          ) : null}
          <dt>Cost</dt>
          <dd>{costLine(view)}</dd>
          {seatLines(view, props.now).length > 0 ? (
            <>
              <dt>Pace and limits</dt>
              <dd>
                {seatLines(view, props.now).join(' · ')}
                {view.pause?.why ? <span className="i-why">Why: {view.pause.why}</span> : null}
                {view.cap?.why ? <span className="i-why">Why: {view.cap.why}</span> : null}
              </dd>
            </>
          ) : null}
        </dl>
        {view.error && !view.left ? <Failure error={view.error} /> : null}
        {view.notes ? (
          <>
            <h3>Notes</h3>
            <p className="i-prov">
              The agent keeps these notes for itself.
              {view.notes_at ? (
                <>
                  {' '}
                  Last change:{' '}
                  <time dateTime={view.notes_at}>{dayClock(view.notes_at, props.now)}</time>.
                </>
              ) : null}
            </p>
            <Detail post={agent.id} body={view.notes} files={[]} />
          </>
        ) : null}

        <h3>What became of its posts</h3>
        <dl>
          {outcomeLines(view.outcomes).map((line) => (
            <div key={line.label} className="i-outcome">
              <dt>{line.label}</dt>
              <dd>
                <b>{line.posts.length}</b>
                {line.posts.map((post) => (
                  <a
                    key={post.id}
                    href={href({ page: 'thread', id: post.thread, post: post.id })}
                    onClick={onClose}
                  >
                    {post.id}
                  </a>
                ))}
              </dd>
            </div>
          ))}
        </dl>

        {view.edits.length > 0 ? (
          <>
            <h3>Changes by you or a coordinator</h3>
            <ul className="i-edits">
              {view.edits.map((edit, index) => {
                const before = pictureBefore(edit);
                return (
                  <li key={index}>
                    <time dateTime={edit.at}>{dayClock(edit.at, props.now)}</time>
                    <span>
                      {editLine(edit)}
                      {before ? (
                        <>
                          {' '}
                          Before: <Picture picture={before} size={16} />
                        </>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}

        {member ? (
          <div className="i-acts">
            <h3>What you can do</h3>
            <Acts api={api} actions={takeBacks(view)} onChange={onChange} />
            <RoleField api={api} view={view} onChange={onChange} />
            <SeatControls api={api} view={view} onChange={onChange} />
            <SeatPaceControls api={api} view={view} now={props.now} onChange={onChange} />
            {view.stopped ? <StartAgain api={api} agent={agent.id} onChange={onChange} /> : null}
            {agent.harness === GUEST ? (
              <InviteAgain
                api={api}
                agent={agent.id}
                onInvited={props.onInvitation}
                onChange={onChange}
              />
            ) : null}
            {props.invitation?.agent === agent.id ? (
              <InvitationText
                key={props.invitation.text}
                invitation={props.invitation}
                onClose={() => {
                  props.onInvitation(null);
                }}
              />
            ) : null}
            <OpenFolder api={api} agent={agent} />
            <RemoveAgent
              api={api}
              agent={agent}
              onChange={() => {
                onChange();
                onClose();
              }}
            />
          </div>
        ) : (
          <div className="i-acts">
            {/* What an agent chose stays on its posts after it left, so the person can still take it back. */}
            {agent.checks === null && takeBacks(view).length > 0 ? (
              <>
                <h3>What you can do</h3>
                <Acts api={api} actions={takeBacks(view)} onChange={onChange} />
              </>
            ) : null}
            <OpenFolder api={api} agent={agent} />
          </div>
        )}
      </div>
    </div>
  );
}

/** The controls of the sheet that Tab reaches. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), summary';

/**
 * The profile sheet of the agent that the app shows now, or nothing. It reads the agent from the lab at every
 * render, so the sheet follows the lab while it is open.
 */
export function ShownProfile(
  props: Omit<Parameters<typeof ProfileSheet>[0], 'view' | 'onClose'>,
): ReactElement | null {
  const { shown, show } = useContext(Profiles);
  const view = props.lab.agents.find((one) => one.agent.id === shown);
  if (!view) return null;
  return (
    <ProfileSheet
      {...props}
      view={view}
      onClose={() => {
        show(null);
      }}
    />
  );
}

/** A row of the person's actions, each a button that runs its call and then reads the lab again. */
function Acts(props: {
  readonly api: Api;
  readonly actions: readonly SeatAction[];
  readonly onChange: () => void;
}): ReactElement | null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (props.actions.length === 0) return null;
  const run = (action: SeatAction): void => {
    setBusy(true);
    setError(null);
    action.run(props.api).then(
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
    <p className="f-where i-act-row">
      {props.actions.map((action) => (
        <button
          key={action.label}
          className="linkbtn"
          type="button"
          disabled={busy}
          onClick={() => {
            run(action);
          }}
        >
          {action.label}
        </button>
      ))}
      {error ? (
        <span className="error" role="alert">
          {error}
        </span>
      ) : null}
    </p>
  );
}

/** The field that gives a member's seat a role, or changes the one that it has, and the way to take it back. */
function RoleField(props: {
  readonly api: Api;
  readonly view: AgentView;
  readonly onChange: () => void;
}): ReactElement {
  const { view } = props;
  const [text, setText] = useState(view.given_role);
  const id = useId();
  const give = giveRole(view, text);
  const back = takeBackRole(view);
  return (
    <div className="i-role">
      <label htmlFor={id}>Role that you give</label>
      <input
        id={id}
        value={text}
        maxLength={ROLE_LIMIT}
        placeholder="None. Such as: driver"
        onChange={(event) => {
          setText(event.target.value);
        }}
      />
      <Acts
        api={props.api}
        actions={[give, back].filter((action) => action !== null)}
        onChange={props.onChange}
      />
    </div>
  );
}

/** Return whether a member has neither run a turn nor posted, and runs none now: it never started or never came. */
function notCome(view: AgentView): boolean {
  const resting = ['idle', 'invited', 'void', 'stopped'].includes(view.activity.state);
  return view.turns === 0 && view.posts === 0 && resting;
}

/**
 * What the profile says about a member's seat, and the person's three switches for it: on call, the coordinator
 * seat, and a reviewer seat.
 */
export function SeatControls(props: {
  readonly api: Api;
  readonly view: AgentView;
  readonly onChange: () => void;
}): ReactElement {
  const { view } = props;
  return (
    <>
      {view.coordinator && notCome(view) ? (
        <p className="f-where">Holds the coordinator seat and has not come yet.</p>
      ) : null}
      <Acts api={props.api} actions={seatSwitches(view)} onChange={props.onChange} />
    </>
  );
}

/** The most characters of a harness's error that the profile shows before the person opens it. */
const FAILURE_SHOWN = 160;

/**
 * Why a member's harness failed last, in the harness's own words, as text. A long error shows its start, and the
 * person opens it to read it whole.
 */
function Failure(props: { readonly error: string }): ReactElement {
  const line = props.error.replace(/\s+/g, ' ').trim();
  if (line.length <= FAILURE_SHOWN) return <p className="f-where">Last failure: {line}</p>;
  return (
    <details className="f-each">
      <summary>Last failure: {line.slice(0, FAILURE_SHOWN)}…</summary>
      <pre className="f-failure">{props.error}</pre>
    </details>
  );
}

/**
 * The way to give an invited agent a new invitation: when the first one is lost, or when its token is no longer
 * private. The agent's earlier token then opens nothing.
 */
export function InviteAgain(props: {
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
export function StartAgain(props: {
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
export function OpenFolder(props: { readonly api: Api; readonly agent?: Agent }): ReactElement {
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
export function RemoveAgent(props: {
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
