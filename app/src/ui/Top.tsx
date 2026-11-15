import { useContext, useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { Api } from '../api/client.ts';
import { messageOf } from '../api/client.ts';
import type { AgentView, HarnessOption, Invitation, LabView, ThreadSummary } from '../api/types.ts';
import { labTotal } from '../model/agents.ts';
import { href } from '../model/route.ts';
import type { Route } from '../model/route.ts';
import { modelSummary, needsModel, newSeat, seatChoice } from '../model/setup.ts';
import { stopLine } from '../model/settings.ts';
import { WAITS_ID, needGroups, turnLine, waitsLine, whereLine } from '../model/status.ts';
import { clockLine, endLine, moreTime } from '../model/time.ts';
import { MarksAndRoles, Name, Profiles, Who } from './Picture.tsx';
import { InvitationText, OpenFolder, ShownProfile, StartAgain } from './Profile.tsx';
import { CoordinatorSeat, FactFields, ReviewerSeats, SeatFields } from './SeatForm.tsx';
import type { Facts } from './SeatForm.tsx';

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

  // Escape closes an open panel, and so does a press anywhere outside it. While a profile is open, both belong
  // to the profile, so the panel under it stays as it is.
  useEffect(() => {
    const close = (event: KeyboardEvent | PointerEvent): void => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (document.querySelector('.i-over')) return;
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
  const waits = open ? waitsLine(open.lab.waits.length) : null;
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
        <a href={href({ page: 'norms' })} aria-current={current(route.page === 'norms')}>
          Norms
        </a>
        <a href={href({ page: 'settings' })} aria-current={current(route.page === 'settings')}>
          Settings
        </a>
      </nav>
      {open ? (
        <>
          <span className="grow" />
          {waits ? (
            <a
              className="o-count"
              href={href({ page: 'lab' })}
              onClick={(event) => {
                // On the lab page the list is on the screen already, so the press goes to it and keeps the place.
                const list = document.getElementById(WAITS_ID);
                if (!list) return;
                event.preventDefault();
                list.scrollIntoView({ block: 'center' });
              }}
            >
              {waits}
            </a>
          ) : null}
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
          <ShownProfile
            lab={open.lab}
            threads={open.threads}
            now={open.now}
            api={open.api}
            invitation={invitation}
            onInvitation={setInvitation}
            onChange={open.onChange}
          />
        </>
      ) : null}
    </header>
  );
}

/**
 * The member list, in the order of who needs the person: one group for each status, and the agents that left
 * last. A row shows who the member is, the seats that it holds, its roles, its status in its own words, and what
 * it does now. A press on a row opens the member's profile, where the person's actions are.
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
  const { show } = useContext(Profiles);
  const turns = turnLine(lab.agents);
  const title = (view: AgentView): string | null =>
    props.threads.find((summary) => summary.thread.id === view.thread)?.thread.title ?? null;
  return (
    <details className="f-pop f-members" name="top">
      <summary className={`f-live${turns.live ? '' : ' still'}`}>
        <span className={`dot ${turns.live ? 'live' : 'still'}`} /> {turns.text}
        <u>
          <span className="closed">Who</span>
          <span className="opened">Hide</span>
        </u>
      </summary>
      <div className="f-panel">
        <ul className="i-list">
          {needGroups(lab.agents).map((group) => [
            <li key={group.need} className={`o-group o-${group.need}`}>
              {group.heading}
            </li>,
            ...group.rows.map((view) => (
              <li
                key={view.agent.id}
                className="i-row"
                onClick={() => {
                  show(view.agent.id);
                }}
              >
                <Who agents={lab.agents} id={view.agent.id} size={34} />
                <div>
                  <p>
                    <Name view={view} />
                  </p>
                  <MarksAndRoles view={view} />
                  {view.status && !view.left ? <p className="f-status">{view.status}</p> : null}
                  <p className="f-where">{whereLine(view, lab, props.now, title(view))}</p>
                  {view.stopped && !view.left ? (
                    // A press on the button starts the agent, and does not open the profile.
                    <div
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                    >
                      <StartAgain api={props.api} agent={view.agent.id} onChange={props.onChange} />
                    </div>
                  ) : null}
                </div>
              </li>
            )),
          ])}
        </ul>
        <div className="f-seats">
          {lab.agents.some((view) => view.coordinator) ? null : (
            <CoordinatorSeat
              api={props.api}
              open={lab.coordinator_open}
              onChange={props.onChange}
            />
          )}
          <ReviewerSeats api={props.api} lab={lab} onChange={props.onChange} />
        </div>
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

/** Milliseconds between reads of the setup while Verifold asks the harnesses what they offer. */
const OFFER_POLL = 1000;

/**
 * The way to add one agent to the lab that runs, with the same seat form as the setup screen: the model, the
 * effort, and the mode that the harness offers, and the seat's facts. The agent reads the board and chooses its
 * work as the others do.
 */
function AddAgent(props: {
  readonly api: Api;
  readonly harnesses: readonly HarnessOption[];
  readonly onChange: () => void;
}): ReactElement | null {
  const ready = props.harnesses.filter((harness) => harness.available);
  const [seat, setSeat] = useState(() => newSeat(ready[0]?.name ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const option = ready.find((harness) => harness.name === seat.harness);
  const probing = ready.some((harness) => harness.probing);
  const { api, onChange } = props;

  // While Verifold asks a harness what it offers, the list is read again until the answer is there.
  useEffect(() => {
    if (!probing) return undefined;
    const timer = setTimeout(onChange, OFFER_POLL);
    return () => clearTimeout(timer);
  }, [probing, props.harnesses, onChange]);

  if (!option) return null;
  // A lab that Verifold serves again has not asked the harnesses yet. It asks when the person opens the form.
  const ask = (open: boolean): void => {
    if (open && ready.some((harness) => harness.offer === null && !harness.probing)) {
      api.askOffers().then(onChange, () => undefined);
    }
  };
  const add = (): void => {
    setBusy(true);
    setError(null);
    api.addAgents(seatChoice(seat)).then(
      () => {
        setBusy(false);
        setSeat(newSeat(seat.harness));
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
          value={seat.harness}
          onChange={(event) => {
            setSeat(newSeat(event.target.value));
          }}
        >
          {ready.map((harness) => (
            <option key={harness.name} value={harness.name}>
              {harness.title}
            </option>
          ))}
        </select>
      </label>
      <button type="button" onClick={add} disabled={busy || needsModel(seat)}>
        {busy ? 'Adding' : 'Add'}
      </button>
      <details
        className="modelpick inline"
        onToggle={(event) => {
          ask(event.currentTarget.open);
        }}
      >
        <summary>{modelSummary(seat, option.offer, option.family)}</summary>
        <div className="menu">
          <SeatFields option={option} seat={seat} onSeat={setSeat} />
        </div>
      </details>
      {error ? (
        <span className="error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

const NO_FACTS: Facts = { role: '', family: '', onCall: false, coordinator: false };

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
  const [facts, setFacts] = useState<Facts>(NO_FACTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invite = (): void => {
    setBusy(true);
    setError(null);
    const request = {
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(facts.role.trim() ? { role: facts.role.trim() } : {}),
      ...(facts.family.trim() ? { family: facts.family.trim() } : {}),
      ...(facts.onCall ? { on_call: true } : {}),
      ...(facts.coordinator ? { coordinator: true } : {}),
    };
    props.api.invite(request).then(
      (made) => {
        setBusy(false);
        setName('');
        setFacts(NO_FACTS);
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
      <details className="modelpick inline">
        <summary>Its seat</summary>
        <div className="menu">
          <FactFields value={facts} family="unknown" onChange={setFacts} />
          <p>
            Verifold does not know this agent’s model. With a model family, an independent rerun by
            an agent of another family can hold up its results.
          </p>
        </div>
      </details>
      {error ? (
        <span className="error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
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
