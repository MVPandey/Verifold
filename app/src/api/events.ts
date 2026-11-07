/**
 * Call `onChange` whenever the lab or an agent's activity changes, until the returned function is called.
 *
 * The event stream says only that something changed, and the app reads the views again. A browser's EventSource
 * cannot set headers, so the token goes in the query, as the server expects.
 */
export function watchChanges(token: string, onChange: () => void): () => void {
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  source.addEventListener('change', onChange);
  return () => {
    source.close();
  };
}
