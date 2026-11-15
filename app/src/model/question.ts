import type { QuestionVersion } from '../api/types.ts';

/** Return how often the person revised the question, as one sentence, or `null` when they never did. */
export function revisedLine(versions: readonly QuestionVersion[]): string | null {
  const times = versions.length - 1;
  if (times < 1) return null;
  return `Revised ${times === 1 ? '1 time' : `${times} times`}.`;
}

/**
 * Return who made a version of the question, as one line, or `null` for the person's own text and revisions: the
 * person at the coordinator's request, or the coordinator with the power to revise the question.
 */
export function revisedBy(version: QuestionVersion): string | null {
  if (version.by !== undefined && version.by !== 'person') {
    return 'Revised by the coordinator, with the power “Revise the question”.';
  }
  return version.request ? 'Revised by you, at the coordinator’s request.' : null;
}

/** Return the label of a version's note: the person's own reason, or the coordinator's. */
export function noteLabel(version: QuestionVersion): string {
  return version.by !== undefined && version.by !== 'person' ? 'The coordinator’s reason' : 'Why';
}

/** Return whether a text in the edit box is a revision: it has words, and it is not the question as it is. */
export function isRevision(question: string, text: string): boolean {
  return text.trim() !== '' && text.trim() !== question;
}
