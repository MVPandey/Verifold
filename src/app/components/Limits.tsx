import { useId, type ReactNode } from 'react';
import { clock, usd } from '../format.ts';

/** A number that the person typed, or null when it is not one. */
export function numberOf(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() && Number.isFinite(value) ? value : null;
}

/** When Verifold read the prices: "at 19:41 today", or with the date. */
export function readAt(at: string): string {
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString()
    ? `at ${clock(at)} today`
    : `on ${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} at ${clock(at)}`;
}

/** One number field with its unit, as in the artboard's "Limits". `note`: a line under it. */
export function LimitField({
  label,
  before,
  after,
  value,
  onChange,
  min,
  step,
  note,
}: {
  readonly label: string;
  readonly before?: string;
  readonly after?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly min: number;
  readonly step: number;
  readonly note?: ReactNode;
}): ReactNode {
  const id = useId();
  const noteId = useId();
  return (
    <div className="limit">
      <label htmlFor={id} className="limit__label">
        {label}
      </label>
      <span className="limit__value">
        {before}
        <input
          id={id}
          className="limit__input"
          type="number"
          inputMode="decimal"
          min={min}
          step={step}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          {...(note ? { 'aria-describedby': noteId } : {})}
        />
        {after}
      </span>
      {note && (
        <span id={noteId} className="limit__note">
          {note}
        </span>
      )}
    </div>
  );
}

/** One GPU type in a price table. A price of null: RunPod does not offer it now. */
export interface GpuRow {
  readonly id: string;
  readonly name: string;
  readonly memoryGb: number;
  readonly usdPerHour: number | null;
  readonly stock?: 'none' | 'low' | 'medium' | 'high' | null;
}

const stockWords = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
} as const;

/**
 * RunPod's prices, with an Allow box for each GPU that agents may rent. With
 * `cap`, a GPU above the price cap says so. `stock` adds RunPod's stock.
 */
export function GpuTable({
  rows,
  allowed,
  onAllow,
  cap = null,
  stock = false,
}: {
  readonly rows: readonly GpuRow[];
  readonly allowed: readonly string[];
  readonly onAllow: (allowed: readonly string[]) => void;
  readonly cap?: number | null;
  readonly stock?: boolean;
}): ReactNode {
  return (
    <div className="prices__box">
      <table className="prices__table">
        <thead>
          <tr>
            <th scope="col">GPU</th>
            <th scope="col">Memory</th>
            <th scope="col" className="prices__number">
              Per hour
            </th>
            {stock && <th scope="col">Stock</th>}
            <th scope="col" className="prices__allow">
              Allow
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((gpu) => (
            <tr key={gpu.id}>
              <td className="prices__name">{gpu.name}</td>
              <td>{gpu.memoryGb ? `${gpu.memoryGb} GB` : ''}</td>
              <td className="prices__number">
                {gpu.usdPerHour === null ? (
                  <span className="muted">Not offered now</span>
                ) : (
                  <>
                    {usd(gpu.usdPerHour)}
                    {cap !== null && gpu.usdPerHour > cap && (
                      <span className="prices__over">Above your cap</span>
                    )}
                  </>
                )}
              </td>
              {stock && <td>{gpu.stock ? stockWords[gpu.stock] : ''}</td>}
              <td className="prices__allow">
                <input
                  type="checkbox"
                  aria-label={`Allow ${gpu.name}`}
                  checked={allowed.includes(gpu.id)}
                  onChange={(event) =>
                    onAllow(
                      event.target.checked
                        ? [...allowed, gpu.id]
                        : allowed.filter((id) => id !== gpu.id),
                    )
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
