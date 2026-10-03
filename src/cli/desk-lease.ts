/**
 * The input lease of this browser tab. The desk page and a terminal framed in
 * it share one lease; a terminal opened in a new tab gets its own, so it starts
 * read-only. The lease lives in the tab's window name, which survives a reload
 * but is not copied to a new tab.
 */
export function viewLease(): string {
  const top = window.top ?? window;
  if (!/^vf-[a-f0-9]{32}$/.test(top.name)) {
    const random = new Uint8Array(16);
    crypto.getRandomValues(random);
    top.name = `vf-${Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }
  return top.name.slice(3);
}
