import { escapeHtml as e } from '../ui/dom.ts';
import { number, type Artifact, type Post, type PostKind } from './board.ts';
import { labLimits, type DirectionView, type LabView } from './lab.ts';
import { hostName } from './session.ts';

/**
 * The lab's view in the desk: the question, one row for each direction with
 * its agent and state, the board as threads by direction, and one message
 * box. Every agent text is escaped. The view keeps a few words on each row;
 * files and runs stay in the folders, and each agent's transcript opens from
 * its row.
 */

/** A place for a transcript that the page fills: the desk view's slot. */
type TranscriptSlot = (source: string, label: string) => string;

/** A lab action that runs in the background, or why it failed. The lab view shows it. */
export interface LabWork {
  readonly label: string;
  readonly at: string;
  readonly error: string | null;
}

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

/**
 * What a direction's state says, on its row and in the rail, and the face of
 * the rail. One table, read when the view renders.
 */
function stateOf(
  entry: DirectionView,
  clock: (value: string) => string,
): { readonly text: string; readonly face: string } {
  const until = entry.until ? clock(entry.until) : '';
  switch (entry.status) {
    case 'starting':
      return { text: 'Starting', face: 'working' };
    case 'working':
      return { text: 'Working', face: 'working' };
    case 'idle':
      return { text: 'Between turns', face: 'idle' };
    case 'slot':
      return { text: 'Waits for a free agent slot', face: 'idle' };
    case 'usage':
      return {
        text: `Waits for ${hostName(entry.agent.host)}'s usage window until ${until}`,
        face: 'idle',
      };
    case 'turns':
      return {
        text: `Waits until ${until}: ${labLimits.wakeupsPerHour} turns an hour`,
        face: 'idle',
      };
    case 'paused':
      return { text: 'Paused', face: 'paused' };
    case 'stopped':
      return { text: 'Stopped', face: 'ended' };
    case 'crashed':
      return {
        text: `Stopped by itself ${labLimits.restartsPerHour + 1} times in an hour`,
        face: 'failed',
      };
  }
}

function proofText(artifact: Artifact): string {
  switch (artifact.type) {
    case 'file':
    case 'figure':
      return `${artifact.type} ${artifact.path}${artifact.direction ? ` in ${artifact.direction}` : ''} at ${artifact.commit.slice(0, 7)}`;
    case 'diff':
      return `diff of ${artifact.paths.join(', ')}${artifact.direction ? ` in ${artifact.direction}` : ''} at ${artifact.to.slice(0, 7)}`;
    case 'run':
      return `run ${artifact.run}`;
  }
}

/**
 * One direction: its title and bar, its agent, its state, its controls, and
 * the agent's transcript under them. A control keeps its direction in
 * `data-lab-direction`: the page opens a research direction on a click of an
 * element with `data-direction`.
 */
function directionRow(
  entry: DirectionView,
  clock: (value: string) => string,
  slot: TranscriptSlot,
  runs: boolean,
): string {
  const { direction, agent, status } = entry;
  const active = status === 'working' || status === 'starting';
  const controls = (
    runs
      ? [
          status === 'crashed'
            ? `<button type="button" data-action="lab-agent-restart" data-agent="${e(agent.id)}">Start again</button>`
            : '',
          direction.state === 'open'
            ? `<button type="button" class="quiet" data-action="lab-direction-stop" data-lab-direction="${e(direction.id)}" data-confirm="Click again to stop this direction">Stop</button>`
            : '',
        ]
      : []
  ).join('');
  const transcript = agent.session
    ? `<details class="lab-activity" id="lab-activity-${e(agent.id)}"><summary>What ${e(agent.handle)} did</summary>${slot(`session:${agent.session}`, `${agent.handle} transcript`)}</details>`
    : '';
  return `<li class="lab-direction"><div class="lab-direction-text"><strong>${e(direction.title)}</strong>${direction.bar ? `<span class="fine">Holds up if ${e(direction.bar)}</span>` : ''}</div><span class="lab-agent">${e(agent.handle)} <span class="fine">${hostName(agent.host)}</span></span><span class="status${active ? ' active' : status === 'crashed' ? ' failed' : ''}">${e(stateOf(entry, clock).text)}</span><span class="lab-controls">${controls}</span>${transcript}</li>`;
}

/** Characters of a post that the view shows before it folds the rest. */
const foldAt = 600;

/**
 * The text of a post. A long one shows its start, and the rest folds. The
 * folded rest counts against `budget`, the characters that the whole view
 * still has for it; a post past the budget keeps only its start.
 */
