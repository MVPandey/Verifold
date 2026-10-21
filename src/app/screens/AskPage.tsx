import { useEffect, useId, useState, type ReactNode } from 'react';
import type {
  AgentTool,
  Harness,
  ProjectAgents,
  StartView,
} from '../../protocol/api.ts';
import {
  agentsLabel,
  dueLabel,
  gpuLabel,
  startedAfterLost,
  teamOrder,
  validFolder,
  validHours,
  withUse,
  type StartActions,
} from '../ask.ts';
import { newKey } from '../intent.ts';
import { href } from '../route.ts';
import type { SetupActions } from '../setup.ts';
import type { Connection } from '../store.ts';
import { useSetup } from '../useSetup.ts';
import { Logo } from '../components/Icons.tsx';
import { StatusBar } from '../components/StatusBar.tsx';

type Editing = 'agents' | 'gpu' | 'hours' | 'folder' | null;

const toolName = (harness: Harness): string =>
  harness === 'claude' ? 'Claude Code' : 'Codex';

/**
 * The project's agents: a Use box and a model menu for each harness on this
 * computer, in the order of the team, the lead first. A model that the
 * person does not pick stays the harness's own default.
 */
function AgentsEditor({
  tools,
  agents,
  onChange,
}: {
  readonly tools: readonly AgentTool[];
  readonly agents: ProjectAgents | null;
  readonly onChange: (agents: ProjectAgents | null) => void;
}): ReactNode {
  const installed = teamOrder(
    tools.filter((tool) => tool.installed),
    agents,
  );
  if (!installed.length)
    return (
      <p className="setup__note">
        Verifold found no agent tool on this computer.{' '}
        <a href={href.setup('agents')}>Check your agents</a>.
      </p>
    );
  const modelOf = (harness: Harness): string =>
    (agents?.host === harness
      ? agents.model
      : agents?.helper === harness
        ? agents.helperModel
        : undefined) ?? '';
  return (
    <div className="ask__agents">
      {installed.map((tool) => {
        const used =
          agents?.host === tool.harness || agents?.helper === tool.harness;
        return (
          <div key={tool.harness} className="ask__agent">
            <label className="agent__use">
              <input
                type="checkbox"
                checked={used}
                onChange={(event) =>
                  onChange(withUse(agents, tool.harness, event.target.checked))
                }
              />
              {toolName(tool.harness)}
              {agents?.host === tool.harness && agents.helper && (
                <span className="muted"> · plans the lab</span>
              )}
            </label>
            <select
              className="select"
              aria-label={`Model for ${toolName(tool.harness)}`}
              disabled={!used}
              value={modelOf(tool.harness)}
              onChange={(event) =>
                onChange(
                  withUse(agents, tool.harness, true, event.target.value),
                )
              }
            >
              <option value="">Its own default model</option>
              {tool.models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        );
      })}
      {!agents && (
        <span role="alert" className="setup__error">
          Use at least one agent.
        </span>
      )}
    </div>
  );
}

/**
 * The Ask page: the question of a new project, the project's settings as
 * chips, and the folder. Verifold sends the settings that a new project
 * starts with, and the page shows exactly those; Start sends what the page
 * shows. As on the v9 canvas ("5 Ask").
 */
export function AskPage({
  setup,
  start,
  now,
  connection,
}: {
  readonly setup: SetupActions;
  readonly start: StartActions;
  readonly now: number;
  readonly connection: Connection;
}): ReactNode {
  const profile = useSetup(setup.read);
  const [where, setWhere] = useState<StartView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void start.read(controller.signal).then((loaded) => {
      if (controller.signal.aborted) return;
      if ('value' in loaded) {
        setWhere(loaded.value);
        setProblem(null);
      } else setProblem(loaded.error);
    });
    return () => controller.abort();
  }, [start, reads]);
  if (!where)
    return (
      <AskFrame>
        {problem ? (
          <div className="setup__problem">
            <span role="alert">{problem}</span>
            <button
              type="button"
              className="button button--small"
              onClick={() => setReads(reads + 1)}
            >
              Try again
            </button>
          </div>
        ) : (
          <StatusBar tone="plan">Reading your profile.</StatusBar>
        )}
      </AskFrame>
    );
  return (
    <AskForm
      where={where}
      tools={profile.view?.agents.tools ?? null}
      profileError={profile.error}
      onRetry={profile.refresh}
      start={start}
      now={now}
      connection={connection}
    />
  );
}

