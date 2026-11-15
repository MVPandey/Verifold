import { useId, useState } from 'react';
import type { ReactElement } from 'react';

import type { Api } from '../api/client.ts';
import { messageOf } from '../api/client.ts';
import type { AgentView, HarnessOption, Offer, Power, SeatChange } from '../api/types.ts';
import { OTHER_MODEL, effortsOf, menuEntries, modeEntries, withModel } from '../model/setup.ts';
import type { MenuEntry, Seat } from '../model/setup.ts';
import { PowerChoices } from './PowerChoices.tsx';

/** The facts that the person can state about a seat. */
export interface Facts {
  readonly role: string;
  readonly family: string;
  readonly onCall: boolean;
  readonly coordinator: boolean;
  /** The powers that the person switches on for the coordinator from the start. */
  readonly powers?: readonly Power[];
}

/**
 * The fields of one seat: the model, the effort, and the mode that its harness offers, and then the seat's facts.
 * The setup screen and the form that adds an agent to a lab that runs both show it.
 */
export function SeatFields(props: {
  readonly option: HarnessOption;
  readonly seat: Seat;
  readonly onSeat: (seat: Seat) => void;
}): ReactElement {
  const { option, seat } = props;
  return (
    <>
      {option.probing ? (
        <p>Asking {option.title} what it offers.</p>
      ) : option.offer ? (
        <Offered title={option.title} offer={option.offer} pick={seat} onPick={props.onSeat} />
      ) : (
        <Typed title={option.title} pick={seat} onPick={props.onSeat} />
      )}
      <FactFields value={seat} family={option.family} onChange={props.onSeat} />
    </>
  );
}

/** The fields for a seat's facts: its role, its model family, whether it is on call, and whether it is the coordinator's. */
export function FactFields<T extends Facts>(props: {
  readonly value: T;
  /** The family that the seat has when the person states none. */
  readonly family: string;
  readonly onChange: (value: T) => void;
}): ReactElement {
  const { value } = props;
  const roleId = useId();
  const familyId = useId();
  return (
    <>
      <label htmlFor={roleId}>Role</label>
      <input
        id={roleId}
        maxLength={40}
        placeholder="None. Such as: driver"
        value={value.role}
        onChange={(event) => props.onChange({ ...value, role: event.target.value })}
      />
      <label htmlFor={familyId}>Model family</label>
      <input
        id={familyId}
        maxLength={40}
        placeholder={props.family}
        value={value.family}
        onChange={(event) => props.onChange({ ...value, family: event.target.value })}
      />
      <label className="check">
        <input
          type="checkbox"
          checked={value.onCall}
          onChange={(event) => props.onChange({ ...value, onCall: event.target.checked })}
        />
        On call. Only a post that names it wakes it.
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={value.coordinator}
          onChange={(event) => props.onChange({ ...value, coordinator: event.target.checked })}
        />
        Coordinator. A lab has one.
      </label>
      {value.coordinator ? (
        <PowerChoices
          value={value.powers ?? []}
          onChange={(powers) => props.onChange({ ...value, powers })}
        />
      ) : null}
    </>
  );
}

/** The menus for a harness that told Verifold what it offers. Each menu holds only what the harness reported. */
function Offered(props: {
  readonly title: string;
  readonly offer: Offer;
  readonly pick: Seat;
  readonly onPick: (pick: Seat) => void;
}): ReactElement {
  const { offer, pick } = props;
  const typedId = useId();
  const listed = menuEntries(offer.models, offer.model, pick.typed ? '' : pick.model);
  // The harness can accept a model that it does not list, so the last entry lets the person type one.
  const models = listed.length > 0 ? [...listed, { value: OTHER_MODEL, label: 'Other…' }] : [];
  const levels = effortsOf(offer, pick.model);
  const efforts = menuEntries(levels.values, levels.current, pick.effort);
  const modes = modeEntries(offer, pick.mode);
  return (
    <>
      {models.length + efforts.length + modes.length === 0 ? (
        <p>{props.title} offers no model, effort, or mode choices.</p>
      ) : null}
      <Menu
        label="Model"
        entries={models}
        value={pick.typed ? OTHER_MODEL : pick.model}
        onChange={(model) => props.onPick(withModel(pick, offer, model))}
      />
      {pick.typed ? (
        <>
          <label htmlFor={typedId}>Model ID</label>
          <input
            id={typedId}
            maxLength={200}
            placeholder={`As ${props.title} names it`}
            value={pick.model}
            onChange={(event) => props.onPick({ ...pick, model: event.target.value })}
          />
          {pick.model.trim() ? null : <p>Type the model’s ID, or choose a model from the list.</p>}
        </>
      ) : null}
      <Menu
        label="Effort"
        entries={efforts}
        value={pick.effort}
        onChange={(effort) => props.onPick({ ...pick, effort })}
      />
      <Menu
        label="Mode"
        entries={modes}
        value={pick.mode}
        onChange={(mode) => props.onPick({ ...pick, mode })}
      />
    </>
  );
}

