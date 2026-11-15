import { useId, useState } from 'react';
import type { ReactElement } from 'react';

import type { AgentView, PostView } from '../api/types.ts';
import { author, ownName } from '../model/agents.ts';
import { duration, minutesBetween } from '../model/format.ts';
import { orderNeeds, pauses } from '../model/needs.ts';
import { choiceGroups, harnessRequest, personAnswer } from '../model/posts.ts';
import { href } from '../model/route.ts';
import { messageOf } from '../api/client.ts';
import type { PageProps } from './hooks.ts';
import { RequestNeed } from './Coordinator.tsx';
import { Words } from './Markdown.tsx';
import { HarnessAsk } from './parts.tsx';
import { Name, Who } from './Picture.tsx';

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
      {ordered.map((item) =>
        item.post.kind === 'request' ? (
          <RequestNeed key={item.post.id} api={api} data={data} now={now} item={item} />
        ) : (
          <NeedCard
            key={item.post.id}
            item={item}
            agents={data.lab.agents}
            paused={pauses(item, data.lab)}
            now={now}
            onAnswer={async (choice, words) => {
              const request = personAnswer(item.post, choice, words);
              if (request) await api.post(request);
              data.reload();
            }}
          />
        ),
      )}
    </div>
  );
}

function NeedCard(props: {
  readonly item: PostView;
  readonly agents: readonly AgentView[];
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
  // Each agent that asks keeps its own name here.
  const name = ownName(props.agents, post.author);
  const who = author(props.agents, post.author);
  const request = harnessRequest(post);
  const permission = request === 'permission';
  const choices = post.kind === 'ask' ? post.choices : [];
  // A request of a harness shows from its recorded data, never from the body's text.
  const shown = post.kind === 'ask' ? (post.shown ?? null) : null;
  const groups = choiceGroups(choices, shown);
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
        <Who agents={props.agents} id={post.author} dot={false} />
        {who.kind === 'member' ? <Name view={who.view} /> : <b>{name}</b>}
        <span className="kind">
          {permission ? 'Permission request' : request ? 'Question from its harness' : 'Asks you'}
        </span>
        <span className="wait">Waiting {duration(minutesBetween(at, props.now))}</span>
      </div>
      <div className="nbody">
        <p className="nq">
          {permission ? post.text.replace(/^Permission needed:\s*/, '') : post.text}
        </p>
        {shown ? (
          <HarnessAsk shown={shown} name={name} />
        ) : post.body ? (
          <Words text={post.body} />
        ) : null}
        {paused ? (
          <p className="blocking">
            <span className="dot wait" /> {name} is paused until you answer.
          </p>
        ) : null}
        {groups.map((group) => (
          <div key={group.label ?? 'choices'}>
            {group.label ? <p className="says">{group.label}</p> : null}
            <div className="opts">
              {group.options.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  aria-pressed={choice === option.label}
                  onClick={() => setChoice(choice === option.label ? null : option.label)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        ))}
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
              your words: the name of an option picks it, a plain “yes” allows once, and a “no”
              rejects. Any other answer leaves the request open.
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