function postText(post: Post, budget: { left: number }): string {
  if (post.text.length <= foldAt * 2)
    return `<p class="pre">${e(post.text)}</p>`;
  const start = `<p class="pre">${e(post.text.slice(0, foldAt))}…</p>`;
  const whole = e(post.text);
  if (whole.length > budget.left)
    return `${start}<p class="fine">The whole post is on the board, in .verifold/board/${e(post.id)}.json.</p>`;
  budget.left -= whole.length;
  return `${start}<details><summary>Show the whole post</summary><p class="pre">${whole}</p></details>`;
}

function postHtml(
  post: Post,
  name: (author: string) => string,
  clock: (value: string) => string,
  replies: readonly Post[],
  budget: { left: number },
  runs: boolean,
): string {
  const person = post.author === 'person';
  const kind =
    post.kind === 'status'
      ? ''
      : `<span class="chip kind-${post.kind}">${person && post.kind === 'question' ? 'Message' : kindWords[post.kind]}</span>`;
  return `<article class="post${post.kind === 'status' ? ' note' : ''}" id="post-${e(post.id)}"><header class="feed-head"><strong>${e(name(post.author))}</strong>${kind}<time datetime="${e(post.at)}">${e(clock(post.at))}</time></header>${postText(post, budget)}${post.artifacts.length ? `<ul class="proof">${post.artifacts.map((artifact) => `<li>${e(proofText(artifact))}</li>`).join('')}</ul>` : ''}${post.kind === 'status' || !runs ? '' : `<button type="button" class="quiet" data-action="lab-reply" data-post="${e(post.id)}">Reply</button>`}${replies.length ? `<div class="replies">${replies.map((reply) => postHtml(reply, name, clock, [], budget, runs)).join('')}</div>` : ''}</article>`;
}

/**
 * The board as threads: one group for each direction and one for posts
 * without a direction. The group and the thread with the newest activity,
 * replies included, come first. A reply shows under the post that it answers.
 */
function board(
  view: LabView,
  name: (author: string) => string,
  clock: (value: string) => string,
): string {
  // Folded text of long posts, newest first, stays well under the desk view's limit.
  const budget = { left: 600_000 };
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
  const under = (post: Post): Post[] =>
    (replies.get(post.id) ?? []).flatMap((reply) => [reply, ...under(reply)]);
  // Each thread once: its replies, and its activity, the number of its newest post.
  const threads = new Map(
    roots.map((root) => {
      const list = under(root);
      return [
        root.id,
        {
          root,
          list,
          latest: Math.max(
            number(root.id),
            ...list.map((post) => number(post.id)),
          ),
        },
      ] as const;
    }),
  );
  const groups = new Map<string, { latest: number; ids: string[] }>();
  for (const { root, latest } of threads.values()) {
    const key = root.direction ?? '';
    const group = groups.get(key) ?? { latest: 0, ids: [] };
    group.latest = Math.max(group.latest, latest);
    group.ids.push(root.id);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => b.latest - a.latest)
    .map(([key, group]) => {
      const title = key
        ? (view.state.directions.find((entry) => entry.id === key)?.title ??
          key)
        : 'Not about one direction';
      return `<section class="lab-thread" aria-label="${e(title)}"><h3>${e(title)}</h3>${group.ids
        .flatMap((id) => {
          const thread = threads.get(id);
          return thread ? [thread] : [];
        })
        .sort((a, b) => b.latest - a.latest)
        .map((thread) =>
          postHtml(thread.root, name, clock, thread.list, budget, view.runs),
        )
        .join('')}</section>`;
    })
    .join('');
}

/**
 * Home for a lab. `clock` formats a time, and `slot` places a transcript.
 * `needs` is Home's HTML for what waits for the person, such as a permission
 * request of their own session. It shows above the directions.
 */
