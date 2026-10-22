import { useState, type ReactNode } from 'react';
import type {
  Agent,
  Call,
  Direction,
  Lab,
  QuestionAnswer,
} from '../../protocol/api.ts';
import { agentModelName, harnessName } from '../format.ts';
import { href } from '../route.ts';
import { useAction } from '../useAction.ts';
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

/** A planner that does not read now: it starts, it waits for a slot, a usage window or its next turn, or the lab is paused. */
const notReading: ReadonlySet<Agent['status']> = new Set([
  'starting',
  'slot',
  'usage',
  'turns',
  'paused',
]);

/** The answer that a card sends: the person's own words, else the option. */
export function answerOf(choice: Choice): {
  readonly words: string | null;
  readonly option: number;
} {
  const words = choice.words.trim();
  return { words: words || null, option: choice.option };
}

/** Two sends of the same answers are one intent, so a retry after a lost answer keeps its key. */
export function sameAnswers(
  a: readonly QuestionAnswer[],
  b: readonly QuestionAnswer[],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
  // One intent each: a retry after a lost answer keeps its key, so it runs once.
  const answer = useAction(
    (answers: readonly QuestionAnswer[], key: string) =>
      actions.questions(answers, key),
    sameAnswers,
  );
  const skipping = useAction((_: 'skip', key: string) => actions.skip(key));
  const [last, setLast] = useState<'answer' | 'skip' | null>(null);
  const busy = answer.busy || skipping.busy;
  // Only the problem of the last action shows, and none while an action runs.
  const problem = busy
    ? null
    : last === 'answer'
      ? answer.error
      : last === 'skip'
        ? skipping.error
        : null;
  const choiceOf = (call: Call): Choice =>
    choices[call.id] ?? { option: call.pick ?? 0, words: '' };
  const facts = uniqueFacts(questions.flatMap((call) => call.facts ?? []));
  const working = planner.live.state === 'working';
  // One action for every answer, so the planner hears them together.
  const send = async (): Promise<void> => {
    if (busy) return;
    setLast('answer');
    await answer.submit(
      questions.map((call) => {
        const chosen = answerOf(choiceOf(call));
        return chosen.words
          ? { call: call.id, words: chosen.words }
          : { call: call.id, option: chosen.option };
      }),
    );
  };
  const skip = async (): Promise<void> => {
    if (busy) return;
    setLast('skip');
    await skipping.submit('skip');
  };
  const turns = planner.turns.turns;
  return (
    <>
      <StatusBar tone="plan">
        {notReading.has(planner.status)
          ? `${planner.live.text}.`
          : working || !questions.length
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
            {planner.model &&
              ` ${agentModelName(planner.model, planner.requestedModel)}`}
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
            turnHref={href.turn(direction.id, turn.id)}
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
              <FactsList facts={facts} now={now} />
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
