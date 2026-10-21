import { useEffect, useId, useState, type ReactNode } from 'react';
import type {
  AgentTool,
  ProjectAgents,
  SetupView,
  StartView,
} from '../../protocol/api.ts';
import {
  agentsLabel,
  dueLabel,
  gpuLabel,
  profileAgents,
  profileGpu,
  validFolder,
  type StartActions,
} from '../ask.ts';
import { newKey } from '../intent.ts';
import { href } from '../route.ts';
import type { SetupActions } from '../setup.ts';
import { useSetup } from '../useSetup.ts';
import { Logo } from '../components/Icons.tsx';
import { StatusBar } from '../components/StatusBar.tsx';

type Editing = 'agents' | 'gpu' | 'hours' | 'folder' | null;

/** The project's agents: a Use box and a model menu for each harness on this computer. */
function AgentsEditor({
  tools,
  agents,
  onChange,
}: {
  readonly tools: readonly AgentTool[];
  readonly agents: ProjectAgents | null;
  readonly onChange: (agents: ProjectAgents | null) => void;
}): ReactNode {
  const installed = tools.filter((tool) => tool.installed);
  const chosen = (harness: AgentTool['harness']): string | undefined =>
    agents?.host === harness
      ? agents.model
      : agents?.helper === harness
        ? agents.helperModel
        : undefined;
  const used = (harness: AgentTool['harness']): boolean =>
    agents?.host === harness || agents?.helper === harness;
  // The lead is the first harness in use, Claude Code before Codex, as in the profile.
  const set = (
    next: readonly { harness: AgentTool['harness']; model?: string }[],
  ): void => {
    const [lead, second] = next;
    onChange(
      lead
        ? {
            host: lead.harness,
            ...(lead.model ? { model: lead.model } : {}),
            ...(second
              ? {
                  helper: second.harness,
                  ...(second.model ? { helperModel: second.model } : {}),
                }
              : {}),
          }
        : null,
    );
  };
  const rows = installed.map((tool) => ({
    harness: tool.harness,
    use: used(tool.harness),
    model: chosen(tool.harness),
  }));
  const change = (
    harness: AgentTool['harness'],
    patch: { use?: boolean; model?: string },
  ): void =>
    set(
      rows
        .map((row) =>
          row.harness === harness
            ? {
                ...row,
                ...(patch.use === undefined ? {} : { use: patch.use }),
                ...(patch.model === undefined ? {} : { model: patch.model }),
              }
            : row,
        )
        .filter((row) => row.use)
        .map((row) => ({
          harness: row.harness,
          ...(row.model ? { model: row.model } : {}),
        })),
    );
  if (!installed.length)
    return (
      <p className="setup__note">
        Verifold found no agent tool on this computer.{' '}
        <a href={href.setup('agents')}>Check your agents</a>.
      </p>
    );
  return (
    <div className="ask__agents">
      {installed.map((tool) => (
        <div key={tool.harness} className="ask__agent">
          <label className="agent__use">
            <input
              type="checkbox"
              checked={used(tool.harness)}
              onChange={(event) =>
                change(tool.harness, { use: event.target.checked })
              }
            />
            {tool.harness === 'claude' ? 'Claude Code' : 'Codex'}
          </label>
          {tool.models.length > 0 && (
            <select
              className="select"
              aria-label={`Model for ${tool.harness === 'claude' ? 'Claude Code' : 'Codex'}`}
              disabled={!used(tool.harness)}
              value={chosen(tool.harness) ?? tool.model ?? ''}
              onChange={(event) =>
                change(tool.harness, { model: event.target.value })
              }
            >
              {tool.model === null && (
                <option value="">The harness's own default</option>
              )}
              {tool.models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </div>
      ))}
      {!agents && (
        <span role="alert" className="setup__error">
          Use at least one agent.
        </span>
      )}
    </div>
  );
}

/**
 * The Ask page: the question of a new project, the project's settings from
 * the profile as chips, and the folder. Start creates the project and starts
 * its lab, and the page then waits for the lab. As on the v9 canvas ("5
 * Ask").
 */
export function AskPage({
  setup,
  start,
  now,
}: {
  readonly setup: SetupActions;
  readonly start: StartActions;
  readonly now: number;
}): ReactNode {
  const { view } = useSetup(setup.read);
  const [where, setWhere] = useState<StartView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void start.read(controller.signal).then((loaded) => {
      if (controller.signal.aborted) return;
      if ('value' in loaded) setWhere(loaded.value);
      else setProblem(loaded.error);
    });
    return () => controller.abort();
  }, [start]);
  if (problem)
    return (
      <AskFrame>
        <p role="alert" className="setup__error">
          {problem}
        </p>
      </AskFrame>
    );
  if (!view || !where)
    return (
      <AskFrame>
        <StatusBar tone="plan">Reading your profile.</StatusBar>
      </AskFrame>
    );
  return <AskForm view={view} where={where} start={start} now={now} />;
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

/** The Ask page once the profile and the folder are read. Tests render it directly. */
export function AskForm({
  view,
  where,
  start,
  now,
}: {
  readonly view: SetupView;
  readonly where: StartView;
  readonly start: StartActions;
  readonly now: number;
}): ReactNode {
  const questionId = useId();
  const editorId = useId();
  const [question, setQuestion] = useState('');
  // Undefined: the profile's choice, which the project then reads from the profile.
  const [agents, setAgents] = useState<ProjectAgents | null | undefined>(
    undefined,
  );
  const [gpu, setGpu] = useState<number | null | undefined>(undefined);
  const [hours, setHours] = useState(where.hours);
  const [folder, setFolder] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const team = agents === undefined ? profileAgents(view.agents.tools) : agents;
  const limit = gpu === undefined ? profileGpu(view) : gpu;
  const moneySet = view.steps.money === 'done';
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
  const submit = async (): Promise<void> => {
    const text = question.trim();
    if (!text || busy || started) return;
    if (agents === null) {
      setEditing('agents');
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await start.start(
      {
        question: text,
        ...(folder ? { folder } : {}),
        ...(agents ? { agents } : {}),
        ...(gpu === undefined ? {} : { gpuUsd: gpu }),
        hours,
      },
      newKey(),
    );
    setBusy(false);
    // A lost answer most likely means that the project started and this desk closed for its owner.
    if ('refused' in outcome) setError(outcome.refused);
    else setStarted(true);
  };
  if (started)
    return (
      <AskFrame>
        <StatusBar tone="plan">
          The project starts. Its lab opens here in a moment.
        </StatusBar>
        <p className="ask__note">
          Verifold now hands the project to a process that keeps working when
          you close the terminal. This page reconnects by itself.
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
          {chip('agents', agentsLabel(team))}
          {chip('gpu', gpuLabel(limit))}
          {chip('hours', dueLabel(hours, now))}
        </div>
        <span className="ask__hint">
          These come from your profile. Click one to change it for this project
          only.
        </span>
        {editing && (
          <div id={editorId} className="ask__editor">
            {editing === 'agents' && (
              <AgentsEditor
                tools={view.agents.tools}
                agents={team}
                onChange={setAgents}
              />
            )}
            {editing === 'gpu' &&
              (moneySet ? (
                <div className="ask__gpu">
                  <label className="agent__use">
                    <input
                      type="checkbox"
                      checked={limit === null}
                      onChange={(event) =>
                        setGpu(
                          event.target.checked
                            ? null
                            : (view.money.limits.limitUsd ?? 25),
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
                        disabled={limit === null}
                        value={limit ?? ''}
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
                  value={hours}
                  onChange={(event) =>
                    setHours(
                      Math.min(
                        where.maxHours,
                        Math.max(1, Math.round(Number(event.target.value))),
                      ) || where.hours,
                    )
                  }
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
            Start
          </button>
        </div>
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
