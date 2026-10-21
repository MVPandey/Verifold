import { useContext, useId, useState, type ReactNode } from 'react';
import type { Harness, Lab } from '../../protocol/api.ts';
import { checkLine } from '../answer.ts';
import { ControlsContext, type NewDirection } from '../controls.ts';
import { authorOf, clock, cut, harnessName } from '../format.ts';
import { href } from '../route.ts';
import { useAction } from '../useAction.ts';
import { Warning } from './Icons.tsx';

/** The most characters of a direction's title and bar, as the lab checks them. */
const titleLimit = 120;
const barLimit = 280;

/** The hours that "Give more time" offers, as the desk does: 2, and the lab's default of 8. */
export const moreHours = [2, 8] as const;

/**
 * Open a direction yourself: a title, the harness of its agent, and what
 * makes it hold up. Folded, because agents open most directions with the
 * plan. The lab opens it in the background, and the line of background
 * actions says when it is done or why it failed.
 */
export function OpenDirection(): ReactNode {
  const controls = useContext(ControlsContext);
  const id = useId();
  const [title, setTitle] = useState('');
  const [harness, setHarness] = useState<Harness>('claude');
  const [bar, setBar] = useState('');
  const action = useAction<NewDirection>(
    (direction, key) =>
      controls
        ? controls.addDirection(direction, key)
        : Promise.resolve({ refused: 'This tab has no access key.' }),
    (a, b) => a.title === b.title && a.harness === b.harness && a.bar === b.bar,
  );
  if (!controls) return null;
  return (
    <details className="open-direction">
      <summary className="open-direction__summary">
        Open a direction yourself
      </summary>
      <form
        className="open-direction__form"
        onSubmit={(event) => {
          event.preventDefault();
          const direction = { title: title.trim(), harness, bar: bar.trim() };
          if (!direction.title || action.busy) return;
          void action.submit(direction).then((ran) => {
            if (!ran) return;
            setTitle('');
            setBar('');
          });
        }}
      >
        <label className="field" htmlFor={`${id}-title`}>
          Title
        </label>
        <input
          id={`${id}-title`}
          className="field__input"
          maxLength={titleLimit}
          placeholder="The CoT names what drives the answer"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <label className="field" htmlFor={`${id}-harness`}>
          Agent
        </label>
        <select
          id={`${id}-harness`}
          className="field__input"
          value={harness}
          onChange={(event) =>
            setHarness(event.target.value === 'codex' ? 'codex' : 'claude')
          }
        >
          <option value="claude">Claude Code</option>
          <option value="codex">Codex</option>
        </select>
        <label className="field" htmlFor={`${id}-bar`}>
          Holds up if (you can leave it empty)
        </label>
        <input
          id={`${id}-bar`}
          className="field__input"
          maxLength={barLimit}
          placeholder="it beats the control by 20 points on 3 seeds"
          value={bar}
          onChange={(event) => setBar(event.target.value)}
        />
        <div className="open-direction__actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={action.busy || !title.trim()}
          >
            Open the direction
          </button>
          {action.error && (
            <span role="alert" className="composer__error">
              {action.error}
            </span>
          )}
        </div>
      </form>
    </details>
  );
}

/** More hours for a lab whose time budget ended, as the desk's buttons give them. */
export function MoreTime(): ReactNode {
  const controls = useContext(ControlsContext);
  const action = useAction<number>((hours, key) =>
    controls
      ? controls.moreTime(hours, key)
      : Promise.resolve({ refused: 'This tab has no access key.' }),
  );
  if (!controls) return null;
  return (
    <div className="more-time">
      {moreHours.map((hours) => (
        <button
          key={hours}
          type="button"
          className="button"
          disabled={action.busy}
          onClick={() => void action.submit(hours)}
        >
          Give {hours} more hours
        </button>
      ))}
      {action.error && (
        <span role="alert" className="composer__error">
          {action.error}
        </span>
      )}
    </div>
  );
}

