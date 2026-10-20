import { escapeHtml as e } from '../ui/dom.ts';
import {
  clip,
  number,
  type Artifact,
  type Post,
  type PostKind,
} from './board.ts';
import {
  barSummary,
  budgetEnded,
  defaultLabHours,
  labLimits,
  verdictWords,
  type Check,
  type DirectionView,
  type LabView,
} from './lab.ts';
import { checkableKinds } from './lab-tools.ts';
import {
  metricsText,
  placeText,
  runActive,
  runSummary,
  type RunRecord,
} from './runs.ts';
import { hostName } from './session.ts';

/**
 * The lab's view in the desk: the question, one row for each direction with
 * its agent and state, the board as threads by direction, and one message
 * box. Every agent text is escaped. The view keeps a few words on each row;
 * files stay in the folders, and each agent's transcript and each run's log
 * open from its row.
 */

/** A place for a transcript that the page fills: the desk view's slot. */
type TranscriptSlot = (source: string, label: string) => string;

/** A lab action that runs in the background, or why it failed. The lab view shows it. */
export interface LabWork {
  /** The desk action, such as lab-direction-add. */
  readonly action: string;
  readonly label: string;
  readonly at: string;
  readonly error: string | null;
}

/**
 * The lab actions that run in the background, and the ones that failed there.
 * `data-lab-work` and `data-lab-failed` name the action, so the page knows
 * when a background open ended.
 */
