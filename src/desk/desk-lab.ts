import { escapeHtml as e } from '../ui/dom.ts';
import {
  clip,
  number,
  type Artifact,
  type Post,
  type PostKind,
} from '../core/board.ts';
import {
  askers,
  barSummary,
  bringGroups,
  budgetEnded,
  defaultLabHours,
  labEnded,
  labLimits,
  nameList,
  stands,
  type BringList,
  type Call,
  type CallEffect,
  type CallOption,
  type Check,
  type DirectionView,
  type LabView,
  type Verdict,
} from '../core/lab.ts';
import { usd } from '../core/leases.ts';
import {
  authorName,
  callWords,
  counted,
  kindLabel,
  verdictText,
} from '../core/lab-words.ts';
import {
  callSearchText,
  callState,
  searchLab,
  searchLimit,
  searchNote,
  searchTextBytes,
  searchWords,
  snippetParts,
  snippetWidth,
  type SearchHit,
} from '../core/search.ts';
import {
  awayCounts,
  awayLines,
  awayNews,
  type Away,
  type AwayLine,
} from '../core/away.ts';
import { openDisputes } from '../core/disputes.ts';
import { searchQueryLimit } from '../protocol/api.ts';
import { callLimits, checkableKinds } from '../core/lab-tools.ts';
import {
  metricsText,
  placeText,
  runActive,
  runSummary,
  type RunRecord,
} from '../core/runs.ts';
import type { HarnessName } from '../core/harness.ts';
import { hostName } from '../core/session.ts';
import { workspaceName, type ChangedFile } from '../core/workspaces.ts';
import {
  andList,
  costWords,
  effectWords,
  minutesText,
  undoWords,
  type EffectWords,
} from '../ui/call-words.ts';

export { minutesText };

/**
 * The lab's screen in the desk. One header line, one Needs-you line, one row
 * for each direction, and the board as threads by direction, with one
 * message box. Depth opens in the side panel from a row or a post: a run, a
 * direction's diff, or an agent. Every agent text is escaped.
 */

/** A lab action that runs in the background, or why it failed. The lab view shows it. */
export interface LabWork {
  /** The desk action, such as lab-direction-add. */
  readonly action: string;
  readonly label: string;
  readonly at: string;
  readonly error: string | null;
  /** The call that an answer or an undo is for. */
  readonly call?: string;
  /** The option that an answer picked. */
  readonly option?: number;
  /** The direction that the action is for, such as a bring-in's. */
  readonly direction?: string;
}

/** One thing that waits for the person, in the order of the Needs-you line. `body` is HTML. */
export interface LabNeed {
  readonly key: string;
  readonly title: string;
  readonly why: string;
  readonly body: string;
}

