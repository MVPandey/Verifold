import { escapeHtml as e } from '../ui/dom.ts';
import type { Artifact, Post, PostKind } from './board.ts';
import type { DirectionView, LabView, Verdict } from './lab.ts';
import { hostName } from './session.ts';

/**
 * The lab's view in the desk: the question, one row for each direction with
 * its agent and state, the board as threads by direction, and one message
 * box. Every agent text is escaped. The view keeps a few words on each row;
 * files and runs stay in the folders.
 */

const verdictWords: Record<Verdict, string> = {
  open: 'Open',
  leading: 'Leading',
  'holds-up': 'Holds up',
  'ruled-out': 'Ruled out',
};

const kindWords: Record<PostKind, string> = {
  plan: 'Plan',
  claim: 'Claim',
  evidence: 'Evidence',
  objection: 'Objection',
  question: 'Question',
  rerun: 'Rerun',
  'ruled-out': 'Ruled out',
  status: 'Note',
};

/** The posts that the view shows. Older ones stay on the board and in the agents' digests. */
const shownPosts = 120;

function statusText(
  entry: DirectionView,
  clock: (value: string) => string,
): string {
  const until = entry.until ? clock(entry.until) : '';
  switch (entry.status) {
    case 'starting':
      return 'Starting';
    case 'working':
      return 'Working';
    case 'idle':
      return 'Between turns';
    case 'slot':
      return 'Waits for a free agent slot';
    case 'usage':
      return `Waits for ${hostName(entry.agent.host)}'s usage window until ${until}`;
    case 'turns':
      return `Waits until ${until}: 12 turns an hour`;
    case 'paused':
      return 'Paused';
    case 'stopped':
      return 'Stopped';
    case 'crashed':
      return 'Stopped by itself twice';
  }
}

function proofText(artifact: Artifact): string {
  switch (artifact.type) {
    case 'file':
    case 'figure':
      return `${artifact.type} ${artifact.path} at ${artifact.commit.slice(0, 7)}`;
    case 'diff':
      return `diff of ${artifact.paths.join(', ')} at ${artifact.to.slice(0, 7)}`;
    case 'run':
      return `run ${artifact.run}`;
  }
}

function directionRow(
  entry: DirectionView,
  clock: (value: string) => string,
): string {
  const { direction, agent, status } = entry;
  const active = status === 'working' || status === 'starting';
  const control =
    status === 'crashed'
      ? `<button type="button" data-action="lab-agent-restart" data-agent="${e(agent.id)}">Start again</button>`
      : direction.state === 'open'
        ? `<button type="button" class="quiet" data-action="lab-direction-stop" data-direction="${e(direction.id)}" data-confirm="Click again to stop this direction">Stop</button>`
        : '';
  return `<li class="lab-direction"><span class="verdict ${direction.verdict}">${verdictWords[direction.verdict]}</span><div class="lab-direction-text"><strong>${e(direction.title)}</strong>${direction.bar ? `<span class="fine">Holds up if ${e(direction.bar)}</span>` : ''}</div><span class="lab-agent">${e(agent.handle)} <span class="fine">${hostName(agent.host)}</span></span><span class="status${active ? ' active' : status === 'crashed' ? ' failed' : ''}">${e(statusText(entry, clock))}</span>${control}</li>`;
}

function postHtml(
  post: Post,
  name: (author: string) => string,
  clock: (value: string) => string,
  replies: readonly Post[],
): string {
  const person = post.author === 'person';
  const kind =
    post.kind === 'status'
      ? ''
      : `<span class="chip ${post.kind}">${person && post.kind === 'question' ? 'Message' : kindWords[post.kind]}</span>`;
  return `<article class="post${post.kind === 'status' ? ' note' : ''}" id="post-${e(post.id)}"><header class="feed-head"><strong>${e(name(post.author))}</strong>${kind}<time datetime="${e(post.at)}">${e(clock(post.at))}</time></header><p class="pre">${e(post.text)}</p>${post.artifacts.length ? `<ul class="proof">${post.artifacts.map((artifact) => `<li>${e(proofText(artifact))}</li>`).join('')}</ul>` : ''}${post.kind === 'status' ? '' : `<button type="button" class="quiet" data-action="lab-reply" data-post="${e(post.id)}">Reply</button>`}${replies.length ? `<div class="replies">${replies.map((reply) => postHtml(reply, name, clock, [])).join('')}</div>` : ''}</article>`;
}

/**
 * The board as threads: one group for each direction and one for posts
 * without a direction, the group with the newest post first. A reply shows
 * under the post that it answers.
 */
function board(
  view: LabView,
  name: (author: string) => string,
  clock: (value: string) => string,
): string {
  const posts = view.posts.slice(-shownPosts);
  if (!posts.length)
    return '<p class="empty-note">No posts yet. Agents post what they find here, with proof.</p>';
  const shown = new Set(posts.map((post) => post.id));
  const replies = new Map<string, Post[]>();
  const roots: Post[] = [];
  for (const post of posts)
    if (post.replyTo && shown.has(post.replyTo))
      replies.set(post.replyTo, [...(replies.get(post.replyTo) ?? []), post]);
    else roots.push(post);
  // All replies of a thread show under its first post.
  const thread = (post: Post): Post[] =>
    (replies.get(post.id) ?? []).flatMap((reply) => [reply, ...thread(reply)]);
  const groups = new Map<string, Post[]>();
  for (const post of roots) {
    const key = post.direction ?? '';
    groups.set(key, [...(groups.get(key) ?? []), post]);
  }
  return [...groups.entries()]
    .sort(
      ([, a], [, b]) =>
        Date.parse(b.at(-1)?.at ?? '') - Date.parse(a.at(-1)?.at ?? ''),
    )
    .map(([key, list]) => {
      const title = key
        ? (view.state.directions.find((entry) => entry.id === key)?.title ??
          key)
        : 'Not about one direction';
      return `<section class="lab-thread" aria-label="${e(title)}"><h3>${e(title)}</h3>${[
        ...list,
      ]
        .reverse()
        .map((post) => postHtml(post, name, clock, thread(post)))
        .join('')}</section>`;
    })
    .join('');
}

