import type { ReactNode } from 'react';
import type { Fact } from '../../protocol/api.ts';
import { dayClock } from '../format.ts';

/** The most characters of a source as the page shows it. A longer one is cut with "…". */
const sourceChars = 44;

/** A source that the page may link to: a web address, never a script. */
export function sourceLink(source: string): string | null {
  try {
    const url = new URL(source);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * A source as people read it: a web address without its scheme and "www.",
 * and a long one cut with "…". Any other source shows as the agent wrote it.
 */
export function sourceName(source: string): string {
  let name = source;
  if (sourceLink(source)) {
    const url = new URL(source);
    name = `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}`;
  }
  return name.length > sourceChars
    ? `${name.slice(0, sourceChars - 1)}…`
    : name;
}

/** The same facts once, by their claim, in their first order. */
export function uniqueFacts(facts: readonly Fact[]): Fact[] {
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = fact.claim.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Where a fact came from, as a link when it is a web address, with the
 * source's date, and when its plan or call listed it. A fact without a
 * source is unverified. `now`: the app's clock, where the page has it.
 */
export function FactSource({
  fact,
  now,
}: {
  readonly fact: Fact;
  readonly now?: number | undefined;
}): ReactNode {
  const listed = ` · listed ${dayClock(fact.listedAt, now)}`;
  if (!fact.source)
    return (
      <span className="facts__unverified">
        · unverified (no source){listed}
      </span>
    );
  const link = sourceLink(fact.source);
  const name = sourceName(fact.source);
  return (
    <span className="facts__source">
      ·{' '}
      {link ? (
        <a href={link} target="_blank" rel="noreferrer noopener">
          {name}
        </a>
      ) : (
        name
      )}
      {fact.sourceDate && ` · ${fact.sourceDate}`}
      {listed}
    </span>
  );
}

/** Facts with where each came from. A fact without a source says that it is unverified. */
export function FactsList({
  facts,
  now,
}: {
  readonly facts: readonly Fact[];
  readonly now?: number | undefined;
}): ReactNode {
  return (
    <ul className="facts">
      {facts.map((fact, index) => (
        <li key={index}>
          {fact.claim} <FactSource fact={fact} now={now} />
        </li>
      ))}
    </ul>
  );
}