/** What the side panel shows. `sub` and `body` are HTML, already escaped. */
export interface Panel {
  readonly kind: string;
  readonly title: string;
  readonly sub: string;
  readonly body: string;
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

/** The mark of a row's verdict. It is decoration: the word beside it says the verdict. */
const verdictMarks: Record<Verdict | 'disputed', string> = {
  open: '○',
  leading: '↗',
  'holds-up': '✓',
  'ruled-out': '×',
  disputed: '⚠',
};

/** The posts that the view shows. Older ones stay on the board and in the agents' digests. */
const shownPosts = 120;

/** The posts that the board shows: the newest, and the plan of record after newer posts push it out. */
function boardPosts(view: LabView): readonly Post[] {
  const newest = view.posts.slice(-shownPosts);
  const plan = view.posts.find((post) => post.id === view.state.plan?.post);
  return plan && !newest.includes(plan) ? [plan, ...newest] : newest;
}

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
    case 'terminal':
      return { text: 'You hold its terminal', face: 'working' };
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

/**
 * A round mark with the initials of an agent's harness, which names the
 * harness to a screen reader. The person's and Verifold's marks are
 * decoration: the name beside them says who it is.
 */
function who(host: HarnessName | 'person' | 'verifold'): string {
  if (host === 'claude' || host === 'codex')
    return `<span class="who who-${host}" role="img" aria-label="${hostName(host)}" title="${hostName(host)}">${host === 'claude' ? 'Cl' : 'Cx'}</span>`;
  return `<span class="who who-${host}" aria-hidden="true">${host === 'person' ? 'You' : 'V'}</span>`;
}

/** The kinds of post that a check can test, when they cite a run. */
const checkable: ReadonlySet<PostKind> = new Set(checkableKinds);

/**
 * How a check tested a post, in a few words, or null when no check did: a
 * check that waits or runs first, then the newest that ended: "reran r-9
 * (Codex): acc=0.7", "did not hold on r-9", "read the code only", or one
 * that failed. A checker that could read the lab's records says so.
 */
export function checkMark(
  post: Post,
  view: LabView,
  ledger: ReadonlyMap<string, RunRecord>,
): string | null {
  const checks = view.checks.filter(
    (check) => check.claim === post.id && check.state !== 'dropped',
  );
  const open = checks.find(
    (check) => check.state === 'queued' || check.state === 'running',
  );
  if (open)
    return open.state === 'running'
      ? `${open.handle} checks it`
      : `check ${open.id} waits`;
  const done = checks.filter((check) => check.state === 'done').at(-1);
  if (done) {
    const result = view.posts.find((entry) => entry.id === done.result);
    const runs = (result?.artifacts ?? []).flatMap((artifact) => {
      const run =
        artifact.type === 'run' ? ledger.get(artifact.run) : undefined;
      return run?.agent === done.agent ? [run] : [];
    });
    const ids = runs.map((run) => run.id).join(', ') || done.run;
    const who = `${hostName(done.harness)}${done.sameHarness ? ', same harness' : ''}${done.blind ? '' : ', the checker could read project records'}`;
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
  if (checks.some((check) => check.state === 'failed')) return 'check failed';
  return null;
}

/** Where a dispute's check is, in a few words. */
function checkWhere(check: Check | null): string {
  if (!check) return 'No check yet.';
  if (check.state === 'failed')
    return `Check ${check.id} failed: ${check.note ?? 'no reason'} Another objection starts a new check.`;
  return check.state === 'running'
    ? `${check.handle} (${hostName(check.harness)}) checks it now, without the author's reasoning.`
    : `Check ${check.id} waits for ${check.handle} (${hostName(check.harness)}).`;
}

/**
 * Open disputes, pinned at the top of the board: each disputed post, its
 * doubts, where its check is, and a link to the row that rests on it.
 */
function pinnedDisputes(
  view: LabView,
  open: ReturnType<typeof openDisputes>,
  name: (author: string) => string,
): string {
  if (!open.length) return '';
  return `<ul class="lab-pinned" aria-label="Open disputes">${open
    .map(({ objections, target, check }) => {
      const row = view.state.directions.find(
        (entry) => entry.evidence?.post === target.id,
      );
      const doubt = objections[0];
      const runs = check
        ? view.ledger.filter((run) => run.agent === check.agent)
        : [];
      return `<li><span class="verdict v-disputed"><span aria-hidden="true">⚠</span> Disputed</span><div class="pinned-text"><p><a href="#post-${e(target.id)}">${e(target.id)}</a> by ${e(name(target.author))}${row ? `, the evidence of <a href="#row-${e(row.id)}">${e(row.title)}</a>` : ''}: ${e(clip(target.text, 140))}</p>${doubt ? `<p class="fine">${e(name(doubt.author))} objects: ${e(clip(doubt.text, 140))}${objections.length > 1 ? ` (and ${objections.length - 1} more)` : ''}</p>` : ''}<p class="fine">${e(checkWhere(check))}${runs.map((run) => ` ${runButton(run)}`).join('')}${check?.session && check.state !== 'queued' ? ` <button type="button" class="link" data-panel="agent" data-agent="${e(check.agent)}" data-open-pane="summary">What ${e(check.handle)} did</button>` : ''}</p></div></li>`;
    })
    .join('')}</ul>`;
}

/** A run as a small button that opens it in the panel: its ID, state, and first metric. */
function runButton(run: RunRecord): string {
  const metric = metricsText(run, 1);
  return `<button type="button" class="proof run-${e(run.status)}" data-panel="run" data-run="${e(run.id)}">${e(run.id)}${runActive(run) ? ' · running' : metric ? ` · ${e(metric)}` : ` · ${e(runSummary(run))}`}</button>`;
}

/**
 * The proof of a post: a run, or the diff that the post cites, opens in the
 * panel, and a file or a figure names its path.
 */
function proofHtml(
  artifact: Artifact,
  index: number,
  ledger: ReadonlyMap<string, RunRecord>,
  post: Post,
): string {
  switch (artifact.type) {
    case 'run': {
      const run = ledger.get(artifact.run);
      return run
        ? runButton(run)
        : `<span class="proof">${e(artifact.run)}</span>`;
    }
    case 'diff': {
      const where = artifact.direction ?? post.direction;
      const label = `diff · ${clip(artifact.paths.join(', '), 60)}`;
      return where
        ? `<button type="button" class="proof" data-panel="diff" data-lab-direction="${e(where)}" data-proof="${e(post.id)}.${index}">${e(label)}</button>`
        : `<span class="proof">${e(label)}</span>`;
    }
    case 'file':
    case 'figure':
      return `<span class="proof" title="${e(`${artifact.path} at ${artifact.commit.slice(0, 7)}${artifact.direction ? ` in ${artifact.direction}` : ''}`)}">${e(artifact.type)} · ${e(clip(artifact.path, 60))}</span>`;
  }
}

/** Runs that a direction's open row shows: those that run now, then the newest. */
const rowRuns = 3;

/**
 * One direction's row: its verdict, its title with one line of evidence, its
 * agent, and its check or state. The row opens in place to its runs and its
 * controls. Its depth (the agent, the diff, a run) opens in the panel.
 */
function directionRow(
  entry: DirectionView,
  clock: (value: string) => string,
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
  const mark = evidenceMark(direction, view, byId);
  const dispute =
    direction.evidence !== null && disputed.has(direction.evidence.post);
  const state = stateOf(entry, clock);
  // A state that needs attention comes before the check.
  const loud =
    status === 'crashed' ||
    status === 'usage' ||
    status === 'terminal' ||
    status === 'stopped' ||
    status === 'closed';
  const right = loud || !mark ? state.text : mark;
  const line = evidenceLine(direction);
  const open = direction.state === 'open';
  const controls = [
    runs && open
      ? `<button type="button" data-lab-mention="@${e(agent.handle)}">Message</button>`
      : '',
    `<button type="button" data-panel="agent" data-agent="${e(agent.id)}" data-open-pane="summary">What ${e(agent.handle)} did</button>`,
    `<button type="button" data-panel="diff" data-lab-direction="${e(direction.id)}">Diff</button>`,
    runs && open && agent.session
      ? `<button type="button" data-panel="agent" data-agent="${e(agent.id)}" data-open-pane="terminal">Terminal</button>`
      : '',
    runs && status === 'crashed'
      ? `<button type="button" class="primary" data-action="lab-agent-restart" data-agent="${e(agent.id)}">Start again</button>`
      : '',
    runs
      ? `<button type="button" data-panel="bring" data-lab-direction="${e(direction.id)}">Bring in</button>`
      : '',
    runs && open
      ? `<button type="button" class="quiet" data-action="lab-direction-stop" data-lab-direction="${e(direction.id)}" data-confirm="Click again to stop this direction">Stop</button>`
      : '',
  ].join('');
  const facts = [
    direction.evidence && direction.bar
      ? `<p class="fine">Holds up if ${e(barSummary(direction))}</p>`
      : '',
    mark && right !== mark ? `<p class="fine">Check: ${e(mark)}</p>` : '',
    shown.length
      ? `<p class="row-runs">${shown.map(runButton).join(' ')}${own.length > shown.length ? ` <span class="fine">${own.length} runs in all</span>` : ''}</p>`
      : '',
  ].join('');
  return `<li class="lab-row${dispute ? ' disputed' : ''}" id="row-${e(direction.id)}"><details id="row-open-${e(direction.id)}"><summary>${verdictChip(direction.verdict, dispute)}<span class="row-main"><strong>${e(direction.title)}</strong>${line ? `<span class="row-line">${e(line)}</span>` : ''}</span><span class="row-who">${who(agent.host)}<span class="row-handle">${e(agent.handle)}</span></span><span class="row-state${status === 'crashed' ? ' failed' : status === 'working' || status === 'starting' ? ' active' : ''}">${e(right)}</span></summary><div class="row-more">${facts}<div class="actions">${controls}</div></div></details></li>`;
}

/** A direction's verdict as a chip: a mark and its word. */
function verdictChip(verdict: Verdict, disputed: boolean): string {
  return `<span class="verdict v-${disputed ? 'disputed' : e(verdict)}"><span aria-hidden="true">${verdictMarks[disputed ? 'disputed' : verdict]}</span> ${verdictText(verdict, disputed)}</span>`;
}

/** A direction's one line under its title: its evidence with the post and run, or its bar. */
function evidenceLine(direction: DirectionView['direction']): string {
  return direction.evidence
    ? `${direction.evidence.text} · ${direction.evidence.post}${direction.evidence.run ? ` · ${direction.evidence.run}` : ''}`
    : direction.bar
      ? `Holds up if ${barSummary(direction)}`
      : '';
}

/**
 * How a check tested a direction's evidence, "not checked", or null when
 * the verdict needs no check, as a ruled-out verdict.
 */
function evidenceMark(
  direction: DirectionView['direction'],
  view: LabView,
  byId: ReadonlyMap<string, RunRecord>,
): string | null {
  const proof = direction.evidence
    ? view.posts.find((post) => post.id === direction.evidence?.post)
    : undefined;
  return proof && checkable.has(proof.kind)
    ? (checkMark(proof, view, byId) ?? 'not checked')
    : null;
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
  return `${head}<details id="whole-${e(post.id)}"><summary>Show the whole post</summary><p class="pre">${whole}</p></details>`;
}

/** A web address as a link with its host and path. Text that is not an http(s) address stays text. */
export function link(address: string): string {
  try {
    const url = new URL(address);
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error();
    const shown = `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
    return `<a href="${e(url.href)}" target="_blank" rel="noopener noreferrer">${e(shown.length > 80 ? `${shown.slice(0, 80)}…` : shown)}</a>`;
  } catch {
    return `<span>${e(address)}</span>`;
  }
}

/** The plan of record under its post: each direction with its bar and what it builds on. */
function planTable(view: LabView, name: (author: string) => string): string {
  const plan = view.state.plan;
  if (!plan) return '';
  const rows = plan.directions.flatMap((id) => {
    const direction = view.state.directions.find((entry) => entry.id === id);
    return direction
      ? [
          `<tr><th scope="row">${e(direction.title)}${direction.state === 'open' ? '' : ` <span class="fine">(${direction.state})</span>`}</th><td>${e(barSummary(direction)) || '<span class="fine">No bar</span>'}</td><td>${direction.buildsOn.length ? direction.buildsOn.map((work) => `${e(work.text)} <span class="fine">(${work.known ? 'known' : 'new'})</span>`).join('<br>') : '<span class="fine">Nothing named</span>'}</td></tr>`,
        ]
      : [];
  });
  const author = view.state.opener
    ? name(view.state.opener)
    : 'The first agent';
  // A reply wakes the plan's author only while it works for the lab.
  const writer = view.directions.find(
    (entry) => entry.agent.id === view.state.opener,
  );
  const listening =
    writer !== undefined &&
    writer.status !== 'stopped' &&
    writer.status !== 'closed' &&
    writer.status !== 'crashed';
  // Each fact shows its source and date, so the person sees what is current and what nobody checked.
  const facts = plan.facts.length
    ? `<p class="fine">Facts that the plan rests on:</p><ul class="plan-facts">${plan.facts.map((fact) => `<li>${e(fact.claim)} <span class="fine">· ${fact.source ? `${link(fact.source)}${fact.sourceDate ? `, ${e(fact.sourceDate)}` : ''}` : 'unverified (no source)'}</span></li>`).join('')}</ul>`
    : '';
  return `<div class="table plan-table"><table><thead><tr><th scope="col">Direction</th><th scope="col">Holds up if</th><th scope="col">Builds on</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>${facts}<p class="fine">What costs money, says ${e(author)}: ${e(plan.cost)} ${listening ? `Reply to change the plan. A reply wakes ${e(author)}.` : `${e(author)} no longer works, so the plan stays as it is.`}</p>`;
}

function postHtml(
  post: Post,
  name: (author: string) => string,
  host: (author: string) => HarnessName | 'person' | 'verifold',
  clock: (value: string) => string,
  replies: readonly Post[],
  budget: { left: number },
  view: LabView,
  ledger: ReadonlyMap<string, RunRecord>,
): string {
  const { runs } = view;
  const mark = checkable.has(post.kind) ? checkMark(post, view, ledger) : null;
  const note = post.kind === 'status';
  const kind = note
    ? ''
    : ` <span class="chip kind-${post.kind}">${kindLabel(post)}</span>`;
  const plan =
    post.kind === 'plan' && view.state.plan?.post === post.id
      ? planTable(view, name)
      : '';
  const proofs = post.artifacts.length
    ? `<p class="proofs">${post.artifacts.map((artifact, index) => proofHtml(artifact, index, ledger, post)).join(' ')}</p>`
    : '';
  const reply =
    note || !runs
      ? ''
      : `<button type="button" class="link reply" data-action="lab-reply" data-post="${e(post.id)}">Reply</button>`;
  return `<article class="post${note ? ' note' : ''}" id="post-${e(post.id)}" tabindex="-1">${who(host(post.author))}<div class="post-body"><header class="post-head"><strong>${e(name(post.author))}</strong>${kind} <time datetime="${e(post.at)}">${e(clock(post.at))}</time>${mark ? ` <span class="post-mark">${e(mark)}</span>` : ''}</header>${postText(post, budget)}${plan}${proofs}${reply}${replies.length ? `<div class="replies">${replies.map((entry) => postHtml(entry, name, host, clock, [], budget, view, ledger)).join('')}</div>` : ''}</div></article>`;
}

/**
 * The board as threads: one group for each direction and one for posts
 * without a direction. The group and the thread with the newest activity,
 * replies included, come first. A reply shows under the post that it answers.
 */
function board(
  view: LabView,
  name: (author: string) => string,
  host: (author: string) => HarnessName | 'person' | 'verifold',
  clock: (value: string) => string,
): string {
  const budget = { left: textBytes };
  const ledger = new Map(view.ledger.map((run) => [run.id, run]));
  const posts = boardPosts(view);
  if (!posts.length) {
    const opener = view.directions.find(
      (entry) => entry.agent.id === view.state.opener,
    );
    const ended =
      opener?.status === 'stopped' ||
      opener?.status === 'closed' ||
      opener?.status === 'crashed';
    return `<p class="empty-note">${!opener ? 'No posts yet. Agents post what they find here, with proof.' : ended ? `${e(opener.agent.handle)} stopped before it posted a plan. Open a direction yourself, or start it again.` : `${e(opener.agent.handle)} reads the question and posts a plan here. Work that costs nothing starts with it.`}</p>`;
  }
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
        : 'The whole lab';
      return `<section class="lab-thread" aria-label="${e(title)}"><h3>${key ? `<a href="#row-${e(key)}">${e(title)}</a>` : e(title)}</h3>${group.ids
        .flatMap((id) => {
          const thread = threads.get(id);
          return thread ? [thread] : [];
        })
        .sort((a, b) => b.latest - a.latest)
        .map((thread) =>
          postHtml(
            thread.root,
            name,
            host,
            clock,
            thread.list,
            budget,
            view,
            ledger,
          ),
        )
        .join('')}</section>`;
    })
    .join('');
}

/** GPU dollars from Compute: spent so far, and the limit when the person set one. */
export interface LabGpu {
  readonly spent: number;
  readonly limit: number | null;
}

/**
 * The header's money line. Claude Code reports its own cost estimate, and
 * the pods' cost is what the leases billed; the total adds both. Codex
 * reports no cost.
 */
export function costLine(view: LabView, gpu: LabGpu | null): string {
  const claude = view.claudeUsd;
  const pods = gpu?.spent ?? 0;
  const parts = [
    `Claude Code ≈${usd(claude)}`,
    gpu
      ? `GPU ${usd(pods)}${gpu.limit === null ? '' : ` of ${usd(gpu.limit)}`}`
      : '',
  ].filter(Boolean);
  return `≈${usd(claude + pods)} spent (${parts.join(', ')}) · Codex usage not counted`;
}

/** The day of the lab by the calendar of this computer: day 1 is the day that it started. */
function labDay(startedAt: string): number {
  const start = new Date(startedAt);
  start.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Round: a day with a clock change has 23 or 25 hours.
  return Math.max(
    1,
    Math.round((today.getTime() - start.getTime()) / 86_400_000) + 1,
  );
}

/** An ID for an element from a key, such as lab-call:c-3. */
function idOf(key: string): string {
  return key.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * The Needs-you line: the first thing that waits for the person, which
 * opens in place, and how many more wait. Without any, one quiet line says so.
 */
function needsLine(needs: readonly LabNeed[]): string {
  const [first, ...rest] = needs;
  if (!first)
    return '<p class="lab-needs none" role="status"><span aria-hidden="true">✓</span> Nothing needs you.</p>';
  const call = first.key.startsWith('lab-call:');
  return `<section class="lab-needs" aria-label="Needs you"><details id="need-${e(idOf(first.key))}"${call ? ' data-lab-call' : ''}><summary><span class="needs-label">Needs you</span><span class="needs-title">${e(first.title)}</span><span class="decide" aria-hidden="true">Decide</span></summary><div class="needs-body"><p class="fine">${e(first.why)}</p>${first.body}${call ? '<p class="fine">Or press the number of an option.</p>' : ''}</div></details>${rest.length ? `<p class="needs-more"><button type="button" class="link" data-view="needs">${rest.length} more ${rest.length === 1 ? 'thing needs' : 'things need'} you</button></p>` : ''}</section>`;
}

/**
 * Home for a lab. `clock` formats a time. `needs` waits for the person, in
 * the order of the Needs-you line. `gpu` is the pods' spend from Compute.
 */
export function renderLab(
  view: LabView,
  clock: (value: string) => string,
  options: {
    readonly needs?: readonly LabNeed[];
    readonly works?: readonly LabWork[];
    readonly gpu?: LabGpu | null;
    /** More of Home, such as sessions that an earlier owner paused. */
    readonly extra?: string;
    /** The person comes back after a while: Home says what changed. */
    readonly away?: Away | null;
  } = {},
): string {
  const { state } = view;
  const hosts = new Map<string, HarnessName>([
    ...view.directions.map(
      (entry) => [entry.agent.id, entry.agent.host] as const,
    ),
    ...view.checks.map((check) => [check.agent, check.harness] as const),
  ]);
  const name = (author: string): string => authorName(view, author);
  const host = (author: string): HarnessName | 'person' | 'verifold' =>
    author === 'person' ? 'person' : (hosts.get(author) ?? 'verifold');
  const { runs } = view;
  const disputes = openDisputes(view);
  const disputed = new Set(disputes.map((dispute) => dispute.target.id));
  const byId = new Map(view.ledger.map((run) => [run.id, run]));
  // After the time budget, the lab goes on with more time, from Needs you: no plain Resume.
  const over = budgetEnded(state);
  const pause = !runs
    ? ''
    : state.pausedAt
      ? over
        ? ''
        : '<button type="button" data-action="lab-resume">Resume</button>'
      : '<button type="button" data-action="lab-pause">Pause</button>';
  const due = state.budget
    ? ` · Due <strong>${e(clock(state.budget.deadline))}</strong>${over ? ', the time budget ended' : ''}`
    : '';
  // Needs you asks for more time with a call. Without one, as after "Stop here", the notice gives more time.
  const asked = state.calls.some(
    (call) =>
      call.state === 'open' &&
      call.options.some((option) => option.effect?.type === 'hours'),
  );
  const more =
    runs && over && !asked
      ? ` <span class="actions">${[2, defaultLabHours].map((count) => `<button type="button" data-action="lab-budget" data-hours="${count}">Give ${count} more hours</button>`).join('')}</span>`
      : '';
  const paused = !state.pausedAt
    ? ''
    : state.pausedFor === 'deadline'
      ? `<p class="notice">The time budget ended at ${e(clock(state.budget?.deadline ?? state.pausedAt))}, so the lab paused.${more}</p>`
      : `<p class="notice">You paused the lab at ${e(clock(state.pausedAt))}. No agent works until you resume it.${over ? ` Its time budget ended too: give it more time first.${more}` : ''}</p>`;
  const open = view.directions.filter(
    (entry) => entry.direction.state === 'open',
  );
  const gpu = options.gpu ?? null;
  return `<div class="lab-screen">
  <header class="lab-head"><div class="lab-head-text"><h1 id="view-title" tabindex="-1">${e(state.question)}</h1><p class="lab-facts">Day ${labDay(state.startedAt)}${due} · ${e(costLine(view, gpu))}</p></div><span class="actions">${searchButton}<button type="button" class="quiet" data-panel="answer">Answer</button>${pause}</span></header>
  ${runs ? '' : '<p class="notice">This desk runs one session, so it only shows the lab. Run verifold in the project folder to work in the lab.</p>'}${endedLine(view, clock)}${paused}${renderLabWork(options.works ?? [], clock)}
  ${options.away ? awayDigest(view, options.away, gpu, disputed, clock) : ''}${needsLine(options.needs ?? [])}${undoLines(view)}${options.extra ?? ''}
  <section class="lab-section" aria-labelledby="directions-title"><h2 id="directions-title" class="lab-label">Directions</h2>
  ${view.directions.length ? `<ul class="lab-rows">${view.directions.map((entry) => directionRow(entry, clock, view, disputed, byId)).join('')}</ul>` : '<p class="empty-note">No direction yet. The plan opens them, or you open one yourself.</p>'}
  ${runs ? addForm() : ''}</section>
  <section class="lab-section" aria-labelledby="board-title"><h2 id="board-title" class="lab-label">Board</h2>${pinnedDisputes(view, disputes, name)}${board(view, name, host, clock)}</section>
  ${runs ? composeBox(view, open) : ''}
  </div>`;
}

/** The form that opens a direction, folded: agents open most directions with the plan. */
function addForm(): string {
  return `<details id="lab-add" class="lab-add"><summary>Open a direction yourself</summary>
  <label class="field" for="lab-title">Title</label><input id="lab-title" type="text" maxlength="120" placeholder="Years wind on a helix">
  <label class="field" for="lab-harness">Agent</label><select id="lab-harness"><option value="claude">Claude Code</option><option value="codex">Codex</option></select>
  <label class="field" for="lab-bar">Holds up if (optional)</label><input id="lab-bar" type="text" maxlength="280" placeholder="it beats a circle for years on 3 seeds">
  <div class="actions"><button type="button" class="primary" data-action="lab-direction-add">Open the direction</button></div></details>`;
}

/**
 * The one message box. `@claude-1` wakes that agent, `@d-2` writes in that
 * direction, and `@all` wakes every agent. The list under it completes the
 * names.
 */
function composeBox(view: LabView, open: readonly DirectionView[]): string {
  const names = [
    ...open.map((entry) => ({
      value: `@${entry.agent.handle}`,
      note: `${hostName(entry.agent.host)}, ${entry.direction.title}`,
    })),
    ...open.map((entry) => ({
      value: `@${entry.direction.id}`,
      note: entry.direction.title,
    })),
    { value: '@all', note: 'Every agent' },
  ];
  return `<section class="lab-compose" aria-label="Write to the lab">
  <p class="lab-replying" id="lab-replying" hidden><span id="lab-reply-note"></span><button type="button" class="link" data-action="lab-reply-clear" aria-label="Stop replying">×</button></p>
  <div class="compose-row"><textarea id="lab-text" rows="1" maxlength="4000" aria-label="Message to the lab" placeholder="Reply or @mention" aria-autocomplete="list" aria-controls="lab-mentions" aria-describedby="lab-compose-note"></textarea><button type="button" class="primary" data-action="lab-post">Send</button></div>
  <input id="lab-reply" type="hidden" value="">
  <ul id="lab-mentions" class="mentions" role="listbox" aria-label="Names" hidden>${names.map((entry, index) => `<li role="option" id="mention-${index}" data-value="${e(entry.value)}" aria-selected="false"><strong>${e(entry.value)}</strong> <span class="fine">${e(clip(entry.note, 60))}</span></li>`).join('')}</ul>
  <p class="fine" id="lab-compose-note">${view.directions.length ? 'A message to nobody wakes every agent.' : 'Agents read your messages once their directions open.'}</p></section>`;
}

/** Home's offer to start a lab, for a project with no team at work. */
export function renderLabStart(topic: string | undefined): string {
  return `<section class="card lead" aria-labelledby="lab-start-title"><h2 id="lab-start-title">Start the lab</h2><p>Several agents work on your question at the same time. Each one owns a direction in its own copy of the project. They post what they find on one board, with proof, and check each other's claims.</p>
  <label class="field" for="lab-question">Your question</label><textarea id="lab-question" rows="2" maxlength="4000">${e(topic ?? '')}</textarea>
  <label class="field" for="lab-hours">Time budget, in hours</label><input id="lab-hours" type="number" min="1" max="${labLimits.hours}" value="${defaultLabHours}">
  <div class="actions"><button type="button" class="primary" data-action="lab-start">Start the lab</button></div><p class="fine">The first agent reads your question and posts a plan. Work that costs nothing starts at once. You change the plan by replying to it. When the time budget ends, the lab pauses.</p></section>`;
}

/** The host of a lab agent, from the lab's view. */
function hostOf(view: LabView, agent: string): string | null {
  return (
    view.directions.find((entry) => entry.agent.id === agent)?.agent.host ??
    null
  );
}

/** A call effect, as the shared call words take it. The desk names a direction by its ID. */
function wordsOf(effect: CallEffect): EffectWords {
  switch (effect.type) {
    case 'pod':
      return { type: 'pod', gpu: effect.gpuType, hours: effect.hours };
    case 'hours':
      return { type: 'hours', hours: effect.hours };
    case 'open':
      return { type: 'open', title: effect.title, harness: effect.harness };
    case 'stop':
      return { type: 'stop', direction: effect.direction };
    case 'domains':
      return { type: 'domains', domains: effect.domains };
  }
}

/**
 * What an effect does and what an undo does, in the words that the desk and
 * the app share (src/ui/call-words.ts). Each agent that asked is named, and
 * a Codex agent's shell is said to reach any website.
 */
function effectLines(
  effect: CallEffect,
  call: Call,
  view: LabView,
): { readonly does: string; readonly undo: string } {
  return effectWords(
    wordsOf(effect),
    call.direction,
    askers(call).map((id) => ({
      handle: view.handles[id] ?? id,
      codex: hostOf(view, id) === 'codex',
    })),
  );
}

/** One option of a call: a large button with its dollars and minutes, and a line on what it does. */
function optionHtml(
  call: Call,
  option: CallOption,
  index: number,
  view: LabView,
  stored: readonly string[] | null,
): string {
  const lines = option.effect ? effectLines(option.effect, call, view) : null;
  // A pod whose secret is not stored cannot start: the person adds it first.
  const missing =
    option.effect?.type === 'pod' && stored
      ? option.effect.secrets.filter((name) => !stored.includes(name))
      : [];
  const facts = costWords(option.usd, option.minutes);
  const pick = call.pick === index;
  return `<li><button type="button" class="call-option${pick ? ' picked' : ''}" data-action="lab-call-answer" data-call="${e(call.id)}" data-option="${index}"><span class="option-label"><span class="key" aria-hidden="true">${index + 1}</span> ${e(option.label)}</span>${facts ? `<span class="option-facts">${e(facts)}</span>` : ''}${pick ? '<span class="pick">The agents\' pick</span>' : ''}</button>${lines ? `<p class="fine">${e(lines.does)} ${e(lines.undo)}</p>` : ''}${missing.length ? `<p class="fine">Needs ${e(missing.join(' and '))} in Compute first.</p>` : ''}</li>`;
}

/** The effect of the agents' pick, which the undo line describes before an answer. */
function pickEffect(call: Call): EffectWords | null {
  const effect =
    call.pick === null ? null : (call.options[call.pick]?.effect ?? null);
  return effect ? wordsOf(effect) : null;
}

/**
 * Needs you: each open call of the lab, with its options, their cost and
 * time, the agents' pick and why. Every agent text is escaped. The answer
 * applies at once and can be undone for a while. `stored` names the pod
 * secrets that this computer stores, when Compute is known.
 */
export function labCallNeeds(
  view: LabView,
  stored: readonly string[] | null = null,
): {
  readonly key: string;
  readonly kind: string;
  readonly title: string;
  readonly why: string;
  readonly since: string | null;
  readonly body: string;
}[] {
  if (!view.runs) return [];
  return view.state.calls
    .filter((call) => call.state === 'open')
    .map((call) => {
      const asker =
        call.by === 'verifold'
          ? 'Verifold'
          : (view.handles[call.by] ?? call.by);
      const about = view.state.directions.find(
        (entry) => entry.id === call.direction,
      );
      const same = call.joined.map(
        (asker) => view.handles[asker.agent] ?? asker.agent,
      );
      const words = `lab-call-words-${call.id}`;
      return {
        key: `lab-call:${call.id}`,
        kind: callWords[call.kind],
        title: call.question,
        why: `${asker} asks${about ? `, for ${about.title}` : ''} (${call.id}).${same.length ? ` ${andList(same)} ${same.length === 1 ? 'asks' : 'ask'} the same.` : ''}`,
        since: call.at,
        body: `<p class="call-why">${call.pick === null ? `${e(asker)} says: ` : `Why ${e(asker)} picks it: `}${e(call.why)}</p>
  <ul class="call-options">${call.options.map((option, index) => optionHtml(call, option, index, view, stored)).join('')}</ul>
  <p class="fine">${e(undoWords(call.undoMinutes, pickEffect(call)))}</p>
  ${call.by === 'verifold' && call.words ? '<p class="fine" role="status">Your words went to the lab. Pick an option to give it more time or end it.</p>' : ''}<div class="call-words"><label class="field" for="${e(words)}">Or tell them what to do instead</label><textarea id="${e(words)}" rows="2" maxlength="${callLimits.words}"></textarea><div class="actions"><button type="button" data-action="lab-call-words" data-call="${e(call.id)}">Send answer</button></div></div>`,
      };
    });
}

/** The answers that the person can still undo, with the minutes left. */
function undoLines(view: LabView): string {
  if (!view.runs) return '';
  const now = Date.now();
  return view.state.calls
    .flatMap((call) => {
      const option = call.answer ? call.options[call.answer.option] : undefined;
      if (
        call.state !== 'answered' ||
        !call.undoUntil ||
        !option ||
        Date.parse(call.undoUntil) <= now
      )
        return [];
      const left = Math.ceil((Date.parse(call.undoUntil) - now) / 60_000);
      const undo = `${option.effect ? `${effectLines(option.effect, call, view).undo} ` : ''}Then the call asks again.`;
      return [
        `<p class="lab-undo" role="status">You chose "${e(option.label)}" on ${e(call.id)}. <button type="button" class="link" data-action="lab-call-undo" data-call="${e(call.id)}">Undo</button> <span class="fine">${e(minutesText(left))} left. ${e(undo)}</span></p>`,
      ];
    })
    .join('');
}

/** A run in full, in the panel: its command, commit, place, state, metrics, outputs, and its log. */
export function runPanel(
  view: LabView,
  id: string | undefined,
  clock: (value: string) => string,
): Panel {
  const run = view.ledger.find((entry) => entry.id === id);
  if (!run)
    return {
      kind: 'Run',
      title: 'No such run',
      sub: '',
      body: '<p class="empty-note">This run is not in the lab, for example after Start over.</p>',
    };
  const by = view.handles[run.agent] ?? run.agent;
  const direction = view.state.directions.find(
    (entry) => entry.id === run.direction,
  );
  const metrics = Object.entries(run.metrics);
  const facts: [string, string][] = [
    ['Command', `<code>${e(run.command)}</code>`],
    ['Why', e(run.why)],
    ['Commit', `<code>${e(run.commit.slice(0, 12))}</code>`],
    ['Where', e(placeText(run))],
    ['Ran by', `${e(by)} (${e(hostName(run.harness))})`],
    [
      'Direction',
      direction
        ? `<a href="#row-${e(direction.id)}">${e(direction.title)}</a>`
        : e(run.direction),
    ],
    ['State', e(runSummary(run))],
    [
      'Time',
      `${run.startedAt ? `Started ${e(clock(run.startedAt))}` : `Queued ${e(clock(run.queuedAt))}`}${run.endedAt ? `, ended ${e(clock(run.endedAt))}` : ''}. At most ${run.minutes} min.`,
    ],
  ];
  const body = `<dl class="facts">${facts.map(([term, value]) => `<dt>${term}</dt><dd>${value}</dd>`).join('')}</dl>
  ${run.note ? `<p class="notice">${e(run.note)}</p>` : ''}
  ${metrics.length ? `<h3>Metrics</h3><div class="table"><table class="metrics"><thead><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead><tbody>${metrics.map(([metric, value]) => `<tr><th scope="row">${e(metric)}</th><td>${value === null ? 'Not a number' : e(String(value))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="fine">No metrics. A run reports them with METRIC name=value lines or metrics.json.</p>'}
  ${run.outputs.length ? `<h3>Outputs</h3><ul class="outputs">${run.outputs.map((output) => `<li><code>${e(output.path)}</code> <span class="fine">${output.bytes} bytes</span></li>`).join('')}</ul><p class="fine">They are in .verifold/lab/runs/${e(run.id)}/outputs/.</p>` : ''}
  <details class="run-log" id="panel-log-${e(run.id)}" open><summary>The end of its log</summary><pre class="run-log-text" data-run-log="${e(run.id)}"></pre></details>
  ${view.runs && runActive(run) ? `<div class="actions"><button type="button" class="quiet" data-action="lab-run-cancel" data-run="${e(run.id)}" data-confirm="Click again to cancel this run">Cancel the run</button></div>` : ''}`;
  return {
    kind: 'Run',
    title: `Run ${run.id}`,
    sub: `<span class="status${runActive(run) ? ' active' : run.status === 'failed' ? ' failed' : ''}">${e(runSummary(run))}</span>`,
    // A root of its own scopes the lab panel's styles.
    body: `<div class="lab-panel">${body}</div>`,
  };
}

/**
 * What a direction's branch changed since its start, or, with `proof`, the
 * diff that a proof cites (such as p-12.0): its commits and its paths.
 */
export interface LabDiff {
  readonly direction: string;
  readonly proof: string | null;
  readonly from: string;
  readonly to: string;
  readonly files: readonly ChangedFile[];
}

/**
 * A diff in the panel: the files that a direction's branch changed, or the
 * files of the diff that a post cites. A click shows one file's changes.
 */
export function diffPanel(
  view: LabView,
  id: string | undefined,
  proof: string | undefined,
  diff: LabDiff | null,
): Panel {
  const direction = view.state.directions.find((entry) => entry.id === id);
  if (!direction)
    return {
      kind: 'Diff',
      title: 'No such direction',
      sub: '',
      body: '<p class="empty-note">This direction is not in the lab, for example after Start over.</p>',
    };
  const shown =
    diff?.direction === direction.id && diff.proof === (proof ?? null)
      ? diff
      : null;
  const files = shown?.files ?? null;
  const range = shown
    ? `from ${e(shown.from.slice(0, 7))} to ${e(shown.to.slice(0, 7))}`
    : '';
  const body =
    !shown || !files
      ? `<p class="empty-note">${proof ? 'Verifold could not read the diff of this post.' : "Verifold could not read this direction's branch."}</p>`
      : !files.length
        ? `<p class="empty-note">${proof ? 'The diff of this post changes no file.' : 'No file changed since the direction started.'}</p>`
        : `<p class="fine">${files.length} ${files.length === 1 ? 'file' : 'files'} changed ${range}.</p><ul class="review-files">${files.map((file) => `<li><button type="button" class="link" data-lab-diff="${e(file.path)}" data-lab-direction="${e(direction.id)}"${proof ? ` data-diff-proof="${e(proof)}"` : ''} aria-pressed="false"><code>${e(file.path)}</code></button> <span class="fine change-${file.change}">${file.change}</span></li>`).join('')}</ul><div class="diff-pane lab-diff-pane" data-lab-direction="${e(direction.id)}" data-diff-proof="${e(proof ?? '')}" data-lab-to="${e(shown.to)}"><p class="fine">Choose a file to see its changes.</p></div>`;
  return {
    kind: 'Diff',
    title: direction.title,
    sub: `<span class="fine">${proof ? `The diff that ${e(proof.split('.')[0] ?? proof)} cites` : `${e(workspaceName(direction.workspace))}, since the direction started`}</span>`,
    // A root of its own scopes the lab panel's styles.
    body: `<div class="lab-panel">${body}</div>`,
  };
}

/** Search opens in the side panel. ⌘K, or Ctrl+K off a Mac, opens it from anywhere in the desk. */
const searchButton =
  '<button type="button" class="quiet" id="lab-search-open" data-panel="search" data-focus="lab-search" aria-keyshortcuts="Meta+K Control+K">Search <kbd class="search-key"><span class="key-mac">⌘K</span><span class="key-other">Ctrl+K</span></kbd></button>';

/** A hit's text, with each match in a mark. Every part is escaped. */
function snippet(text: string, any: RegExp): string {
  return snippetParts(text, any)
    .map((part) => (part.mark ? `<mark>${e(part.text)}</mark>` : e(part.text)))
    .join('');
}

/**
 * The search panel: the hits of the lab's search (core/search.ts), the
 * newest first, and only the newest `searchLimit` render. A post on the
 * board links to it; an older one shows its whole text here, within
 * `searchTextBytes`. Every agent text is escaped.
 */
export function searchPanel(
  view: LabView,
  q: string | undefined,
  clock: (value: string) => string,
): Panel {
  const words = q ? searchWords(q) : null;
  const found = words ? searchLab(view, words) : [];
  const shown = new Set(boardPosts(view).map((post) => post.id));
  const budget = { left: searchTextBytes };
  const hit = (entry: SearchHit, any: RegExp): string => {
    if ('post' in entry) {
      const { post } = entry;
      const id = shown.has(post.id)
        ? `<a href="#post-${e(post.id)}" data-post-link="${e(post.id)}">${e(post.id)}</a>`
        : e(post.id);
      let whole = '';
      if (!shown.has(post.id) && post.text.length > snippetWidth) {
        const text = e(post.text);
        const bytes = Buffer.byteLength(text);
        if (bytes <= budget.left) {
          budget.left -= bytes;
          whole = `<details id="hit-${e(post.id)}"><summary>Show the whole post</summary><p class="pre">${text}</p></details>`;
        } else
          whole = `<p class="fine">The whole post is on the board, in .verifold/board/${e(post.id)}.json.</p>`;
      }
      return `<li class="hit"><p class="hit-head"><span class="chip kind-${post.kind}">${kindLabel(post)}</span> ${id} · ${e(authorName(view, post.author))} · <time datetime="${e(post.at)}">${e(clock(post.at))}</time></p><p class="hit-text">${snippet(post.text, any)}</p>${whole}</li>`;
    }
    if ('run' in entry) {
      const { run, at } = entry;
      return `<li class="hit"><p class="hit-head"><span class="chip">Run</span> <button type="button" class="link" data-panel="run" data-run="${e(run.id)}">${e(run.id)}</button> · ${e(authorName(view, run.agent))} · <time datetime="${e(at)}">${e(clock(at))}</time> · ${e(runSummary(run))}</p><p class="hit-text"><code>${snippet(run.command, any)}</code></p></li>`;
    }
    const { call } = entry;
    return `<li class="hit"><p class="hit-head"><span class="chip">${callWords[call.kind]}</span> ${e(call.id)} · ${e(authorName(view, call.by))} · <time datetime="${e(call.at)}">${e(clock(call.at))}</time> · ${e(callState(call))}</p><p class="hit-text">${snippet(callSearchText(call), any)}</p>${call.state === 'open' ? '<p><button type="button" class="link" data-view="needs">Answer it in Needs you</button></p>' : ''}</li>`;
  };
  const note = searchNote(words, found.length);
  return {
    kind: '',
    title: 'Search the lab',
    sub: '',
    body: `<div class="lab-panel lab-search"><label class="field" for="lab-search">Posts, runs, and calls</label><input id="lab-search" type="search" maxlength="${searchQueryLimit}" autocomplete="off" spellcheck="false" value="${e(q ?? '')}" aria-describedby="lab-search-note"><p class="fine" id="lab-search-note" role="status">${e(note)}</p>${
      words && found.length
        ? `<ol class="hits" aria-label="Hits">${found
            .slice(0, searchLimit)
            .map((entry) => hit(entry, words.any))
            .join('')}</ol>`
        : ''
    }</div>`,
  };
}

/**
 * What changed while the person was away (core/away.ts): a line for each
 * direction with news, the counts, and what the lab spent.
 */
function awayDigest(
  view: LabView,
  away: Away,
  gpu: LabGpu | null,
  disputed: ReadonlySet<string>,
  clock: (value: string) => string,
): string {
  const news = awayNews(view, away, gpu?.spent ?? null, disputed);
  const { lines, cost } = news;
  // Each line links to its row. Its mark is the row's.
  const glyph = (mark: AwayLine['mark']): string =>
    mark === 'new' ? '+' : verdictMarks[mark];
  // A run that failed opens in the panel.
  const counts = awayCounts(
    news,
    (id) =>
      `<button type="button" class="link" data-panel="run" data-run="${e(id)}">${e(id)}</button>`,
  );
  const quiet = !lines.length && !counts;
  return `<section class="lab-away" aria-labelledby="away-title"><div class="away-head"><h2 id="away-title">While you were away</h2><button type="button" class="link" data-action="lab-away-dismiss">Dismiss</button></div>
  <p class="fine">Since ${e(clock(away.since))}.</p>
  ${quiet ? `<p>${cost ? 'No post, run, or call came.' : 'Nothing changed.'}</p>` : ''}${
    lines.length
      ? `<ul class="away-lines">${lines
          .slice(0, awayLines)
          .map(
            (line) =>
              `<li><span class="away-mark" aria-hidden="true">${glyph(line.mark)}</span><span><a href="#row-${e(line.direction)}">${e(line.title)}</a>: ${e(line.said)}</span></li>`,
          )
          .join(
            '',
          )}</ul>${lines.length > awayLines ? `<p class="fine">${counted(lines.length - awayLines, 'more direction')} changed too. Their rows are below.</p>` : ''}`
      : ''
  }${counts ? `<p class="fine">${counts}.</p>` : ''}${cost ? `<p class="fine">${e(cost)}</p>` : ''}</section>`;
}

/**
 * The line that says that the lab ended, with its answer: every direction
 * closed or stopped, or the person chose to stop at the end of the time
 * budget.
 */
function endedLine(view: LabView, clock: (value: string) => string): string {
  const { state } = view;
  const ended = labEnded(state);
  if (!ended) return '';
  const why =
    ended === 'directions'
      ? 'every direction closed or stopped'
      : 'you chose to stop at the end of the time budget';
  const signed = state.signoff
    ? ` You signed off at ${e(clock(state.signoff.at))}.`
    : '';
  return `<p class="notice" role="status">The lab ended: ${why}.${signed} <button type="button" class="primary" data-panel="answer">See the answer</button></p>`;
}

/**
 * The lab's answer in the panel: each direction's verdict and evidence
 * against its bar, how it was checked, what the person brought in, the
 * person's calls, and the sign-off. Every agent text is escaped.
 */
export function answerPanel(
  view: LabView,
  clock: (value: string) => string,
): Panel {
  const { state } = view;
  const byId = new Map(view.ledger.map((run) => [run.id, run]));
  const disputed = new Set(
    openDisputes(view).map((dispute) => dispute.target.id),
  );
  const rows = view.directions.map(({ direction }) => {
    const dispute =
      direction.evidence !== null && disputed.has(direction.evidence.post);
    const mark = evidenceMark(direction, view, byId);
    const line = evidenceLine(direction);
    const brought = state.brought.filter(
      (entry) => entry.direction === direction.id,
    );
    const files = brought.length;
    const last = brought.reduce<(typeof brought)[number] | undefined>(
      (newest, entry) => (!newest || entry.at > newest.at ? entry : newest),
      undefined,
    );
    return `<li class="answer-row">${verdictChip(direction.verdict, dispute)}<span class="row-main"><strong>${e(direction.title)}</strong>${line ? `<span class="row-line">${e(line)}</span>` : ''}</span><span class="answer-side">${mark ? `<span class="fine">${e(mark)}</span>` : ''}${last ? `<span class="fine">${files} ${files === 1 ? 'file' : 'files'} brought in, last at ${e(clock(last.at))}</span>` : ''}${view.runs ? `<button type="button" class="link" data-panel="bring" data-lab-direction="${e(direction.id)}">Bring in files</button>` : ''}</span></li>`;
  });
  const ended = view.ledger.filter((run) => !runActive(run));
  const failed = ended.filter((run) => run.status !== 'done').length;
  // An answer that Verifold did not finish applying does not stand.
  const calls = state.calls.flatMap((call) => {
    const option =
      stands(call) && call.answer
        ? call.options[call.answer.option]
        : undefined;
    return option
      ? [option.label]
      : stands(call) && call.words
        ? [`"${clip(call.words, 120)}"`]
        : [];
  });
  const open = view.directions.filter(
    (entry) => entry.direction.state === 'open',
  );
  const signoff = view.runs
    ? `<section class="answer-signoff" aria-labelledby="signoff-title"><h3 id="signoff-title">Sign off</h3>
  <p class="fine">${state.signoff ? `You signed off at ${e(clock(state.signoff.at))}. A new sign-off replaces it.` : "Sign off when you agree with the answer. Verifold keeps each direction's verdict, its newest commit, and the check behind it."} A sign-off stops no agent: pause the lab or stop the directions for that.</p>
  <label class="field" for="lab-signoff-note">The answer in one line (optional)</label><input id="lab-signoff-note" type="text" maxlength="${labLimits.signoff}">
  <div class="actions"><button type="button" class="primary" data-action="lab-signoff">Sign off</button></div></section>`
    : '';
  const body = `${state.signoff?.note ? `<p class="answer-line">${e(state.signoff.note)}</p>` : ''}
  ${rows.length ? `<ul class="answer-rows">${rows.join('')}</ul>` : '<p class="empty-note">No direction yet.</p>'}
  <p>${open.length ? `<strong>Still open:</strong> ${e(open.map((entry) => entry.direction.title).join(', '))}. ` : ''}${view.ledger.length ? `${view.ledger.length} ${view.ledger.length === 1 ? 'run' : 'runs'}, ${failed} failed or stopped. Verifold keeps every run.` : 'No run yet.'}</p>
  <p><strong>Your calls:</strong> ${calls.length ? `${e(calls.join(' · '))}. The agents made the rest, all on the board.` : 'none. The agents made every choice, all on the board.'}</p>
  ${signoff}`;
  return {
    kind: 'Answer',
    title: clip(state.question, 200),
    sub: `<span class="fine">${state.signoff ? `Signed off ${e(clock(state.signoff.at))}` : labEnded(state) ? 'The lab ended' : 'The answer so far. The lab still works.'}</span>`,
    // A root of its own scopes the lab panel's styles.
    body: `<div class="lab-panel">${body}</div>`,
  };
}

/**
 * Bring in, in the panel: the files that a direction changed, at the commit
 * that the person looks at, with a box to tick each one and its diff. Files
 * that cannot come in say why. Before Verifold took the commit, the panel
 * asks for it. `list` is a string when Verifold cannot read the files.
 */
export function bringPanel(
  view: LabView,
  id: string | undefined,
  list: BringList | string | null,
  clock: (value: string) => string,
): Panel {
  const entry = view.directions.find((item) => item.direction.id === id);
  if (!entry)
    return {
      kind: 'Bring in',
      title: 'No such direction',
      sub: '',
      body: '<p class="empty-note">This direction is not in the lab, for example after Start over.</p>',
    };
  const { direction, agent } = entry;
  const branch = workspaceName(direction.workspace);
  const shown =
    typeof list === 'object' && list?.direction === direction.id ? list : null;
  const panel = (body: string): Panel => ({
    kind: 'Bring in',
    title: direction.title,
    sub: `<span class="fine">From ${e(branch)}${shown ? ` at ${e(shown.commit.slice(0, 7))}` : ''} into your project folder</span>`,
    body: `<div class="lab-panel">${body}</div>`,
  });
  const ask = `<div class="actions"><button type="button" class="primary" data-action="lab-bring-look" data-lab-direction="${e(direction.id)}">Show its files</button></div>`;
  if (typeof list === 'string')
    return panel(
      `<p class="notice" role="alert">Verifold could not read the files of this direction: ${e(list)}</p>${view.runs ? ask : ''}`,
    );
  if (!shown)
    return panel(
      view.runs
        ? `<p class="fine" data-lab-bring-look="${e(direction.id)}">Verifold commits the newest work of this direction first, so you see exactly the files that come in.</p>${ask}`
        : '<p class="empty-note">Run verifold in the project folder to bring in files.</p>',
    );
  const can = shown.files.filter((file) => file.out === null);
  const out = shown.files.filter((file) => file.out !== null);
  const box = (index: number): string =>
    `bring-${shown.commit.slice(0, 8)}-${index}`;
  const items = can.map((file, index) => {
    const why = file.since
      ? `Brought in at ${clock(file.since)}.`
      : (file.why ?? '');
    const warn = file.code
      ? ` <span class="fine bring-code-warn" id="${box(index)}-code">This file can run code on your computer. Bring it in only if its diff looks right.</span>`
      : '';
    return `<li><input type="checkbox" id="${box(index)}" data-bring-file="${e(file.path)}"${file.code ? ` aria-describedby="${box(index)}-code"` : ''}${file.ticked ? ' checked' : ''}${file.since || !view.runs ? ' disabled' : ''}> <label for="${box(index)}"><code>${e(file.path)}</code></label> <span class="fine change-${file.change}">${file.change}</span> <button type="button" class="link" data-lab-diff="${e(file.path)}" data-lab-direction="${e(direction.id)}" data-bring-commit="${e(shown.commit)}" aria-pressed="false" aria-label="Diff of ${e(file.path)}">Diff</button>${why ? ` <span class="fine bring-why">${e(why)}</span>` : ''}${warn}</li>`;
  });
  // Each bring-in of this direction: the files that keep it as their base, by its time.
  const history = bringGroups(view.state.brought, direction.id).map(
    (group) =>
      `<li>${e(clock(group.at))}: ${e(nameList(group.paths))} <span class="fine">at ${e(group.commit.slice(0, 7))}</span></li>`,
  );
  const working = shown.working
    ? `<p class="notice" role="status">${e(agent.handle)} is working, so these are its files as of its last turn. When its turn ends, its newer work shows here.</p>`
    : '';
  const newer =
    view.runs && shown.newer
      ? `<p class="fine">${e(agent.handle)} has newer work. <button type="button" class="link" data-action="lab-bring-look" data-lab-direction="${e(direction.id)}">Show the newer files</button></p>`
      : '';
  const left = shown.left.length
    ? `<p class="fine">Left out of this commit, so they cannot come in:</p><ul class="bring-out">${shown.left.map((file) => `<li><code>${e(file.path)}</code> <span class="fine">${e(file.why)}</span></li>`).join('')}</ul>`
    : '';
  return panel(`${working}${
    shown.files.length
      ? `<p class="fine">${shown.files.length} ${shown.files.length === 1 ? 'file' : 'files'} changed since this direction started or since they came in. The ticked files come into your project folder. Nothing else changes, and nothing merges by itself.</p>`
      : '<p class="empty-note">This direction changed no file since it started or since its files came in.</p>'
  }${newer}
  ${can.length ? `<ul class="bring-files">${items.join('')}</ul>` : ''}
  ${out.length ? `<p class="fine">Stays out:</p><ul class="bring-out">${out.map((file) => `<li><code>${e(file.path)}</code> <span class="fine">${e(file.out ?? '')}</span></li>`).join('')}</ul>` : ''}${left}
  ${can.length ? `<div class="diff-pane lab-diff-pane" data-lab-direction="${e(direction.id)}" data-diff-proof="" data-bring-commit="${e(shown.commit)}" data-lab-to="${e(shown.commit)}"><p class="fine">Choose Diff beside a file to see its changes.</p></div>` : ''}
  ${view.runs && can.length ? `<div class="actions"><button type="button" class="primary" data-action="lab-bring" data-lab-direction="${e(direction.id)}" data-commit="${e(shown.commit)}">Bring in the ticked files</button></div><p class="fine">When a file changed in your project folder since this direction started, or since it came in, nothing comes in, and Verifold names the file.</p>` : ''}
  ${history.length ? `<h3>Brought in</h3><ul class="bring-history">${history.join('')}</ul>` : ''}`);
}
