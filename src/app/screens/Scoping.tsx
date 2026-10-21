import { useState, type ReactNode } from 'react';
import type { Agent, Call, Direction, Lab } from '../../protocol/api.ts';
import { harnessName, modelName } from '../format.ts';
import { newKey } from '../intent.ts';
import { Avatar } from '../components/Avatar.tsx';
import { Composer } from '../components/Composer.tsx';
import { FactsList, uniqueFacts } from '../components/FactsList.tsx';
import { QuestionCard, type Choice } from '../components/QuestionCard.tsx';
import { StatusBar } from '../components/StatusBar.tsx';
import { TurnItem, type AgentActions } from './DirectionPage.tsx';
import type { LabActions } from './LabHome.tsx';

/**
 * The planner's questions before the plan: its open scope calls, oldest
 * first. The lab wakes the planner only after the last one is answered.
 */
export function planQuestions(lab: Lab): Call[] {
  if (lab.plan || !lab.planner) return [];
  const planner = lab.planner;
  return lab.needsYou.filter(
    (call) =>
      call.state === 'open' &&
      call.kind === 'scope' &&
      call.askers.some((asker) => asker.agent === planner),
  );
}

/** The answer that a card sends: the person's own words, else the option. */
export function answerOf(choice: Choice): {
  readonly words: string | null;
  readonly option: number;
} {
  const words = choice.words.trim();
  return { words: words || null, option: choice.option };
}

/**
 * The lab before its plan, as on the v9 canvas ("6 Scoping"): the question,
 * the planner's work folded, its message, the facts that it checked, and
 * its questions, each with options and a box for the person's own words.
 * One button sends every answer. Skip gives each question the planner's
 * pick.
 */
export function Scoping({
  lab,
  planner,
  direction,
  now,
  actions,
  agentActions,
}: {
  readonly lab: Lab;
  readonly planner: Agent;
  readonly direction: Direction;
  readonly now: number;
  readonly actions: LabActions;
  readonly agentActions: AgentActions;
}): ReactNode {
  const questions = planQuestions(lab);
  const [choices, setChoices] = useState<Readonly<Record<string, Choice>>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const choiceOf = (call: Call): Choice =>
    choices[call.id] ?? { option: call.pick ?? 0, words: '' };
  const facts = uniqueFacts(questions.flatMap((call) => call.facts ?? []));
  const working = planner.live.state === 'working';
  const send = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    // One action for every answer, so the planner wakes once, with all of them.
    const outcome = await actions.questions(
      questions.map((call) => {
        const answer = answerOf(choiceOf(call));
        return answer.words
          ? { call: call.id, words: answer.words }
          : { call: call.id, option: answer.option };
      }),
      newKey(),
    );
    setBusy(false);
    setProblem(
      'refused' in outcome
        ? outcome.refused
        : 'lost' in outcome
          ? outcome.lost
          : null,
    );
  };
  const skip = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const outcome = await actions.skip(newKey());
    setBusy(false);
    setProblem(
      'refused' in outcome
        ? outcome.refused
        : 'lost' in outcome
          ? outcome.lost
          : null,
    );
  };
  const turns = planner.turns.turns;
  return (
    <>
      <StatusBar tone="plan">
        {working || !questions.length
          ? 'Planning. The planner keeps reading while you answer.'
          : 'The planner waits for your answers.'}
      </StatusBar>
      <article className="post">
        <Avatar who="person" size="lg" />
        <div className="post__body">
          <div className="post__head">
            <b>You</b>
          </div>
          <div className="post__text">
            <span>{lab.question}</span>
          </div>
        </div>
      </article>
      <section className="scoping" aria-label="The planner">
        <div className="scoping__head">
          <b>Planner</b>
          <span className="muted">
            {planner.handle} · {harnessName(planner.harness)}
            {planner.model && ` ${modelName(planner.model)}`}
          </span>
        </div>
        {turns.length === 0 && (
          <p className="muted">The planner starts in a moment.</p>
        )}
        {turns.map((turn) => (
          <TurnItem
            key={turn.id}
            turn={turn}
            agent={planner}
            direction={direction}
            lab={lab}
            now={now}
            target={null}
            agentActions={agentActions}
          />
        ))}
        <div className="scoping__body">
          {facts.length > 0 && (
            <section className="scoping__facts" aria-label="Facts I checked">
              <h2 className="scoping__label">Facts I checked</h2>
              <FactsList facts={facts} />
            </section>
          )}
          {questions.map((call, index) => (
            <QuestionCard
              key={call.id}
              number={index + 1}
              call={call}
              choice={choiceOf(call)}
              error={null}
              onChange={(choice) =>
                setChoices((current) => ({ ...current, [call.id]: choice }))
              }
            />
          ))}
          {questions.length > 0 && (
            <div className="scoping__send">
              <button
                type="button"
                className="button button--primary button--big"
                disabled={busy}
                onClick={() => void send()}
              >
                Send answers
              </button>
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() => void skip()}
              >
                Skip the questions. Start with the planner's picks.
              </button>
            </div>
          )}
          {problem && (
            <span role="alert" className="setup__error">
              {problem}
            </span>
          )}
        </div>
      </section>
    </>
  );
}

/** The box under the planner's work: a message to the planner, which wakes it also while it waits for answers. */
export function PlannerComposer({
  lab,
  planner,
  direction,
  agentActions,
}: {
  readonly lab: Lab;
  readonly planner: Agent;
  readonly direction: Direction;
  readonly agentActions: AgentActions;
}): ReactNode {
  return (
    <Composer
      label="Write to the planner"
      placeholder="Answer, or add anything"
      maxLength={lab.postLimit}
      hint={`${planner.handle} reads your message during its turn, or at the start of its next one.`}
      onSend={(text, key) => agentActions.message(direction.id, text, key)}
    />
  );
}