export function renderLab(
  view: LabView,
  clock: (value: string) => string,
  slot: TranscriptSlot,
  needs = '',
  work: LabWork | null = null,
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
  const { runs } = view;
  const working = work
    ? work.error === null
      ? `<p class="notice" role="status">${e(work.label)}. It started at ${e(clock(work.at))} and goes on in the background.</p>`
      : `<p class="notice" role="alert">${e(work.label)} did not finish: ${e(work.error)} <button type="button" class="quiet" data-action="lab-dismiss">Dismiss</button></p>`
    : '';
  const pause = !runs
    ? ''
    : state.pausedAt
      ? '<button type="button" data-action="lab-resume">Resume the lab</button>'
      : '<button type="button" class="quiet" data-action="lab-pause">Pause the lab</button>';
  return `<div class="masthead"><h1 id="view-title" tabindex="-1">Lab</h1><p class="question">${e(state.question)}</p></div>
  <div class="view lab">
  ${runs ? '' : '<p class="notice">This desk runs one session, so it only shows the lab. Run verifold in the project folder to work in the lab.</p>'}${state.pausedAt ? `<p class="notice">You paused the lab at ${e(clock(state.pausedAt))}. No agent works until you resume it.</p>` : ''}${working}${needs}
  <section class="card" aria-labelledby="directions-title"><div class="section-title"><h2 id="directions-title">Directions</h2><span class="actions">${pause}</span></div>
  ${view.directions.length ? `<ul class="lab-directions">${view.directions.map((entry) => directionRow(entry, clock, slot, runs)).join('')}</ul>` : '<p class="empty-note">No direction yet. Open one below: each direction gets its own agent and its own copy of the project.</p>'}
  ${runs ? addForm(view.directions.length > 0) : ''}</section>
  ${runs ? composeBox(state, handles) : ''}
  <section aria-labelledby="board-title"><div class="section-title"><h2 id="board-title">Board</h2><span class="count">${view.posts.length} ${view.posts.length === 1 ? 'post' : 'posts'}</span></div>${board(view, name, clock)}</section>
  </div>`;
}

/** The form that opens a direction. */
function addForm(folded: boolean): string {
  return `<details id="lab-add"${folded ? '' : ' open'}><summary>Open a direction</summary>
  <label class="field" for="lab-title">Title</label><input id="lab-title" type="text" maxlength="120" placeholder="Years wind on a helix">
  <label class="field" for="lab-harness">Agent</label><select id="lab-harness"><option value="claude">Claude Code</option><option value="codex">Codex</option></select>
  <label class="field" for="lab-bar">Holds up if (optional)</label><input id="lab-bar" type="text" maxlength="280" placeholder="it beats a circle for years on 3 seeds">
  <div class="actions"><button type="button" class="primary" data-action="lab-direction-add">Open the direction</button></div></details>`;
}

/** The box that posts to the board. */
function composeBox(
  state: LabView['state'],
  handles: readonly string[],
): string {
  return `<section class="card lab-compose" aria-labelledby="compose-title"><h2 id="compose-title">Write to the lab</h2>
  <textarea id="lab-text" rows="3" maxlength="4000" aria-labelledby="compose-title" placeholder="Write to the lab. ${e(handles[0] ?? '@claude-1')} wakes that agent."></textarea>
  <input id="lab-reply" type="hidden" value="">
  <p class="lab-replying" id="lab-replying" hidden><span id="lab-reply-note"></span><button type="button" class="quiet" data-action="lab-reply-clear" aria-label="Stop replying">×</button></p>
  <div class="fields"><label class="field" for="lab-direction">About<select id="lab-direction"><option value="">Any direction</option>${state.directions.map((direction) => `<option value="${e(direction.id)}">${e(direction.title)}</option>`).join('')}</select></label></div>
  <div class="actions"><button type="button" class="primary" data-action="lab-post">Post</button></div>
  <p class="fine">${handles.length ? `Mention ${e(handles.join(', '))}, or @all. A post to nobody wakes every agent.` : 'Agents read your posts once their directions open.'}</p></section>`;
}

/** A lab agent in the rail's team: the face of its state and its line. */
export function labMember(
  entry: DirectionView,
  clock: (value: string) => string,
): { readonly face: string; readonly line: string } {
  const { text, face } = stateOf(entry, clock);
  return { face, line: text };
}

/** Home's offer to start a lab, for a project with no team at work. */
export function renderLabStart(topic: string | undefined): string {
  return `<section class="card lead" aria-labelledby="lab-start-title"><h2 id="lab-start-title">Start the lab</h2><p>Several agents work on your question at the same time. Each one owns a direction in its own copy of the project. They post what they find on one board, with proof, and check each other's claims.</p>
  <label class="field" for="lab-question">Your question</label><textarea id="lab-question" rows="2" maxlength="4000">${e(topic ?? '')}</textarea>
  <div class="actions"><button type="button" class="primary" data-action="lab-start">Start the lab</button></div><p class="fine">Nothing runs until you open a direction.</p></section>`;
}