/** Background actions that answers and bring-ins do not show on their own. */
function shownWork(work: Lab['works'][number]): boolean {
  return (
    work.call === undefined &&
    work.action !== 'lab-bring' &&
    work.action !== 'lab-bring-look'
  );
}

/**
 * The lab's actions that go on in the background, such as opening a
 * direction, and the ones that failed there, with one Dismiss for the
 * failures.
 */
export function WorksLine({ lab }: { readonly lab: Lab }): ReactNode {
  const controls = useContext(ControlsContext);
  const action = useAction<null>((_, key) =>
    controls
      ? controls.dismiss(key)
      : Promise.resolve({ refused: 'This tab has no access key.' }),
  );
  const works = lab.works.filter(shownWork);
  if (!works.length) return null;
  const failed = works.some((work) => work.error !== null);
  return (
    <div className="works">
      {works.map((work) =>
        work.error === null ? (
          <p
            key={`${work.action}-${work.at}`}
            role="status"
            className="works__item"
          >
            {work.label}. It started at {clock(work.at)} and goes on in the
            background.
          </p>
        ) : (
          <p
            key={`${work.action}-${work.at}`}
            role="alert"
            className="works__item works__item--failed"
          >
            {work.label} did not finish: {work.error}
          </p>
        ),
      )}
      {failed && controls && (
        <button
          type="button"
          className="link-button"
          disabled={action.busy}
          onClick={() => void action.submit(null)}
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

/** Where a dispute's check is, in a few words. */
function checkWhere(lab: Lab, post: string, checkId: string | null): string {
  const check = checkId
    ? lab.checks.find((entry) => entry.id === checkId)
    : undefined;
  if (!check) return 'No check yet.';
  const who = `${check.handle} (${harnessName(check.harness)})`;
  switch (check.state) {
    case 'queued':
      return `Check ${check.id} waits for ${who}.`;
    case 'running':
      return `${who} checks it now, without the author's reasoning.`;
    case 'failed':
    case 'dropped':
      return `Check ${check.id} did not finish${check.note ? `: ${check.note}` : ''}. Another objection starts a new check.`;
    case 'done':
      return `${checkLine(lab, post) ?? 'Checked'}.`;
  }
}

/**
 * Open disputes, pinned above the board: each disputed post, the first
 * doubt about it, where its check is, and what the checker did.
 */
export function Disputes({ lab }: { readonly lab: Lab }): ReactNode {
  if (!lab.disputes.length) return null;
  const posts = new Map(lab.board.posts.map((post) => [post.id, post]));
  return (
    <ul className="pinned" aria-label="Open disputes">
      {lab.disputes.map((dispute) => {
        const target = posts.get(dispute.post);
        const row = lab.directions.find(
          (entry) => entry.evidence?.post === dispute.post,
        );
        const doubt = dispute.objections
          .map((id) => posts.get(id))
          .find((post) => post !== undefined);
        const check = dispute.check
          ? lab.checks.find((entry) => entry.id === dispute.check)
          : undefined;
        return (
          <li key={dispute.post} className="pinned__item">
            <span className="pinned__mark">
              <Warning /> Disputed
            </span>
            <div className="pinned__text">
              <p>
                <a href={href.board(dispute.post)}>{dispute.post}</a>
                {target &&
                  ` by ${target.author === 'person' ? 'you' : authorOf(target)}`}
                {row && (
                  <>
                    , the evidence of{' '}
                    <a href={href.direction(row.id)}>{row.title}</a>
                  </>
                )}
                {target && `: ${cut(target.text, 140)}`}
              </p>
              {doubt && (
                <p className="muted">
                  {doubt.author === 'person'
                    ? 'You object'
                    : `${authorOf(doubt)} objects`}
                  : {cut(doubt.text, 140)}
                  {dispute.objections.length > 1 &&
                    ` (and ${dispute.objections.length - 1} more)`}
                </p>
              )}
              <p className="muted">
                {checkWhere(lab, dispute.post, dispute.check)}
                {check && check.state !== 'queued' && (
                  <>
                    {' '}
                    <a href={href.agent(check.agent)}>
                      What {check.handle} did
                    </a>
                  </>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