/** One menu of a harness's values, or nothing when the harness offers none. */
function Menu(props: {
  readonly label: string;
  readonly entries: readonly MenuEntry[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactElement | null {
  const id = useId();
  if (props.entries.length === 0) return null;
  return (
    <>
      <label htmlFor={id}>{props.label}</label>
      <select id={id} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        {props.entries.map((entry) => (
          <option key={entry.value} value={entry.value}>
            {entry.label}
          </option>
        ))}
      </select>
    </>
  );
}

/** The fields for a harness that didn't tell Verifold what it offers: the person types the model, effort, and mode. */
function Typed(props: {
  readonly title: string;
  readonly pick: Seat;
  readonly onPick: (pick: Seat) => void;
}): ReactElement {
  const { pick } = props;
  const modelId = useId();
  const effortId = useId();
  const modeId = useId();
  return (
    <>
      <label htmlFor={modelId}>Model</label>
      <input
        id={modelId}
        placeholder="Your default"
        value={pick.model}
        onChange={(event) => props.onPick({ ...pick, model: event.target.value })}
      />
      <label htmlFor={effortId}>Effort</label>
      <input
        id={effortId}
        placeholder="Your default"
        value={pick.effort}
        onChange={(event) => props.onPick({ ...pick, effort: event.target.value })}
      />
      <label htmlFor={modeId}>Mode</label>
      <input
        id={modeId}
        placeholder="Your auto mode answer"
        value={pick.mode}
        onChange={(event) => props.onPick({ ...pick, mode: event.target.value })}
      />
      <p>Leave a field blank to keep your own setting for {props.title}.</p>
    </>
  );
}

/**
 * What the member list says when no agent holds the coordinator seat, and the person's switch for it: agents may
 * take the seat, or the person closed it.
 */
export function CoordinatorSeat(props: {
  readonly api: Api;
  readonly open: boolean;
  readonly onChange: () => void;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (): void => {
    setBusy(true);
    setError(null);
    props.api.setCoordinatorSeat(!props.open).then(
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
      {props.open
        ? 'No coordinator. Agents may take the seat.'
        : 'No coordinator. You closed the seat.'}{' '}
      <button className="linkbtn" type="button" disabled={busy} onClick={change}>
        {props.open ? 'Close the seat' : 'Let agents take it'}
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

/** Return whether a member has neither run a turn nor posted, and runs none now: it never started or never came. */
function notCome(view: AgentView): boolean {
  const resting = ['idle', 'invited', 'void', 'stopped'].includes(view.activity.state);
  return view.turns === 0 && view.posts === 0 && resting;
}

/**
 * What the member list says about a member's seat, and the person's two switches for it: on call, and the
 * coordinator's seat.
 */
export function SeatControls(props: {
  readonly api: Api;
  readonly view: AgentView;
  readonly onChange: () => void;
}): ReactElement {
  const { view } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (seat: SeatChange): void => {
    setBusy(true);
    setError(null);
    props.api.changeSeat(view.agent.id, seat).then(
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
    <>
      {view.on_call ? <p className="f-where">On call. A post that names it wakes it.</p> : null}
      {view.coordinator && notCome(view) ? (
        <p className="f-where">Holds the coordinator seat and has not come yet.</p>
      ) : null}
      <p className="f-where">
        <button
          className="linkbtn"
          type="button"
          disabled={busy}
          onClick={() => change({ on_call: !view.on_call })}
        >
          {view.on_call ? 'Take off call' : 'Put on call'}
        </button>{' '}
        <button
          className="linkbtn"
          type="button"
          disabled={busy}
          onClick={() => change({ coordinator: !view.coordinator })}
        >
          {view.coordinator ? 'Remove as coordinator' : 'Make coordinator'}
        </button>
        {error ? (
          <span className="error" role="alert">
            {' '}
            {error}
          </span>
        ) : null}
      </p>
    </>
  );
}