function AskFrame({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="page">
      <header className="header">
        <Logo />
        <span className="header__brand">verifold</span>
        <div className="header__spacer" />
        <a className="header__link" href={href.setup('agents')}>
          Profile
        </a>
      </header>
      <main className="ask">
        <div className="ask__column">{children}</div>
      </main>
    </div>
  );
}

/** The Ask page once Verifold sent the project's defaults. Tests render it directly. */
export function AskForm({
  where,
  tools,
  profileError,
  onRetry,
  start,
  now,
  connection,
}: {
  readonly where: StartView;
  /** The harnesses on this computer, from the profile's read. Null: not read yet, or not readable. */
  readonly tools: readonly AgentTool[] | null;
  readonly profileError: string | null;
  readonly onRetry: () => void;
  readonly start: StartActions;
  readonly now: number;
  readonly connection: Connection;
}): ReactNode {
  const questionId = useId();
  const editorId = useId();
  const [question, setQuestion] = useState('');
  // The server's defaults, which the chips show and Start sends unless the person changes them.
  const [agents, setAgents] = useState<ProjectAgents | null>(where.agents);
  const [gpu, setGpu] = useState<number | null>(where.gpuUsd);
  const [hours, setHours] = useState(where.hours);
  const [hoursText, setHoursText] = useState(String(where.hours));
  const [folder, setFolder] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'ask' | 'starting' | 'lost'>('ask');
  const toggle = (what: Exclude<Editing, null>): void =>
    setEditing(editing === what ? null : what);
  const chip = (what: Exclude<Editing, null>, label: string): ReactNode => (
    <button
      type="button"
      className="ask__chip"
      aria-expanded={editing === what}
      aria-controls={editorId}
      onClick={() => toggle(what)}
    >
      {label}
    </button>
  );
  /** The hours that the box holds, kept when they are whole hours in range. */
  const checkHours = (): number | null => {
    const value = validHours(hoursText, where.maxHours);
    if (value === null) return null;
    setHours(value);
    setHoursText(String(value));
    return value;
  };
  const submit = async (): Promise<void> => {
    const text = question.trim();
    if (!text || busy || phase === 'starting') return;
    if (!agents) {
      setEditing('agents');
      return;
    }
    const budget = checkHours();
    if (budget === null) {
      setEditing('hours');
      setError(`Give the time in whole hours, from 1 to ${where.maxHours}.`);
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await start.start(
      {
        question: text,
        ...(folder ? { folder } : {}),
        agents,
        gpuUsd: gpu,
        hours: budget,
      },
      newKey(),
    );
    if ('refused' in outcome) {
      setBusy(false);
      setError(outcome.refused);
      return;
    }
    if ('ok' in outcome) {
      setBusy(false);
      setPhase('starting');
      return;
    }
    // A lost answer: ask this Verifold whether the project started.
    const loaded = await start.read();
    setBusy(false);
    setPhase(startedAfterLost(loaded) ? 'starting' : 'lost');
  };
  if (phase === 'starting')
    return (
      <AskFrame>
        <StatusBar tone="plan">
          The project starts. Its lab opens here in a moment.
        </StatusBar>
        <p className="ask__note">
          {connection === 'unreachable'
            ? 'Verifold does not answer. Check the terminal where it runs.'
            : 'Verifold now hands the project to a process that keeps working when you close the terminal. This page reconnects by itself.'}
        </p>
      </AskFrame>
    );
  const shownFolder = folder ?? where.folder;
  return (
    <AskFrame>
      <form
        className="ask__form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={questionId} className="ask__label">
          What do you want to find out?
        </label>
        <textarea
          id={questionId}
          className="ask__question"
          rows={3}
          maxLength={where.questionLimit}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey))
              void submit();
          }}
        />
        <div
          role="group"
          aria-label="This project's settings"
          className="ask__chips"
        >
          {chip('agents', agents ? agentsLabel(agents) : 'Choose an agent')}
          {chip('gpu', gpuLabel(gpu))}
          {chip('hours', dueLabel(hours, now))}
        </div>
        <span className="ask__hint">
          These come from your profile. Click one to change it for this project
          only.
        </span>
        {profileError && (
          <div className="setup__problem">
            <span role="alert">
              Verifold could not read your profile: {profileError} This project
              starts with the settings above.
            </span>
            <button
              type="button"
              className="button button--small"
              onClick={onRetry}
            >
              Try again
            </button>
          </div>
        )}
        {editing && (
          <div id={editorId} className="ask__editor">
            {editing === 'agents' &&
              (tools ? (
                <AgentsEditor
                  tools={tools}
                  agents={agents}
                  onChange={setAgents}
                />
              ) : (
                <p className="setup__note">
                  {profileError
                    ? 'Verifold could not read the agents on this computer, so the project uses the agents above.'
                    : 'Reading the agents on this computer.'}
                </p>
              ))}
            {editing === 'gpu' &&
              (where.gpuLimits ? (
                <div className="ask__gpu">
                  <label className="agent__use">
                    <input
                      type="checkbox"
                      checked={gpu === null}
                      onChange={(event) =>
                        setGpu(
                          event.target.checked ? null : (where.gpuUsd ?? 25),
                        )
                      }
                    />
                    No GPUs
                  </label>
                  <label className="limit">
                    <span className="limit__label">
                      This project spends at most
                    </span>
                    <span className="limit__value">
                      $
                      <input
                        type="number"
                        min={1}
                        className="limit__input"
                        disabled={gpu === null}
                        value={gpu ?? ''}
                        onChange={(event) =>
                          setGpu(
                            event.target.value === ''
                              ? null
                              : Number(event.target.value),
                          )
                        }
                      />
                    </span>
                  </label>
                </div>
              ) : (
                <p className="setup__note">
                  Your profile has no GPU limits yet, so this project starts
                  without GPUs. <a href={href.setup('money')}>Set GPU limits</a>
                </p>
              ))}
            {editing === 'hours' && (
              <label className="limit">
                <span className="limit__label">
                  Hours of work before the lab pauses and asks you for more
                </span>
                <input
                  type="number"
                  min={1}
                  max={where.maxHours}
                  className="limit__input"
                  value={hoursText}
                  onChange={(event) => setHoursText(event.target.value)}
                  onBlur={() => {
                    if (checkHours() === null)
                      setError(
                        `Give the time in whole hours, from 1 to ${where.maxHours}.`,
                      );
                    else setError(null);
                  }}
                />
              </label>
            )}
            {editing === 'folder' && (
              <div className="ask__folder-edit">
                <label className="ask__folder-label">
                  <span>The project's folder</span>
                  <input
                    className="ask__path"
                    placeholder="/full/path, or ~/folder"
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="button button--outline button--small"
                  disabled={!validFolder(typed)}
                  onClick={() => {
                    setFolder(typed.trim());
                    setEditing(null);
                  }}
                >
                  Use this folder
                </button>
                {folder && (
                  <button
                    type="button"
                    className="link-button link-button--quiet"
                    onClick={() => {
                      setFolder(null);
                      setTyped('');
                      setEditing(null);
                    }}
                  >
                    Use {where.folder}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <div className="ask__start">
          <span className="ask__where">
            In {shownFolder}
            {folder === null && where.files
              ? '. The agents may read the files in it.'
              : ''}{' '}
            ·{' '}
            <button
              type="button"
              className="link-button"
              aria-expanded={editing === 'folder'}
              aria-controls={editorId}
              onClick={() => toggle('folder')}
            >
              Change
            </button>
          </span>
          <div className="header__spacer" />
          <button
            type="submit"
            className="button button--primary button--big"
            disabled={busy || !question.trim()}
          >
            {phase === 'lost' ? 'Start again' : 'Start'}
          </button>
        </div>
        {phase === 'lost' && (
          <p role="alert" className="setup__error">
            Verifold did not answer, and the project did not start. Start again.
          </p>
        )}
        {error && (
          <p role="alert" className="setup__error">
            {error}
          </p>
        )}
        <p className="ask__note">
          The planner first checks current facts, such as the newest models and
          today's GPU prices, and may ask you up to three questions. No GPU is
          rented until you say yes.
        </p>
      </form>
    </AskFrame>
  );
}
