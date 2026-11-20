import type { ReactElement } from 'react';

import type { AgentView, BranchView, IdeaView, MapView } from '../api/types.ts';
import { authorName } from '../model/agents.ts';
import { ago } from '../model/format.ts';
import {
  STATE_TONES,
  STATE_WORDS,
  branchCounts,
  challengedBy,
  emptyMark,
  parentIdea,
  splitBranches,
  triedBy,
} from '../model/map.ts';
import type { DeedLine } from '../model/map.ts';
import { clip } from '../model/posts.ts';
import { href } from '../model/route.ts';

/**
 * The Map tab: the branches of the question in the reading's order, each folded with its counts, and the retired
 * branches after them. A branch opens to its ideas in the order that they were posted. The board ranks nothing, so
 * the page orders nothing by counts.
 */
export function MapTab(props: {
  readonly map: MapView;
  readonly agents: readonly AgentView[];
  readonly now: Date;
}): ReactElement {
  const { map } = props;
  const { inForce, retired } = splitBranches(map);
  if (map.branches.length === 0) {
    return <p className="empty">The lab’s reading has no branches yet.</p>;
  }
  return (
    <section className="m-map" aria-label="The map of the question">
      <ul className="m-tree">
        {inForce.map((branch) => (
          <BranchRow key={branch.id} branch={branch} {...props} />
        ))}
      </ul>
      {retired.length > 0 ? (
        <details className="m-retired">
          <summary>
            Retired branches · {retired.length} <u className="closed">Show</u>
            <u className="opened">Hide</u>
          </summary>
          <ul className="m-tree">
            {retired.map((branch) => (
              <BranchRow key={branch.id} branch={branch} {...props} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/** One branch: its title and counts, folded, or its mark when no idea hangs on it. */
function BranchRow(props: {
  readonly branch: BranchView;
  readonly map: MapView;
  readonly agents: readonly AgentView[];
  readonly now: Date;
}): ReactElement {
  const { branch } = props;
  const ideas = branch.idea_list ?? [];
  const empty = emptyMark(branch);
  const head = (
    <>
      <b>{branch.title}</b>
      {branch.retired === true ? <em className="f-st fs-con">retired</em> : null}
      <span className={empty ? 'm-cnt m-empty' : 'm-cnt'}>{empty ?? branchCounts(branch)}</span>
    </>
  );
  if (ideas.length === 0) {
    return (
      <li className="m-branch">
        <div className="m-head">{head}</div>
      </li>
    );
  }
  return (
    <li className="m-branch">
      <details>
        <summary className="m-head">{head}</summary>
        <ol className="m-ideas">
          {ideas.map((idea) => (
            <li key={idea.id}>
              <IdeaCard idea={idea} {...props} />
            </li>
          ))}
        </ol>
      </details>
    </li>
  );
}

/** An idea's card: its statement, which leads to its thread, its test, what rules it out, and who tried and challenged it. */
export function IdeaCard(props: {
  readonly idea: IdeaView;
  readonly map: MapView;
  readonly agents: readonly AgentView[];
  readonly now: Date;
}): ReactElement {
  const { idea, agents } = props;
  const name = (authorId: string): string => authorName(agents, authorId);
  const state = idea.state ?? 'untried';
  const under = parentIdea(props.map, idea);
  const tried = triedBy(idea, name);
  const challenged = challengedBy(idea, name);
  return (
    <article className="m-idea" id={`idea-${idea.id}`}>
      <p className="kicker">
        Idea · {name(idea.author)} · {ago(idea.at, props.now)}
        <em className={`f-st ${STATE_TONES[state]}`}>{STATE_WORDS[state]}</em>
      </p>
      <h3>
        <a href={href({ page: 'thread', id: idea.thread, post: idea.id })}>{idea.text}</a>
      </h3>
      <dl>
        {under ? (
          <>
            <dt>Under</dt>
            <dd>
              <a href={href({ page: 'thread', id: under.thread, post: under.id })}>
                {clip(under.text)}
              </a>
            </dd>
          </>
        ) : null}
        <dt>The test</dt>
        <dd>{idea.test}</dd>
        <dt>Rules it out</dt>
        <dd>{idea.rules_out}</dd>
        <dt>Tried by</dt>
        <dd>{tried.length > 0 ? <Deeds lines={tried} /> : 'Nobody yet.'}</dd>
        {challenged.length > 0 ? (
          <>
            <dt>Challenged by</dt>
            <dd>
              <Deeds lines={challenged} />
            </dd>
          </>
        ) : null}
      </dl>
    </article>
  );
}

function Deeds(props: { readonly lines: readonly DeedLine[] }): ReactElement {
  return (
    <ul className="m-deeds">
      {props.lines.map((line) => (
        <li key={line.post}>
          <a href={href({ page: 'thread', id: line.thread, post: line.post })}>
            <b>{line.who}</b>: {line.text}
          </a>{' '}
          <em className={`f-st ${line.tone}`}>{line.mark}</em>
        </li>
      ))}
    </ul>
  );
}
