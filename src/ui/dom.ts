/** Escape all interpolated text, including values restored from browser storage. */
export function escapeHtml(value: string | number): string {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ] ?? character,
  );
}
export function requiredElement<T extends Element>(
  root: ParentNode,
  selector: string,
  constructor: { new (...args: never[]): T },
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof constructor))
    throw new Error(`Missing element: ${selector}`);
  return element;
}