export function renderLabWork(
  works: readonly LabWork[],
  clock: (value: string) => string,
): string {
  return works
    .map((work) =>
      work.error === null
        ? `<p class="notice" role="status" data-lab-work="${e(work.action)}">${e(work.label)}. It started at ${e(clock(work.at))} and goes on in the background.</p>`
        : `<p class="notice" role="alert" data-lab-failed="${e(work.action)}">${e(work.label)} did not finish: ${e(work.error)} <button type="button" class="quiet" data-action="lab-dismiss">Dismiss</button></p>`,
    )
    .join('');
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
export function stateOf(
  entry: DirectionView,
  clock: (value: string) => string,
): { readonly text: string; readonly face: string } {
  const until = entry.until ? clock(entry.until) : '';
  switch (entry.status) {
    case 'plan':
      return { text: 'Starts with the plan', face: 'idle' };
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
    case 'closed':
      return { text: 'Closed by its agent', face: 'ended' };
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

/** The kinds of post that a check can test, when they cite a run. */
const checkable: ReadonlySet<PostKind> = new Set(checkableKinds);

/**
 * How a check tested a post, in a few words, or null when no check did:
 * "reran r-9 (Codex): acc=0.7", "did not hold on r-9", "read the code only",
 * a check that waits or runs, or one that failed. The newest done check
 * counts first.
 */
export function checkMark(
  post: Post,
  view: LabView,
  ledger: ReadonlyMap<string, RunRecord>,
): string | null {
  const checks = view.checks.filter((check) => check.claim === post.id);
  const done = checks.filter((check) => check.state === 'done').at(-1);
  if (done) {
    const result = view.posts.find((entry) => entry.id === done.result);
    const runs = (result?.artifacts ?? []).flatMap((artifact) => {
      const run =
        artifact.type === 'run' ? ledger.get(artifact.run) : undefined;
      return run?.agent === done.agent ? [run] : [];
    });
    const ids = runs.map((run) => run.id).join(', ') || done.run;
    const who = `${hostName(done.harness)}${done.sameHarness ? ', same harness' : ''}`;
    const missed =
      done.outcome === 'differs'
        ? 'differs'
        : done.outcome === 'fails'
          ? 'did not hold'
          : '';
    if (done.method === 'code-read')
      return `read the code only (${who})${missed ? `: ${missed}` : ''}`;
    if (done.outcome === 'holds') {
      const metrics = runs[0] ? metricsText(runs[0]) : '';
      return `reran ${ids} (${who})${metrics ? `: ${metrics}` : ''}`;
    }
    return `${done.outcome === 'differs' ? 'differs on' : 'did not hold on'} ${ids} (${who})`;
  }
  const open = checks.find(
    (check) => check.state === 'queued' || check.state === 'running',
  );
  if (open)
    return open.state === 'running'
      ? `${open.handle} checks it`
      : `check ${open.id} waits`;
  if (checks.some((check) => check.state === 'failed')) return 'check failed';
  return null;
}

/**
 * An objection to a claim, evidence, or rerun post is a dispute until a
 * check of that post ends after it. The disputed posts, oldest first, each
 * with its open objections and its newest check.
 */
export function openDisputes(view: LabView): {
  readonly target: Post;
  readonly objections: readonly Post[];
  readonly check: Check | null;
}[] {
  const posts = new Map(view.posts.map((post) => [post.id, post]));
  const open = new Map<string, Post[]>();
  for (const objection of view.posts) {
    const target =
      objection.kind === 'objection' && objection.replyTo
        ? posts.get(objection.replyTo)
        : undefined;
    if (!target || !checkable.has(target.kind)) continue;
    const settled = view.checks.some(
      (check) =>
        check.claim === target.id &&
        check.state === 'done' &&
        (check.objections.includes(objection.id) ||
          Date.parse(check.endedAt ?? '') > Date.parse(objection.at)),
    );
    if (!settled)
      open.set(target.id, [...(open.get(target.id) ?? []), objection]);
  }
  return [...open].flatMap(([id, objections]) => {
    const target = posts.get(id);
    return target
      ? [
          {
            target,
            objections,
            check:
              view.checks.filter((check) => check.claim === id).at(-1) ?? null,
          },
        ]
      : [];
  });
}

/** Open disputes, pinned above the directions: one item for each disputed post, with where its check is. */
function disputesCard(
  view: LabView,
  open: ReturnType<typeof openDisputes>,
  name: (author: string) => string,
  slot: TranscriptSlot,
): string {
  if (!open.length) return '';
  const items = open.map(({ objections, target, check }) => {
    const where = !target.artifacts.some((artifact) => artifact.type === 'run')
      ? `${target.id} cites no run, so no check can rerun it.`
      : !check
        ? 'No check yet.'
        : check.state === 'done'
          ? `${target.id} had its checks. The last one, ${check.id}, ended before these objections, so no check answers them.`
          : check.state === 'failed'
            ? `Check ${check.id} failed: ${check.note ?? 'no reason'}`
            : check.state === 'running'
              ? `${check.handle} (${hostName(check.harness)}) checks it now, without the author's reasoning.`
              : `Check ${check.id} waits for ${check.handle} (${hostName(check.harness)}).`;
    const runs = check
      ? view.ledger
          .filter((run) => run.agent === check.agent)
          .map((run) => runHtml(run, check.id, view.runs))
          .join('')
      : '';
    const transcript =
      check?.session && check.state !== 'queued'
        ? `<details class="lab-activity"><summary>What ${e(check.handle)} did</summary>${slot(`session:${check.session}`, `${check.handle} transcript`)}</details>`
        : '';
    const doubts = objections
      .map(
        (objection) =>
          `<p class="pre"><a href="#post-${e(objection.id)}">${e(name(objection.author))}</a>: ${e(clip(objection.text, 280))}</p>`,
      )
      .join('');
    return `<li><a href="#post-${e(target.id)}">${e(target.id)} is in dispute</a>${target.direction ? ` <span class="fine">in ${e(view.state.directions.find((entry) => entry.id === target.direction)?.title ?? target.direction)}</span>` : ''}${doubts}<p class="fine">${e(where)}</p>${runs ? `<div class="lab-runs">${runs}</div>` : ''}${transcript}</li>`;
  });
  return `<section class="card lab-disputes" aria-labelledby="disputes-title"><h2 id="disputes-title">Open disputes</h2><ul>${items.join('')}</ul><p class="fine">A fresh agent of the other harness reruns the disputed post. Its rerun settles the dispute.</p></section>`;
}

/** Runs that a direction's row shows: those that run now, then the newest. */
const rowRuns = 3;

/**
 * One run: its ID, its state, its pod, and up to three metrics, with its log one click
 * away. `place` keeps the log's ID apart where a run shows twice, on its row
 * and in a post. The person cancels a run that runs from its row.
 */
function runHtml(run: RunRecord, place: string, cancel: boolean): string {
  const active = runActive(run);
  const metrics = metricsText(run);
  return `<div class="lab-run"><span class="chip run-${e(run.status)}">${e(run.id)}</span> <span>${e(runSummary(run))}</span>${run.where === 'local' ? '' : ` <span class="fine">${e(placeText(run))}</span>`}${metrics ? ` <span class="fine">${e(metrics)}</span>` : ''}${cancel && active ? ` <button type="button" class="quiet" data-action="lab-run-cancel" data-run="${e(run.id)}" data-confirm="Click again to cancel this run">Cancel</button>` : ''}<details class="run-log" id="run-log-${e(place)}-${e(run.id)}"><summary>Log</summary><p class="fine">${e(run.why)} · <code>${e(clip(run.command, 300))}</code> at ${e(run.commit.slice(0, 7))}${run.note ? ` · ${e(run.note)}` : ''}</p><pre class="run-log-text" data-run-log="${e(run.id)}"></pre></details></div>`;
}

/**
 * The plan of record: how the lab reads the question, and each direction
 * with its bar and what it builds on. Before the plan, a line says that the
 * first agent writes it.
 */
function planCard(
  view: LabView,
  name: (author: string) => string,
  clock: (value: string) => string,
): string {
  const { state } = view;
  const plan = state.plan;
  if (!plan) {
    const opener = view.directions.find(
      (entry) => entry.agent.id === state.opener,
    );
    if (!opener) return '';
    return `<section class="card lab-plan" aria-labelledby="plan-title"><h2 id="plan-title">Plan of record</h2><p>${
      opener.status === 'stopped' ||
      opener.status === 'closed' ||
      opener.status === 'crashed'
        ? `${e(opener.agent.handle)} stopped before it posted a plan. Open directions yourself, or start it again.`
        : `${e(opener.agent.handle)} reads the question and posts a plan here. Work that costs nothing starts with it.`
    }</p></section>`;
  }
  const rows = plan.directions.flatMap((id) => {
    const direction = state.directions.find((entry) => entry.id === id);
    return direction
      ? [
          `<tr><th scope="row">${e(direction.title)}${direction.state === 'open' ? '' : ` <span class="fine">(${direction.state})</span>`}</th><td>${e(barSummary(direction))}</td><td>${direction.buildsOn.length ? direction.buildsOn.map((work) => `${e(work.text)} <span class="fine">(${work.known ? 'known' : 'new'})</span>`).join('<br>') : '<span class="fine">Nothing named</span>'}</td></tr>`,
        ]
      : [];
  });
  const author = state.opener ? name(state.opener) : 'The first agent';
  // A reply wakes the plan's author only while it works for the lab.
  const writer = view.directions.find(
    (entry) => entry.agent.id === state.opener,
  );
  const listening =
    writer !== undefined &&
    writer.status !== 'stopped' &&
    writer.status !== 'closed' &&
    writer.status !== 'crashed';
  const reply = !view.runs
    ? ''
    : listening
      ? `<div class="actions"><button type="button" data-action="lab-reply" data-post="${e(plan.post)}">Reply to the plan</button></div><p class="fine">A reply wakes ${e(author)}, who can change the plan.</p>`
      : `<p class="fine">${e(author)} no longer works, so the plan stays as it is.</p>`;
  return `<section class="card lab-plan" aria-labelledby="plan-title"><div class="section-title"><h2 id="plan-title">Plan of record</h2><span class="count">${e(author)}, ${e(clock(plan.at))}</span></div>
  <p class="pre">${e(plan.reading)}</p>
  <div class="table"><table><thead><tr><th scope="col">Direction</th><th scope="col">Holds up if</th><th scope="col">Builds on</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
  <p class="fine">What costs money, says ${e(author)}: ${e(plan.cost)}</p>
  ${reply}</section>`;
}

/** A span of minutes, such as "45 min" or "3 h 20 min". */
export function minutesText(minutes: number): string {
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
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
  view: LabView,
  disputed: ReadonlySet<string>,
  byId: ReadonlyMap<string, RunRecord>,
): string {
  const { runs, ledger } = view;
  const { direction, agent, status } = entry;
  const checkers = new Set(view.checks.map((check) => check.agent));
  // A check's runs show with its dispute and its rerun post, not on the row.
  const own = ledger.filter(
    (run) => run.direction === direction.id && !checkers.has(run.agent),
  );
  const shown = [
    ...own.filter(runActive),
    ...own.filter((run) => !runActive(run)).reverse(),
  ].slice(0, rowRuns);
  const experiments = shown.length
    ? `<div class="lab-runs">${shown.map((run) => runHtml(run, direction.id, runs)).join('')}${own.length > shown.length ? `<p class="fine">${own.length} runs in all. Their records are in .verifold/lab/runs/.</p>` : ''}</div>`
    : '';
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
  // The verdict that its agent gives, with its line of evidence and where the proof is.
  const verdict =
    direction.verdict === 'open'
      ? ''
      : ` <span class="chip verdict-${e(direction.verdict)}">${e(verdictWords[direction.verdict])}</span>`;
  const proof = direction.evidence
    ? view.posts.find((post) => post.id === direction.evidence?.post)
    : undefined;
  // A ruled-out verdict needs no check.
  const mark =
    proof && checkable.has(proof.kind)
      ? (checkMark(proof, view, byId) ?? 'not checked')
      : null;
  const evidence = direction.evidence
    ? `<span class="fine">${e(direction.evidence.text)} · ${e(direction.evidence.post)}${direction.evidence.run ? ` · ${e(direction.evidence.run)}` : ''}${mark ? ` · ${e(mark)}` : ''}</span>`
    : '';
  const dispute =
    direction.evidence && disputed.has(direction.evidence.post)
      ? ' <span class="chip kind-objection">Disputed</span>'
      : '';
  return `<li class="lab-direction"><div class="lab-direction-text"><strong>${e(direction.title)}${verdict}${dispute}</strong>${evidence}${direction.bar ? `<span class="fine">Holds up if ${e(barSummary(direction))}</span>` : ''}</div><span class="lab-agent">${e(agent.handle)} <span class="fine">${hostName(agent.host)}</span></span><span class="status${active ? ' active' : status === 'crashed' ? ' failed' : ''}">${e(stateOf(entry, clock).text)}</span><span class="lab-controls">${controls}</span>${experiments}${transcript}</li>`;
}

/** Characters of a post that the view shows before it folds the rest. */
const foldAt = 600;

/**
 * UTF-8 bytes of escaped post text that one board view shows in full. The
 * desk view stays under its 2 MB limit, also with long multibyte posts.
 */
const textBytes = 1_000_000;

/**
 * The text of a post. A short one shows whole and a long one shows its
 * start, with the rest folded. Every post's text counts against `budget`;
 * a post past the budget shows its start and says where the whole post is.
 */
function postText(post: Post, budget: { left: number }): string {
  const whole = e(post.text);
  const bytes = Buffer.byteLength(whole);
  if (post.text.length <= foldAt * 2 && bytes <= budget.left) {
    budget.left -= bytes;
    return `<p class="pre">${whole}</p>`;
  }
  const start = e(post.text.slice(0, foldAt));
  budget.left -= Buffer.byteLength(start);
  const head = `<p class="pre">${start}…</p>`;
  if (bytes > budget.left)
    return `${head}<p class="fine">The whole post is on the board, in .verifold/board/${e(post.id)}.json.</p>`;
  budget.left -= bytes;
  return `${head}<details><summary>Show the whole post</summary><p class="pre">${whole}</p></details>`;
}

function postHtml(
  post: Post,
  name: (author: string) => string,
  clock: (value: string) => string,
  replies: readonly Post[],
  budget: { left: number },
  view: LabView,
  ledger: ReadonlyMap<string, RunRecord>,
): string {
  const { runs } = view;
  const mark = checkable.has(post.kind) ? checkMark(post, view, ledger) : null;
  const proof = (artifact: Artifact): string => {
    const run = artifact.type === 'run' ? ledger.get(artifact.run) : undefined;
    return run
      ? `<li>${runHtml(run, post.id, false)}</li>`
      : `<li>${e(proofText(artifact))}</li>`;
  };
  const person = post.author === 'person';
  const kind =
    post.kind === 'status'
      ? ''
      : `<span class="chip kind-${post.kind}">${person && post.kind === 'question' ? 'Message' : kindWords[post.kind]}</span>`;
  return `<article class="post${post.kind === 'status' ? ' note' : ''}" id="post-${e(post.id)}"><header class="feed-head"><strong>${e(name(post.author))}</strong>${kind}<time datetime="${e(post.at)}">${e(clock(post.at))}</time>${mark ? `<span class="fine">${e(mark)}</span>` : ''}</header>${postText(post, budget)}${post.artifacts.length ? `<ul class="proof">${post.artifacts.map(proof).join('')}</ul>` : ''}${post.kind === 'status' || !runs ? '' : `<button type="button" class="quiet" data-action="lab-reply" data-post="${e(post.id)}">Reply</button>`}${replies.length ? `<div class="replies">${replies.map((reply) => postHtml(reply, name, clock, [], budget, view, ledger)).join('')}</div>` : ''}</article>`;
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
  const budget = { left: textBytes };
  const ledger = new Map(view.ledger.map((run) => [run.id, run]));
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
          postHtml(thread.root, name, clock, thread.list, budget, view, ledger),
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
  works: readonly LabWork[] = [],
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
  const disputes = openDisputes(view);
  const disputed = new Set(disputes.map((dispute) => dispute.target.id));
  const byId = new Map(view.ledger.map((run) => [run.id, run]));
  const working = renderLabWork(works, clock);
  // After the time budget, the lab goes on with more time, from Needs you: no plain Resume.
  const over = budgetEnded(state);
  const pause = !runs
    ? ''
    : state.pausedAt
      ? over
        ? ''
        : '<button type="button" data-action="lab-resume">Resume the lab</button>'
      : '<button type="button" class="quiet" data-action="lab-pause">Pause the lab</button>';
  const minutes = state.budget
    ? Math.ceil((Date.parse(state.budget.deadline) - Date.now()) / 60_000)
    : 0;
  const time = state.budget
    ? `<p class="fine lab-time">Due ${e(clock(state.budget.deadline))} · ${over ? 'the time budget ended' : `${e(minutesText(minutes))} left`}</p>`
    : '';
  const paused = !state.pausedAt
    ? ''
    : state.pausedFor === 'deadline'
      ? `<p class="notice">The time budget ended at ${e(clock(state.budget?.deadline ?? state.pausedAt))}, so the lab paused. Give it more time to go on.</p>`
      : `<p class="notice">You paused the lab at ${e(clock(state.pausedAt))}. No agent works until you resume it.${over ? ' Its time budget ended too: give it more time first.' : ''}</p>`;
  return `<div class="masthead"><h1 id="view-title" tabindex="-1">Lab</h1><p class="question">${e(state.question)}</p>${time}</div>
  <div class="view lab">
  ${runs ? '' : '<p class="notice">This desk runs one session, so it only shows the lab. Run verifold in the project folder to work in the lab.</p>'}${paused}${working}${needs}
  ${disputesCard(view, disputes, name, slot)}
  ${planCard(view, name, clock)}
  <section class="card" aria-labelledby="directions-title"><div class="section-title"><h2 id="directions-title">Directions</h2><span class="actions">${pause}</span></div>
  ${view.directions.length ? `<ul class="lab-directions">${view.directions.map((entry) => directionRow(entry, clock, slot, view, disputed, byId)).join('')}</ul>` : '<p class="empty-note">No direction yet. Open one below: each direction gets its own agent and its own copy of the project.</p>'}
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

/** Home's offer to start a lab, for a project with no team at work. */
export function renderLabStart(topic: string | undefined): string {
  return `<section class="card lead" aria-labelledby="lab-start-title"><h2 id="lab-start-title">Start the lab</h2><p>Several agents work on your question at the same time. Each one owns a direction in its own copy of the project. They post what they find on one board, with proof, and check each other's claims.</p>
  <label class="field" for="lab-question">Your question</label><textarea id="lab-question" rows="2" maxlength="4000">${e(topic ?? '')}</textarea>
  <label class="field" for="lab-hours">Time budget, in hours</label><input id="lab-hours" type="number" min="1" max="${labLimits.hours}" value="${defaultLabHours}">
  <div class="actions"><button type="button" class="primary" data-action="lab-start">Start the lab</button></div><p class="fine">The first agent reads your question and posts a plan. Work that costs nothing starts at once. You change the plan by replying to it. When the time budget ends, the lab pauses.</p></section>`;
}

/** Needs you: the time budget ended. The person gives more time, and the lab goes on. */
export function labBudgetNeed(view: LabView): {
  readonly key: string;
  readonly title: string;
  readonly why: string;
  readonly since: string | null;
  readonly body: string;
} | null {
  const { state } = view;
  // Also a lab that the person paused: more time keeps it paused until they resume it.
  if (!view.runs || !state.budget || !budgetEnded(state)) return null;
  const deadline = state.budget.deadline;
  const button = (count: number, primary: boolean): string =>
    `<button type="button"${primary ? ' class="primary"' : ''} data-action="lab-budget" data-hours="${count}">Give ${count} more ${count === 1 ? 'hour' : 'hours'}</button>`;
  return {
    key: `lab-budget:${deadline}`,
    title: 'The time budget ended',
    why:
      state.pausedFor === 'person'
        ? 'You paused the lab, and its time budget ended too. Give it more time, then resume it.'
        : 'No turn starts after the end of the time budget. Only you give the lab more time.',
    since: deadline,
    body: `<div class="actions">${button(2, true)}${button(defaultLabHours, false)}</div>`,
  };
}
