import type { Call, Lab, Wait } from '../protocol/api.ts';
import { andList } from '../ui/call-words.ts';
import { failureOf } from './call.ts';
import { roleName, shortTime, since, usd } from './format.ts';
import { href } from './route.ts';
import { askedOfYou } from './waits.ts';

/** A row of Needs you: a call to decide, or an ask to reply to. */
export interface NeedRow {
  readonly key: string;
  readonly text: string;
  readonly sub: string;
  /** The call that Decide opens. Null: Reply goes to `reply`. */
  readonly call: string | null;
  readonly reply: string | null;
  /** Why the person's last answer failed after Verifold accepted it. */
  readonly failure: string | null;
}

const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

/** Minutes in words: "45 minutes", "3 hours", "1 hour 30 minutes". */
function timeWords(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [
    ...(hours ? [plural(hours, 'hour')] : []),
    ...(rest ? [plural(rest, 'minute')] : []),
  ].join(' ');
}

/** The most that a call can cost: "Up to $3.58 of GPU", "No cost", or "Cost not given". */
export function upToCost(call: Pick<Call, 'options'>): string {
  const priced = call.options.filter((option) => option.usd !== null);
  if (!priced.length) return 'Cost not given';
  const top = priced.reduce((most, option) =>
    (option.usd ?? 0) > (most.usd ?? 0) ? option : most,
  );
  if (!top.usd) return 'No cost';
  return `Up to ${usd(top.usd)}${top.effect?.type === 'pod' ? ' of GPU' : ''}`;
}

/**
 * The longest a call can take and the latest useful answer, such as "Up to 3
 * hours. To finish by 21:17, answer by about 18:17". The time ignores any
 * queue, so it says "about". `deadline`: the lab's time budget. `latestAt`
 * comes from the server, which holds the rule.
 */
export function timeLine(
  call: Pick<Call, 'options' | 'latestAt'>,
  deadline: string | null,
  now: number,
): string {
  const { latestAt } = call;
  if (deadline && latestAt) {
    const minutes = (Date.parse(deadline) - Date.parse(latestAt)) / 60_000;
    const upTo = `Up to ${timeWords(minutes)}`;
    return Date.parse(latestAt) > now
      ? `${upTo}. To finish by ${shortTime(deadline, now)}, answer by about ${shortTime(latestAt, now)}`
      : `${upTo}. That no longer fits before ${shortTime(deadline, now)}`;
  }
  const minutes = Math.max(
    0,
    ...call.options.map((entry) => entry.minutes ?? 0),
  );
  return minutes ? `Up to ${timeWords(minutes)}` : 'Time not given';
}

/** Who asks a call: "Agent 2 asks", "Agents 1 and 2 ask", "Verifold asks". */
function askerWords(call: Call): string {
  const numbers = call.askers.map((asker) => roleName(asker.handle));
  const [first] = numbers;
  if (!first) return 'Verifold asks';
  return numbers.length > 1 ? `${andList(numbers)} ask` : `${first} asks`;
}

function callRow(call: Call, lab: Lab, now: number): NeedRow {
  return {
    key: call.id,
    text: call.question,
    sub: [
      askerWords(call),
      since(call.at, now),
      upToCost(call),
      timeLine(call, lab.budget?.deadline ?? null, now),
    ].join(' · '),
    call: call.id,
    reply: null,
    failure: failureOf(lab, call)?.text ?? null,
  };
}

function askRow(ask: Wait, now: number): NeedRow {
  return {
    key: ask.post,
    text: ask.text,
    sub: `${ask.waiterHandle ? roleName(ask.waiterHandle) : 'An agent'} asks · ${since(ask.since, now)}`,
    call: null,
    reply: href.post(ask.post),
    failure: null,
  };
}

/** Each call that waits for the person, then each ask that names them. */
export function needRows(lab: Lab, now: number): readonly NeedRow[] {
  return [
    ...lab.needsYou.map((call) => callRow(call, lab, now)),
    ...askedOfYou(lab).map((ask) => askRow(ask, now)),
  ];
}