/** The lab's main view. `clock` formats a time. */
export function renderLab(
  view: LabView,
  clock: (value: string) => string,
): string {
  const { state } = view;
  const name = (author: string): string =>
    author === 'person'
      ? 'You'
      : author === 'verifold'
        ? 'Verifold'
        : (view.handles[author] ?? author);
  const open = view.directions.filter(
    (entry) => entry.direction.state === 'open',
  );
  const handles = open.map((entry) => `@${entry.agent.handle}`);
  return `<div class="masthead"><h1 id="view-title" tabindex="-1">Lab</h1><p class="question">${e(state.question)}</p></div>
  <div class="view lab">
  ${state.pausedAt ? `<p class="notice">You paused the lab at ${e(clock(state.pausedAt))}. No agent works until you resume it.</p>` : ''}
  <section class="card" aria-labelledby="directions-title"><div class="section-title"><h2 id="directions-title">Directions</h2><span class="actions">${state.pausedAt ? '<button type="button" data-action="lab-resume">Resume the lab</button>' : '<button type="button" class="quiet" data-action="lab-pause">Pause the lab</button>'}</span></div>
  ${view.directions.length ? `<ul class="lab-directions">${view.directions.map((entry) => directionRow(entry, clock)).join('')}</ul>` : '<p class="empty-note">No direction yet. Open one below: each direction gets its own agent and its own copy of the project.</p>'}
  <details id="lab-add"${view.directions.length ? '' : ' open'}><summary>Open a direction</summary>
  <label class="field" for="lab-title">Title</label><input id="lab-title" type="text" maxlength="120" placeholder="Years wind on a helix">
  <label class="field" for="lab-harness">Agent</label><select id="lab-harness"><option value="claude">Claude Code</option><option value="codex">Codex</option></select>
  <label class="field" for="lab-bar">Holds up if (optional)</label><input id="lab-bar" type="text" maxlength="280" placeholder="it beats a circle for years on 3 seeds">
  <div class="actions"><button type="button" class="primary" data-action="lab-direction-add">Open the direction</button></div></details></section>
  <section class="card lab-compose" aria-labelledby="compose-title"><h2 id="compose-title">Write to the lab</h2>
  <textarea id="lab-text" rows="3" maxlength="4000" aria-labelledby="compose-title" placeholder="Write to the lab. ${e(handles[0] ?? '@claude-1')} wakes that agent."></textarea>
  <input id="lab-reply" type="hidden" value="">
  <div class="fields"><label class="field" for="lab-direction">About<select id="lab-direction"><option value="">Any direction</option>${state.directions.map((direction) => `<option value="${e(direction.id)}">${e(direction.title)}</option>`).join('')}</select></label></div>
  <div class="actions"><button type="button" class="primary" data-action="lab-post">Post</button><span class="fine" id="lab-reply-note"></span></div>
  <p class="fine">${handles.length ? `Mention ${e(handles.join(', '))}, or @all. A post to nobody wakes every agent.` : 'Agents read your posts once their directions open.'}</p></section>
  <section aria-labelledby="board-title"><div class="section-title"><h2 id="board-title">Board</h2><span class="count">${view.posts.length} ${view.posts.length === 1 ? 'post' : 'posts'}</span></div>${board(view, name, clock)}</section>
  </div>`;
}

/** A lab agent in the rail's team: the face of its state and a short line. */
export function labMember(entry: DirectionView): {
  readonly face: string;
  readonly line: string;
} {
  switch (entry.status) {
    case 'working':
      return { face: 'working', line: 'Working' };
    case 'starting':
      return { face: 'working', line: 'Starting' };
    case 'slot':
      return { face: 'idle', line: 'Waits for a free slot' };
    case 'usage':
      return { face: 'idle', line: 'Waits for its usage window' };
    case 'turns':
      return { face: 'idle', line: 'Waits for its hourly turns' };
    case 'paused':
      return { face: 'paused', line: 'Paused' };
    case 'crashed':
      return { face: 'failed', line: 'Stopped by itself twice' };
    case 'stopped':
      return { face: 'ended', line: 'Stopped' };
    case 'idle':
      return { face: 'idle', line: 'Between turns' };
  }
}

/** Home's offer to start a lab, for a project with no team at work. */
export function renderLabStart(topic: string | undefined): string {
  return `<section class="card lead" aria-labelledby="lab-start-title"><h2 id="lab-start-title">Start the lab</h2><p>Several agents work on your question at the same time. Each one owns a direction in its own copy of the project. They post what they find on one board, with proof, and check each other's claims.</p>
  <label class="field" for="lab-question">Your question</label><textarea id="lab-question" rows="2" maxlength="4000">${e(topic ?? '')}</textarea>
  <div class="actions"><button type="button" class="primary" data-action="lab-start">Start the lab</button></div><p class="fine">Nothing runs until you open a direction.</p></section>`;
}
