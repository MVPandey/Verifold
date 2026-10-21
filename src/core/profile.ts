export interface Profile {
  readonly name: string;
  readonly interests: readonly string[];
  readonly scholar: string;
  readonly github: string;
  readonly session: string;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length > max)
    throw new Error(`${label} is invalid.`);
  return value.trim();
}

function link(value: unknown, label: string, hosts: readonly string[]): string {
  const result = text(value, label, 500);
  if (!result) return '';
  const url = new URL(result);
  if (
    url.protocol !== 'https:' ||
    !hosts.includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error(`${label} must be an HTTPS link to ${hosts.join(' or ')}.`);
  }
  return url.href;
}

/** Validate imported or user-entered profile data. Session references are labels, never filesystem permissions. */
export function parseProfile(input: unknown): Profile {
  if (!input || typeof input !== 'object')
    throw new Error('Profile is invalid.');
  if (
    !(
      'name' in input &&
      'interests' in input &&
      'scholar' in input &&
      'github' in input &&
      'session' in input
    )
  )
    throw new Error('Profile is incomplete.');
  const name = text(input.name, 'Name', 80);
  if (!name) throw new Error('Enter your name.');
  if (!Array.isArray(input.interests) || input.interests.length > 12)
    throw new Error('Choose up to 12 interests.');
  const interests = [
    ...new Set(
      input.interests
        .map((item: unknown) => text(item, 'Interest', 80))
        .filter(Boolean),
    ),
  ];
  if (!interests.length) throw new Error('Add at least one research interest.');
  return Object.freeze({
    name,
    interests: Object.freeze(interests),
    scholar: link(input.scholar, 'Scholar', ['scholar.google.com']),
    github: link(input.github, 'GitHub', ['github.com']),
    session: text(input.session, 'Session reference', 500),
  });
}
