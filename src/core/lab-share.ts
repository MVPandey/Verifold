/**
 * How far from known work a lab goes, as the person chose at Ask. This module
 * imports nothing, so a check of the Ask page's input loads no session and no
 * prompt.
 */
export const labShares = ['close', 'mixed', 'far'] as const;

export type LabShare = (typeof labShares)[number];

/** The refusal of a share that is not valid. */
export const shareProblem =
  'Choose how far from known work: close, mixed, or far.';

/** The part of a plan's directions that each choice gives to long shots. */
const parts: Readonly<Record<LabShare, number>> = {
  close: 0,
  mixed: 1 / 4,
  far: 1 / 2,
};

/** The share in `value`: `mixed` when it gives none, and null when it is not valid. */
export function shareOf(value: unknown): LabShare | null {
  return value === undefined
    ? 'mixed'
    : (labShares.find((entry) => entry === value) ?? null);
}

/** Long-shot directions in a plan of `directions`, at least one when the share is not zero. */
export function longShotCount(share: LabShare, directions: number): number {
  return parts[share] ? Math.max(1, Math.round(directions * parts[share])) : 0;
}

/** What the planner hears of the person's choice, as a number of directions. */
export function shareLine(share: LabShare, most: number): string {
  return share === 'close'
    ? 'The person chose work close to known work, so no direction of your plan is a long shot.'
    : `The person chose ${share === 'far' ? '1 direction in 2' : '1 direction in 4'} as long shots: give about ${longShotCount(share, most)} of ${most} directions \`longShot: true\`, and fewer in a smaller plan.`;
}
