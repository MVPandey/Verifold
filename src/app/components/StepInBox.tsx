import {
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Lab, Post, Thread } from '../../protocol/api.ts';
import type { ActOutcome } from '../api.ts';
import { ControlsContext } from '../controls.ts';
import { agentName, authorOf, cut } from '../format.ts';
import { mentionNames } from '../mentions.ts';
import {
  askWords,
  atNames,
  boxAgents,
  boxLevels,
  boxQuery,
  objectWords,
  reachWords,
  type BoxAct,
  type BoxLevel,
} from '../step-in.ts';
import { useRead } from '../useRead.ts';
import { Composer } from './Composer.tsx';

/**
 * The box: who a message goes to, what it says, and who reads it and when.
 * The line under it is the server's answer, from the rule that wakes agents,
 * and it reads again with each new snapshot. With no thread, the box is the
 * home's. `act`: a post that it replies or objects to. `tick`: the snapshot's
 * time. `onPost`: a post to the lab with no thread.
 */
export function StepInBox({
  lab,
  thread,
  posts,
  act,
  tick,
  now,
  onPost,
  onStopAct,
  onSent,
}: {
  readonly lab: Lab;
  readonly thread: Thread | null;
  readonly posts: readonly Post[];
  readonly act: BoxAct | null;
  readonly tick: string;
  readonly now: number;
  readonly onPost?: (text: string, key: string) => Promise<ActOutcome>;
  readonly onStopAct?: () => void;
  readonly onSent?: () => void;
}): ReactNode {
  const controls = useContext(ControlsContext);
  const agents = boxAgents(lab, thread, posts);
  const [level, setLevel] = useState<BoxLevel>(thread ? 'thread' : 'lab');
  const [picked, setPicked] = useState<string | null>(null);
  const [names, setNames] = useState('');
  const agent = agents.find(({ id }) => id === picked) ?? agents[0] ?? null;
  const chosen = level === 'agent' && !agent ? 'thread' : level;
  const asking = chosen === 'coordinator' && !act;
  const threadId = thread?.id;
  const query = useMemo(
    () => boxQuery(threadId, act, chosen, agent?.id, names),
    [threadId, act, chosen, agent?.id, names],
  );
  const read = useCallback(
    (signal: AbortSignal) =>
      controls
        ? controls.reach(query, signal)
        : Promise.resolve({
            error: 'This page cannot read who a message reaches.',
          }),
    [controls, query],
  );
  const reach = useRead(asking ? null : read, tick);
  const line = asking
    ? askWords(lab)
    : reach.failed
      ? 'Verifold could not read who this reaches.'
      : reach.value
        ? reachWords(reach.value, now)
        : undefined;
  const send = (text: string, key: string): Promise<ActOutcome> => {
    if (!controls)
      return Promise.resolve({ refused: 'This page cannot send a message.' });
    if (act)
      return act.kind === 'object'
        ? controls.object(act.post.id, text, key)
        : controls.reply(act.post.id, text, key);
    if (chosen === 'coordinator') return controls.askCoordinator(text, key);
    if (!threadId && onPost) return onPost(text, key);
    if (chosen === 'thread' && threadId)
      return controls.writeThread(threadId, text, key);
    return controls.writeTo(
      threadId ?? null,
      chosen === 'agent' ? (agent?.id ?? 'all') : 'all',
      text,
      key,
    );
  };
  const placeholder = thread
    ? 'Write your message'
    : 'Write to the lab, or ask the Coordinator';
  return (
    <div className="box">
      {!act && (
        <div className="to" role="group" aria-label="Who this message goes to">
          {boxLevels(lab, thread, agent).map((entry) => (
            <button
              key={entry.level}
              type="button"
              aria-pressed={chosen === entry.level}
              onClick={() => setLevel(entry.level)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      )}
      {!act && chosen === 'agent' && agents.length > 1 && agent && (
        <label className="to__pick">
          Which agent
          <select
            className="field__input"
            value={agent.id}
            onChange={(event) => setPicked(event.target.value)}
          >
            {agents.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {agentName(entry.handle, entry.job)}
              </option>
            ))}
          </select>
        </label>
      )}
      <Composer
        label={placeholder}
        placeholder={placeholder}
        hint={line && act?.kind === 'object' ? objectWords(line) : line}
        maxLength={lab.postLimit}
        names={mentionNames(lab)}
        onSend={send}
        onType={(text) => setNames(atNames(text))}
        replying={
          act
            ? {
                post: act.post.id,
                verb: act.kind === 'object' ? 'Objecting to' : 'Replying to',
                to: authorOf(act.post),
                text: cut(act.post.text, 80),
                onStop: () => onStopAct?.(),
              }
            : undefined
        }
        onSent={onSent}
      />
    </div>
  );
}
