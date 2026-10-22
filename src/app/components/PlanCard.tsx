import type { ReactNode } from 'react';
import type { Lab, Plan } from '../../protocol/api.ts';
import { onBoard } from '../call.ts';
import { clock } from '../format.ts';
import { href } from '../route.ts';
import { FactsList } from './FactsList.tsx';

/** "Holds up if" of a direction: its bar, and the runs that it needs. */
function holds(bar: string | null, runs: number | null): string {
  const repeat =
    runs === null ? '' : ` · ${runs} ${runs === 1 ? 'run' : 'runs'}`;
  return `${bar ?? 'Not set yet'}${repeat}`;
}

/**
 * The plan of record, as on the v9 canvas ("7 Plan of record"): how the
 * planner reads the question, a table of its directions, what changed from
 * the plan before, the facts that it checked, and what costs money. A reply
 * to it changes it.
 */
export function PlanCard({
  plan,
  lab,
}: {
  readonly plan: Plan;
  readonly lab: Lab;
}): ReactNode {
  const directions = new Map(lab.directions.map((entry) => [entry.id, entry]));
  const rows = plan.directions.flatMap((id) => {
    const direction = directions.get(id);
    return direction ? [direction] : [];
  });
  const version = plan.version;
  const before = plan.previous ?? null;
  return (
    <div className="plan">
      <div className="post__head">
        <b>Planner</b>
        <span className="chip chip--plan">
          Plan of record{version ? ` · v${version}` : ''}
        </span>
        <span className="muted">{clock(plan.at)}</span>
      </div>
      <p className="plan__reading">How I read it: {plan.reading}</p>
      {rows.length > 0 && (
        <div className="plan__table-box">
          <table className="plan__table">
            <thead>
              <tr>
                <th scope="col">Direction</th>
                <th scope="col">Holds up if</th>
                <th scope="col">Builds on</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((direction) => (
                <tr key={direction.id}>
                  <th scope="row">
                    <a href={href.direction(direction.id)}>{direction.title}</a>
                  </th>
                  <td>{holds(direction.bar, direction.runs)}</td>
                  <td>
                    {direction.buildsOn.length
                      ? direction.buildsOn
                          .map((work) =>
                            work.known ? work.text : `${work.text} (new)`,
                          )
                          .join(', ')
                      : 'New'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {version !== undefined && version > 1 && (
        <div className="plan__changed">
          <b>Changed in v{version}</b>
          <span>
            {plan.changed ?? 'The planner did not say what changed.'}
            {before && (
              <>
                {' '}
                <a
                  href={
                    onBoard(lab, before)
                      ? href.board(before)
                      : href.post(before)
                  }
                >
                  See v{version - 1}
                </a>
              </>
            )}
          </span>
        </div>
      )}
      {plan.facts.length > 0 && (
        <details className="plan__facts" open>
          <summary>
            Facts checked ({plan.facts.length})
            {plan.factsCarried && ' · from an earlier plan'}
          </summary>
          <FactsList facts={plan.facts} />
        </details>
      )}
      <p className="plan__cost">{plan.cost} Reply to change anything.</p>
    </div>
  );
}
