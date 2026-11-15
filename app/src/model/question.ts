import type { QuestionVersion } from '../api/types.ts';

/** Return how often the person revised the question, as one sentence, or `null` when they never did. */
export function revisedLine(versions: readonly QuestionVersion[]): string | null {
  const times = versions.length - 1;
  if (times < 1) return null;
  return `Revised ${times === 1 ? '1 time' : `${times} times`}.`;
}

/** Return whether a text in the edit box is a revision: it has words, and it is not the question as it is. */
export function isRevision(question: string, text: string): boolean {
  return text.trim() !== '' && text.trim() !== question;
}
