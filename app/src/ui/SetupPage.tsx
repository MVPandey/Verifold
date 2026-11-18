import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { Api } from '../api/client.ts';
import type { HarnessOption, SettingsLevel, SetupView } from '../api/types.ts';
import { duration } from '../model/format.ts';
import {
  MAX_AGENTS,
  addSeat,
  agentCount,
  allOnCall,
  firstSeats,
  initials,
  modelSummary,
  needsModel,
  removeSeat,
  setupChoices,
  startRequest,
  step,
  withSeat,
} from '../model/setup.ts';
import type { Seat } from '../model/setup.ts';
import { messageOf } from '../api/client.ts';
import { BudgetFields, budgetOf, budgetText } from './Limits.tsx';
import { SeatFields } from './SeatForm.tsx';

interface TimeChoice {
  readonly minutes: number | null;
  readonly label: string;
}

const TIMES: readonly TimeChoice[] = [
  { minutes: null, label: 'No limit' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 120, label: '2 hours' },
  { minutes: 240, label: '4 hours' },
];

/** Milliseconds between reads of the setup while Verifold asks the harnesses what they offer. */
const PROBE_POLL = 1000;

/** The setup screen: the question, the seats of each harness, auto mode, and the time limit. */
export function SetupPage(props: {
  readonly api: Api;
  readonly setup: SetupView;
  readonly onStarted: () => void;
  /** Read the setup again. */
  readonly onRefresh: () => void;
}): ReactElement {
  const { defaults } = props.setup;
  const [question, setQuestion] = useState('');
  const [deliverables, setDeliverables] = useState('');
  const [picks, setPicks] = useState(() => firstSeats(props.setup.harnesses, defaults));
  const [autoMode, setAutoMode] = useState(defaults.auto_mode);
  const [minutes, setMinutes] = useState<number | null>(defaults.minutes);
  const [budget, setBudget] = useState(() =>
    budgetText({ tokens: defaults.budget_tokens, dollars: defaults.budget_dollars }),
  );
  const chosenBudget = budgetOf(budget);
  const [starting, setStarting] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const total = agentCount(picks);
  // A saved time limit that isn't one of the usual ones gets a button of its own.
  const [times] = useState<readonly TimeChoice[]>(() =>
    TIMES.some((time) => time.minutes === defaults.minutes)
      ? TIMES
      : [...TIMES, { minutes: defaults.minutes, label: duration(defaults.minutes ?? 0) }],
  );
  const probing = props.setup.harnesses.some((option) => option.probing);
  const { onRefresh } = props;

  useEffect(() => {
    if (!probing) return undefined;
    const timer = setTimeout(onRefresh, PROBE_POLL);
    return () => clearTimeout(timer);
  }, [probing, props.setup, onRefresh]);

  const save = (level: SettingsLevel): void => {
    setSaved(null);
    setError(null);
    const value = setupChoices(picks, autoMode, minutes, chosenBudget ?? undefined);
    props.api
      .settings()
      .then((view) =>
        props.api.changeSetting({
          level,
          key: 'setup',
          value,
          revisions: { project: view.project.revision, all_projects: view.all_projects.revision },
        }),
      )
      .then(
        () => {
          setSaved(
            level === 'project'
              ? 'Saved. New labs in this project start with these choices.'
              : 'Saved. New labs in each project start with these choices, unless the project has its own.',
          );
          // The app reads the setup again, so the next visit to this screen starts with the saved choices.
          props.onRefresh();
        },
        (failure: unknown) => setError(messageOf(failure)),
      );
  };

  const start = (): void => {
    setStarting(true);
    setError(null);
    props.api
      .start(
        startRequest(question, picks, autoMode, minutes, deliverables, chosenBudget ?? undefined),
      )
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
        {props.setup.defaults_from ? (
          <>
            {' '}
            Its first choices come from <code>{props.setup.defaults_from}</code>.
          </>
        ) : null}
      </p>

      <section className="section">
        <h2 id="setup-deliverables">What do you want to hold at the end?</h2>
        <p className="sub">
          Optional. One sentence on each line, such as “A one-page answer” or “A script that runs
          the result again”. The agents read the list, and an agent can offer files for each one.
          You accept an offer or ask for changes, and you can change the list while the lab runs.
        </p>
        <textarea
          className="d-setup"
          aria-labelledby="setup-deliverables"
          rows={3}
          value={deliverables}
          onChange={(event) => setDeliverables(event.target.value)}
        />
      </section>

      <section className="section">
        <h2>Agents</h2>
        <p className="sub">
          Each agent uses your own sign-in and settings for its harness. A seat is one model of a
          harness, with a role if you give it one.
        </p>
        <div className="rows harnesses">
          {props.setup.harnesses.map((option) => (
            <HarnessSeats
              key={option.name}
              option={option}
              seats={picks.flatMap((seat, index) =>
                seat.harness === option.name ? [[seat, index] as const] : [],
              )}
              full={total >= MAX_AGENTS}
              onStep={(index, change) => setPicks((old) => step(old, index, change))}
              onSeat={(index, changed) => setPicks((old) => withSeat(old, index, changed))}
              onAdd={() => setPicks((old) => addSeat(old, option.name))}
              onRemove={(index) => setPicks((old) => removeSeat(old, index))}
            />
          ))}
        </div>
      </section>

      <section className="section">
        <h3>Can your agents run in auto mode?</h3>
        <p className="sub">
          In auto mode each harness decides its own requests, with its own protections. If not, the
          requests that a harness sends come to you.
        </p>
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
          {times.map((time) => (
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

      <section className="section">
        <h3>How much may the agents spend?</h3>
        <p className="sub">
          Optional. At a budget the agents stop, as at the time limit, until you raise it. You can
          change it while the lab runs.
        </p>
        <BudgetFields value={budget} onChange={setBudget} />
      </section>

      <div className="startbar">
        <button
          className="btn primary"
          type="button"
          disabled={
            starting ||
            total === 0 ||
            !question.trim() ||
            picks.some(needsModel) ||
            chosenBudget === null
          }
          onClick={start}
        >
          {starting ? 'Starting' : `Start lab with ${total} ${total === 1 ? 'agent' : 'agents'}`}
        </button>
        <span className="quiet">You can stop the lab at any time.</span>
      </div>
      {picks.some(needsModel) ? (
        <p className="quiet">A seat with “Other…” needs a model ID before the lab starts.</p>
      ) : null}
      {allOnCall(picks) ? (
        <p className="quiet">
          Every seat is on call, so no agent starts until a post names one. Your first post in the
          lab can do that.
        </p>
      ) : null}
      <p className="savechoices">
        <span className="quiet">Save these choices for the next labs:</span>
        <button
          className="linkbtn"
          type="button"
          disabled={total === 0}
          onClick={() => save('project')}
        >
          In this project
        </button>
        <button
          className="linkbtn"
          type="button"
          disabled={total === 0}
          onClick={() => save('all')}
        >
          In all projects
        </button>
      </p>
      {saved ? (
        <p className="quiet" role="status">
          {saved}
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

/** One harness on the setup screen: its seats, and the way to add another seat with another model. */
function HarnessSeats(props: {
  readonly option: HarnessOption;
  /** The harness's seats, each with its place among all the seats. */
  readonly seats: readonly (readonly [Seat, number])[];
  /** The lab has as many agents as it can start. */
  readonly full: boolean;
  readonly onStep: (index: number, change: number) => void;
  readonly onSeat: (index: number, seat: Seat) => void;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
}): ReactElement {
  const { option } = props;
  return (
    <>
      {props.seats.map(([seat, index], place) => (
        <div className={place === 0 ? 'hrow' : 'hrow more'} key={index}>
          {place === 0 ? (
            <span className="f-face plain" aria-hidden="true">
              {initials(option.title)}
            </span>
          ) : (
            <span />
          )}
          <div>
            {place === 0 ? (
              <span className="hn">{option.title}</span>
            ) : (
              <span className="quiet">Seat {place + 1}</span>
            )}
            {option.available ? null : <span className="missing">Not found on this computer</span>}
            {props.seats.length > 1 ? (
              <button
                className="linkbtn missing"
                type="button"
                onClick={() => props.onRemove(index)}
              >
                Remove seat
              </button>
            ) : null}
          </div>
          <div className="stepper">
            <button
              type="button"
              aria-label={`One fewer ${option.title} agent`}
              disabled={seat.count === 0}
              onClick={() => props.onStep(index, -1)}
            >
              −
            </button>
            <output aria-live="polite" aria-label={`${option.title} agents`}>
              {seat.count}
            </output>
            <button
              type="button"
              aria-label={`One more ${option.title} agent`}
              disabled={!option.available || props.full || (seat.coordinator && seat.count > 0)}
              onClick={() => props.onStep(index, 1)}
            >
              +
            </button>
          </div>
          {option.available ? (
            <details className="modelpick">
              <summary>{modelSummary(seat, option.offer, option.family)}</summary>
              <div className="menu">
                <SeatFields
                  option={option}
                  seat={seat}
                  onSeat={(changed) => props.onSeat(index, changed)}
                />
              </div>
            </details>
          ) : null}
          {option.available && place === props.seats.length - 1 ? (
            <button className="linkbtn addseat" type="button" onClick={props.onAdd}>
              Add a seat with another model
            </button>
          ) : null}
        </div>
      ))}
    </>
  );
}
