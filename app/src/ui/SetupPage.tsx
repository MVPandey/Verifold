import { useEffect, useId, useState } from 'react';
import type { ReactElement } from 'react';

import type { Api } from '../api/client.ts';
import type { HarnessOption, Offer, SetupView } from '../api/types.ts';
import {
  MAX_AGENTS,
  agentCount,
  firstPicks,
  effortsOf,
  initials,
  menuEntries,
  modeEntries,
  modelSummary,
  startRequest,
  step,
  withModel,
} from '../model/setup.ts';
import type { HarnessPick, MenuEntry } from '../model/setup.ts';
import { messageOf } from '../api/client.ts';
import { Avatar } from './parts.tsx';

const TIMES: readonly { readonly minutes: number | null; readonly label: string }[] = [
  { minutes: null, label: 'No limit' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 120, label: '2 hours' },
  { minutes: 240, label: '4 hours' },
];

/** Milliseconds between reads of the setup while Verifold asks the harnesses what they offer. */
const PROBE_POLL = 1000;

/** The setup screen: the question, the agents of each harness, auto mode, and the time limit. */
export function SetupPage(props: {
  readonly api: Api;
  readonly setup: SetupView;
  readonly onStarted: () => void;
  /** Read the setup again. */
  readonly onRefresh: () => void;
}): ReactElement {
  const [question, setQuestion] = useState('');
  const [picks, setPicks] = useState(() => firstPicks(props.setup.harnesses));
  const [autoMode, setAutoMode] = useState(true);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = agentCount(picks);
  const probing = props.setup.harnesses.some((option) => option.probing);
  const { onRefresh } = props;

  useEffect(() => {
    if (!probing) return undefined;
    const timer = setTimeout(onRefresh, PROBE_POLL);
    return () => clearTimeout(timer);
  }, [probing, props.setup, onRefresh]);

  const start = (): void => {
    setStarting(true);
    setError(null);
    props.api
      .start(startRequest(question, picks, autoMode, minutes))
      .then(props.onStarted, (failure: unknown) => {
        setError(messageOf(failure));
        setStarting(false);
      });
  };

  return (
    <div className="narrow setup">
      <h1>What should the lab find out?</h1>
      <div className="qbox">
        <textarea
          aria-label="The lab's question"
          placeholder="Ask a question that experiments can answer"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
      </div>
      <p className="folder">
        The lab works in <code>{props.setup.folder}</code> and keeps its record there.
      </p>

      <section className="section">
        <h2>Agents</h2>
        <p className="sub">Each agent uses your own sign-in and settings for its harness.</p>
        <div className="rows harnesses">
          {props.setup.harnesses.map((option, index) => (
            <HarnessRow
              key={option.name}
              option={option}
              first={index === 0}
              pick={picks.find((pick) => pick.harness === option.name)}
              onStep={(change) => setPicks((old) => step(old, option.name, change))}
              onPick={(changed) =>
                setPicks((old) =>
                  old.map((pick) => (pick.harness === option.name ? changed : pick)),
                )
              }
            />
          ))}
        </div>
      </section>

      <section className="section">
        <h3>Can your agents run in auto mode?</h3>
        <p className="sub">If not, their permission requests come to you.</p>
        <div className="choice">
          <button type="button" aria-pressed={autoMode} onClick={() => setAutoMode(true)}>
            <b>Yes, use auto mode</b>
            <span>Requests that auto mode does not cover still come to you.</span>
          </button>
          <button type="button" aria-pressed={!autoMode} onClick={() => setAutoMode(false)}>
            <b>No, ask me</b>
            <span>Agents keep your usual mode and wait for your answer.</span>
          </button>
        </div>
      </section>

      <section className="section">
        <h3>How long may the agents work?</h3>
        <p className="sub">You can give the lab more time while it runs.</p>
        <div className="filters">
          {TIMES.map((time) => (
            <button
              key={time.label}
              type="button"
              aria-pressed={minutes === time.minutes}
              onClick={() => setMinutes(time.minutes)}
            >
              {time.label}
            </button>
          ))}
        </div>
      </section>

      <div className="startbar">
        <button
          className="btn primary"
          type="button"
          disabled={starting || total === 0 || !question.trim()}
          onClick={start}
        >
          {starting ? 'Starting' : `Start lab with ${total} ${total === 1 ? 'agent' : 'agents'}`}
        </button>
        <span className="quiet">You can stop the lab at any time.</span>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function HarnessRow(props: {
  readonly option: HarnessOption;
  readonly first: boolean;
  readonly pick: HarnessPick | undefined;
  readonly onStep: (change: number) => void;
  readonly onPick: (pick: HarnessPick) => void;
}): ReactElement {
  const { option, pick } = props;
  const count = pick?.count ?? 0;
  return (
    <div className="hrow">
      <Avatar mark={initials(option.title)} tone={props.first ? 'cc' : 'cx'} />
      <div>
        <span className="hn">{option.title}</span>
        {option.available ? null : <span className="missing">Not found on this computer</span>}
      </div>
      <div className="stepper">
        <button
          type="button"
          aria-label={`One fewer ${option.title} agent`}
          disabled={count === 0}
          onClick={() => props.onStep(-1)}
        >
          −
        </button>
        <output aria-live="polite" aria-label={`${option.title} agents`}>
          {count}
        </output>
        <button
          type="button"
          aria-label={`One more ${option.title} agent`}
          disabled={!option.available || count >= MAX_AGENTS}
          onClick={() => props.onStep(1)}
        >
          +
        </button>
      </div>
      {option.available && pick ? (
        <details className="modelpick">
          <summary>{modelSummary(pick, option.offer)}</summary>
          <div className="menu">
            {option.probing ? (
              <p>Asking {option.title} what it offers.</p>
            ) : option.offer ? (
              <Offered
                title={option.title}
                offer={option.offer}
                pick={pick}
                onPick={props.onPick}
              />
            ) : (
              <Typed title={option.title} pick={pick} onPick={props.onPick} />
            )}
          </div>
        </details>
      ) : null}
    </div>
  );
}

/** The menus for a harness that told Verifold what it offers. */
function Offered(props: {
  readonly title: string;
  readonly offer: Offer;
  readonly pick: HarnessPick;
  readonly onPick: (pick: HarnessPick) => void;
}): ReactElement {
  const { offer, pick } = props;
  const models = menuEntries(offer.models, offer.model);
  const levels = effortsOf(offer, pick.model);
  const efforts = menuEntries(levels.values, levels.current);
  const modes = modeEntries(offer);
  if (models.length + efforts.length + modes.length === 0) {
    return <p>{props.title} offers no model, effort, or mode choices.</p>;
  }
  return (
    <>
      <Menu
        label="Model"
        entries={models}
        value={pick.model}
        onChange={(model) => props.onPick(withModel(pick, offer, model))}
      />
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

/** The fields for a harness that didn't tell Verifold what it offers: the person types the model and the effort. */
function Typed(props: {
  readonly title: string;
  readonly pick: HarnessPick;
  readonly onPick: (pick: HarnessPick) => void;
}): ReactElement {
  const { pick } = props;
  const modelId = useId();
  const effortId = useId();
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
      <p>Leave a field blank to keep your own setting for {props.title}.</p>
    </>
  );
}
