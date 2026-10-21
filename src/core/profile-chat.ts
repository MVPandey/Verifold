import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardLimits, type ProfileCard } from './agency.ts';
import { runHarness, type HarnessName } from './harness.ts';
import { loadPrompt } from './prompts.ts';
import { parseHostJson } from './research-contracts.ts';
import { SessionActionError } from './session.ts';

/**
 * The "About you" conversation of the first run. Verifold asks the first
 * question. The person's harness asks up to two more and drafts the card.
 * Without a harness, Verifold asks how agents should write to the person
 * and fills the card from the answers.
 */
export interface ChatLine {
  /** `verifold`: Verifold's own question. A harness: its question. */
  readonly from: 'verifold' | 'you' | HarnessName;
  readonly text: string;
  /** Answers that the asker suggests. The person can pick one or write their own. */
  readonly suggestions: readonly string[];
  /** `talk`: the question asks how agents should write to the person, so its answer is "Talk to me". */
  readonly asks?: 'talk';
}

export const firstQuestion =
  'What do you work on, and what would you like the agents to explore?';

/** The opening of every conversation. */
export const opening: readonly ChatLine[] = [
  { from: 'verifold', text: firstQuestion, suggestions: [] },
];

/** The most questions that a harness asks after the first one. */
export const followUps = 2;

/** The most characters of one answer or note. */
export const answerLimit = 2000;

export type ChatStep =
  | {
      readonly question: string;
      readonly suggestions: readonly string[];
      readonly asks?: 'talk';
    }
  | { readonly card: ProfileCard };

/** The harness that runs the conversation, with the model that the person picked. */
export interface ChatHarness {
  readonly host: HarnessName;
  readonly model?: string;
}

/** The questions asked so far, after the first one. */
function asked(lines: readonly ChatLine[]): number {
  return Math.max(0, lines.filter((line) => line.from !== 'you').length - 1);
}

/** Verifold's own steps: it asks how agents should talk, then fills the card from the answers. */
function localStep(lines: readonly ChatLine[]): ChatStep {
  if (lines.filter((line) => line.from === 'you').length < 2)
    return {
      question: 'How should the agents talk to you?',
      suggestions: ['Short and direct', 'Show the reasoning', 'Like a paper'],
      asks: 'talk',
    };
  return { card: answersCard(lines) };
}

function field(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

/** The harness's reply as a step. A question when none is left is refused. */
function parseStep(text: string, left: number): ChatStep {
  let value: unknown;
  try {
    value = parseHostJson(text);
  } catch {
    value = null;
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const reply = value as Record<string, unknown>;
    const card = reply.card;
    if (typeof card === 'object' && card !== null && !Array.isArray(card)) {
      const fields = card as Record<string, unknown>;
      const result = {
        workOn: field(fields.workOn, cardLimits.workOn),
        explore: field(fields.explore, cardLimits.explore),
        talk: field(fields.talk, cardLimits.talk),
      };
      if (result.workOn || result.explore || result.talk)
        return { card: result };
    }
    const question = field(reply.question, 300);
    if (question && left > 0)
      return {
        question,
        suggestions: (Array.isArray(reply.suggestions) ? reply.suggestions : [])
          .map((entry) => field(entry, 80))
          .filter(Boolean)
          .slice(0, 3),
        ...(reply.asks === 'talk' ? { asks: 'talk' as const } : {}),
      };
  }
  throw new SessionActionError(
    'The agent did not send a card or a question that Verifold can read. Try again, or fill the card from your answers.',
  );
}

/**
 * The next step: a question or the card. With a card and a note, the
 * harness changes the card. The harness works in an empty private folder
 * that Verifold removes afterwards, with no tools that the task needs.
 */
export async function nextStep(input: {
  readonly lines: readonly ChatLine[];
  readonly card: ProfileCard | null;
  readonly note: string | null;
  readonly harness: ChatHarness | null;
  readonly signal: AbortSignal;
  readonly run?: typeof runHarness;
}): Promise<ChatStep> {
  const { lines, card, note, harness, signal } = input;
  if (!harness) {
    if (note)
      throw new SessionActionError(
        'No agent is signed in, so Verifold cannot change the card from a note. Edit the card instead.',
      );
    return localStep(lines);
  }
  const left = card ? 0 : Math.max(0, followUps - asked(lines));
  const folder = await mkdtemp(join(tmpdir(), 'verifold-profile-'));
  try {
    const result = await (input.run ?? runHarness)({
      host: harness.host,
      ...(harness.model ? { model: harness.model } : {}),
      cwd: folder,
      signal,
      timeoutMs: 180_000,
      idleMs: 120_000,
      prompt: `${await loadPrompt('profile-card')}

The input, as JSON:
${JSON.stringify({
  conversation: lines.map((line) => ({
    from: line.from === 'you' ? 'person' : 'asker',
    text: line.text,
  })),
  questionsLeft: left,
  ...(card ? { card } : {}),
  ...(note ? { note } : {}),
})}`,
    });
    return parseStep(result.text, left);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * The card from the answers alone: the first answer is what the person
 * works on, the answer to a question about how agents should talk is "Talk
 * to me", and any other answer is what to explore.
 */
export function answersCard(lines: readonly ChatLine[]): ProfileCard {
  const parts: Record<keyof ProfileCard, string[]> = {
    workOn: [],
    explore: [],
    talk: [],
  };
  let asked: ChatLine | undefined;
  for (const line of lines) {
    if (line.from !== 'you') {
      asked = line;
      continue;
    }
    const field = !parts.workOn.length
      ? 'workOn'
      : asked?.asks === 'talk'
        ? 'talk'
        : 'explore';
    parts[field].push(line.text);
    asked = undefined;
  }
  return {
    workOn: parts.workOn.join('\n').slice(0, cardLimits.workOn),
    explore: parts.explore.join('\n').slice(0, cardLimits.explore),
    talk: parts.talk.join('\n').slice(0, cardLimits.talk),
  };
}
