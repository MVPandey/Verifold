/**
 * Return the place that Tab goes to from the edge of a group of `count` controls, so that focus stays in the
 * group, or `null` where the browser's own Tab stays inside it. `at` is the place of the focused control, or -1
 * when focus is outside the group. `back` is Shift+Tab.
 */
export function wrapFocus(count: number, at: number, back: boolean): number | null {
  if (count === 0) return null;
  if (at < 0) return back ? count - 1 : 0;
  if (back) return at === 0 ? count - 1 : null;
  return at === count - 1 ? 0 : null;
}
