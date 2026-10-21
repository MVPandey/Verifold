import type { Lab } from '../protocol/api.ts';
import { harnessName } from './format.ts';

/** A name that a message box completes, such as `@claude-1`, with a short note on who it is. */
export interface MentionName {
  readonly value: string;
  readonly note: string;
}

/** The most names that the list under a message box shows. */
export const mentionLimit = 8;

/**
 * The names that a message to the lab can mention, as the desk lists them:
 * each open direction's agent wakes that agent, each open direction writes
 * in it, and `@all` wakes every agent.
 */
export function mentionNames(lab: Lab): MentionName[] {
  const open = lab.directions.filter((entry) => entry.state === 'open');
  const agents = new Map(lab.agents.map((agent) => [agent.id, agent]));
  return [
    ...open.flatMap((direction) => {
      const agent = agents.get(direction.agent);
      return agent
        ? [
            {
              value: `@${agent.handle}`,
              note: `${harnessName(agent.harness)}, ${direction.title}`,
            },
          ]
        : [];
    }),
    ...open.map((direction) => ({
      value: `@${direction.id}`,
      note: direction.title,
    })),
    { value: '@all', note: 'Every agent' },
  ];
}

/**
 * The name that the person is typing at the caret: where its `@` is, and
 * what follows it so far. Null when the caret does not end a word that
 * starts with `@`.
 */
export function mentionQuery(
  text: string,
  caret: number,
): { readonly start: number; readonly query: string } | null {
  const match = /(?:^|\s)@([\w.-]*)$/.exec(text.slice(0, caret));
  if (match?.[1] === undefined) return null;
  return { start: caret - match[1].length - 1, query: match[1] };
}

/** The names that start with what the person typed, at most `mentionLimit`. */
export function mentionMatches(
  names: readonly MentionName[],
  query: string,
): MentionName[] {
  const typed = query.toLowerCase();
  return names
    .filter((name) => name.value.slice(1).toLowerCase().startsWith(typed))
    .slice(0, mentionLimit);
}

/**
 * The text with `value` in place of the name that starts at `start` and
 * ends at `caret`, followed by one space, and where the caret goes then.
 */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  value: string,
): { readonly text: string; readonly caret: number } {
  const rest = text.slice(caret);
  const next = `${text.slice(0, start)}${value}${rest.startsWith(' ') ? '' : ' '}${rest}`;
  return { text: next, caret: start + value.length + 1 };
}
