import { useId, useState } from 'react';
import type { ReactElement } from 'react';

import type { AgentView, HarnessOption, PostView } from '../api/types.ts';
import { authorName, face, harnessTitle } from '../model/agents.ts';
import { duration, minutesBetween } from '../model/format.ts';
import { orderNeeds, pauses } from '../model/needs.ts';
import { isPermission, personAnswer } from '../model/posts.ts';
import { href } from '../model/route.ts';
import { messageOf } from '../api/client.ts';
import type { PageProps } from './hooks.ts';
import { Body, FaceView } from './parts.tsx';

/** Everything that waits for the person's answer. Requests that pause an agent come first. */
export function NeedsPage({ api, data, now }: PageProps): ReactElement {
  const ordered = orderNeeds(data.needs, data.lab);
  return (
    <div className="narrow">
      <h1>Needs you</h1>
      <p className="sub">
        {ordered.length === 0
          ? 'Nothing waits for you now.'
          : `${ordered.length} waiting. Requests that pause an agent come first.`}
      </p>
      {ordered.map((item) => (
        <NeedCard
          key={item.post.id}
          item={item}
          agents={data.lab.agents}
          harnesses={data.setup?.harnesses ?? []}
          paused={pauses(item, data.lab)}
          now={now}
          onAnswer={async (choice, words) => {
            const request = personAnswer(item.post, choice, words);
            if (request) await api.post(request);
            data.reload();
          }}
        />
      ))}
    </div>
  );
}

function NeedCard(props: {
  readonly item: PostView;
  readonly agents: readonly AgentView[];
  readonly harnesses: readonly HarnessOption[];
  readonly paused: boolean;
  readonly now: Date;
  readonly onAnswer: (choice: string | null, words: string) => Promise<void>;
}): ReactElement {
  const [choice, setChoice] = useState<string | null>(null);
  const [words, setWords] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wordsId = useId();
  const { post, at } = props.item;
  const name = authorName(props.agents, post.author);
  const agent = props.agents.find((view) => view.agent.id === post.author);
  const permission = isPermission(post);
  const choices = post.kind === 'ask' ? post.choices : [];
  const paused = props.paused;

  const send = (): void => {
    setSending(true);
    setError(null);
    props.onAnswer(choice, words).catch((failure: unknown) => {
      setError(messageOf(failure));
      setSending(false);
    });
  };

  return (
    <section className="nitem open" aria-label={`${name}: ${post.text}`}>
      <div className="nh">
        <FaceView face={face(props.agents, post.author)} />
        <b>{name}</b>
        {agent ? (
          <span className="f-tag">{harnessTitle(props.harnesses, agent.agent.harness)}</span>
        ) : null}
        <span className="kind k-ask">{permission ? 'Permission request' : 'Asks you'}</span>
        <span className="wait">Waiting {duration(minutesBetween(at, props.now))}</span>
      </div>
      <div className="nbody">
        <p className="nq">
          {permission ? post.text.replace(/^Permission needed:\s*/, '') : post.text}
        </p>
        {post.body ? <Body text={post.body} /> : null}
        {paused ? (
          <p className="blocking">
            <span className="dot wait" /> {name} is paused until you answer.
          </p>
        ) : null}
        {choices.length > 0 ? (
          <div className="opts">
            {choices.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={choice === option}
                onClick={() => setChoice(choice === option ? null : option)}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
        <div className="own">
          <label htmlFor={wordsId}>
            {choices.length > 0 ? 'Or answer in your own words' : 'Your answer'}
          </label>
          <textarea
            id={wordsId}
            value={words}
            placeholder="Your answer"
            onChange={(event) => setWords(event.target.value)}
          />
          {permission ? (
            <p className="note">
              Your words go to {name} with the option you pick. Without an option, Verifold reads
              your words: naming an option picks it, a yes allows once, and a no or anything unclear
              rejects.
            </p>
          ) : null}
        </div>
        <div className="nactions">
          <button
            className="btn primary"
            type="button"
            disabled={sending || (choice === null && !words.trim())}
            onClick={send}
          >
            {sending ? 'Sending' : 'Send answer'}
          </button>
          <a href={href({ page: 'thread', id: post.thread, post: post.id })}>See the thread</a>
        </div>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
