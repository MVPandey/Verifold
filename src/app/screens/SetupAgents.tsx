import { useState, type ReactNode } from 'react';
import type { AgentTool, Harness, SetupView } from '../../protocol/api.ts';
import { Avatar } from '../components/Avatar.tsx';
import { StatusBar } from '../components/StatusBar.tsx';
import { StepHeader, useUnsaved } from '../components/StepHeader.tsx';
import { planName, type SetupActions, type StepNav } from '../setup.ts';
import { useAction } from '../useAction.ts';

const toolNames: Readonly<Record<Harness, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

const installPages: Readonly<Record<Harness, string>> = {
  claude: 'https://code.claude.com/docs/en/quickstart',
  codex: 'https://github.com/openai/codex',
};

const signIn: Readonly<Record<Harness, ReactNode>> = {
  claude: (
    <>
      To sign in, run <code>claude</code> in a terminal, then type{' '}
      <code>/login</code>.
    </>
  ),
  codex: (
    <>
      To sign in, run <code>codex login</code> in a terminal.
    </>
  ),
};

interface Choice {
  readonly use: boolean;
  /** Empty: the harness's own default. */
  readonly model: string;
}

type Choices = Readonly<Partial<Record<Harness, Choice>>>;

/** "Signed in · Max plan", "Signed out", or nothing for a harness that is not installed. */
function SignInPill({ tool }: { readonly tool: AgentTool }): ReactNode {
  if (!tool.installed) return null;
  if (tool.signedIn === true)
    return (
      <span className="pill pill--ok">
        Signed in{tool.plan ? ` · ${planName(tool.plan)}` : ''}
      </span>
    );
  return tool.signedIn === false ? (
    <span className="pill pill--need">Signed out</span>
  ) : (
    <span className="pill">Sign-in not known</span>
  );
}

function AgentRow({
  tool,
  choice,
  onChange,
}: {
  readonly tool: AgentTool;
  readonly choice: Choice;
  readonly onChange: (choice: Choice) => void;
}): ReactNode {
  const name = toolNames[tool.harness];
  const fable = tool.plan && tool.models.some((model) => model.id === 'fable');
  return (
    <div className="agent">
      <Avatar who={{ harness: tool.harness, handle: name }} size="xl" />
      <div className="agent__body">
        <div className="agent__head">
          <b className="agent__name">{name}</b>
          {tool.version && <span className="muted">{tool.version}</span>}
          <SignInPill tool={tool} />
        </div>
        {tool.installed ? (
          <label className="agent__model">
            <span className="muted">Model</span>
            <select
              className="select"
              value={choice.model}
              onChange={(event) =>
                onChange({ ...choice, model: event.target.value })
              }
            >
              {tool.models.length ? (
                tool.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))
              ) : (
                <option value="">{name}'s own default</option>
              )}
            </select>
          </label>
        ) : (
          <span className="agent__note">
            Verifold did not find {name} on this computer.{' '}
            <a
              href={installPages[tool.harness]}
              target="_blank"
              rel="noreferrer"
            >
              How to install {name}
            </a>
          </span>
        )}
        {tool.installed && tool.signedIn === false && (
          <span className="agent__note">{signIn[tool.harness]}</span>
        )}
        {tool.harness === 'claude' && fable && tool.plan && (
          <span className="agent__note">
            Fable is the most capable model. Your {planName(tool.plan)} includes
            it, so you can pick it here.
          </span>
        )}
        {tool.harness === 'codex' && tool.installed && (
          <span className="agent__note">
            Your Codex settings keep their reasoning effort.
          </span>
        )}
      </div>
      <label className="agent__use">
        <input
          type="checkbox"
          checked={choice.use}
          disabled={!tool.installed}
          onChange={(event) =>
            onChange({ ...choice, use: event.target.checked })
          }
        />
        Use
      </label>
    </div>
  );
}

/** Step 1, as in the artboard "1 Agents": each harness with its sign-in, its model, and whether to use it. */
export function AgentsStep({
  view,
  actions,
  refresh,
  onSaved,
  onSkip,
  nav,
}: {
  readonly view: SetupView;
  readonly actions: SetupActions;
  readonly refresh: () => void;
  readonly onSaved: () => void;
  readonly onSkip: () => void;
  readonly nav: StepNav;
}): ReactNode {
  const { tools, checking } = view.agents;
  const [choices, setChoices] = useState<Choices>(() =>
    Object.fromEntries(
      tools.map((tool) => [
        tool.harness,
        { use: tool.use, model: tool.model ?? '' },
      ]),
    ),
  );
  const save = useAction((value: Choices, key) => {
    const pick = (harness: Harness): { use: boolean; model?: string } => {
      const choice = value[harness];
      return {
        use: choice?.use ?? false,
        ...(choice?.model ? { model: choice.model } : {}),
      };
    };
    return actions.agents(
      { claude: pick('claude'), codex: pick('codex') },
      key,
    );
  });
  const check = useAction((_: null, key) => actions.check(key));
  const skip = useAction((_: null, key) => actions.skip('all', key));
  const used = tools.some((tool) => choices[tool.harness]?.use);
  // Changed choices, while no save of them runs.
  useUnsaved(
    !save.busy &&
      tools.some((tool) => {
        const choice = choices[tool.harness];
        return (
          choice !== undefined &&
          (choice.use !== tool.use || choice.model !== (tool.model ?? ''))
        );
      }),
    nav,
  );
  const unsure = tools.some(
    (tool) => !tool.installed || tool.signedIn !== true,
  );
  return (
    <>
      <StepHeader
        step="agents"
        states={view.steps}
        nav={nav}
        title="Your agents"
      >
        Verifold runs research with the agent tools you already use.
        {tools.length ? ' It found these on this computer.' : ''}
      </StepHeader>
      {checking && !tools.length ? (
        <StatusBar tone="plan">
          Looking for Claude Code and Codex on this computer.
        </StatusBar>
      ) : (
        <section aria-label="Agent tools" className="agents">
          {tools.map((tool) => (
            <AgentRow
              key={tool.harness}
              tool={tool}
              choice={choices[tool.harness] ?? { use: false, model: '' }}
              onChange={(choice) =>
                setChoices((current) => ({
                  ...current,
                  [tool.harness]: choice,
                }))
              }
            />
          ))}
        </section>
      )}
      {unsure && !checking && (
        <p className="setup__line">
          Signed in or installed just now?{' '}
          <button
            type="button"
            className="link-button"
            disabled={check.busy}
            onClick={() =>
              void check.submit(null).then((ok) => ok && refresh())
            }
          >
            Check again
          </button>
        </p>
      )}
      <p className="setup__note">
        Your logins stay in Claude Code and Codex. Verifold never sees them. A
        project can still pick another model.
      </p>
      {(save.error ?? check.error ?? skip.error) && (
        <span role="alert" className="setup__error">
          {save.error ?? check.error ?? skip.error}
        </span>
      )}
      <div className="setup__actions">
        <button
          type="button"
          className="button button--primary button--big"
          disabled={!used || save.busy || checking}
          onClick={() =>
            void save.submit(choices).then((ok) => ok && onSaved())
          }
        >
          Continue
        </button>
        <button
          type="button"
          className="link-button"
          disabled={skip.busy}
          onClick={() => void skip.submit(null).then((ok) => ok && onSkip())}
        >
          Skip setup. Ask me later.
        </button>
      </div>
    </>
  );
}
