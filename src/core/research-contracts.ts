export interface ResearchPlan {
  readonly scope: string;
  readonly personas: readonly {
    readonly name: string;
    readonly task: string;
  }[];
}

export interface ResearchState {
  readonly topic: string;
  readonly autonomy: 'guided' | 'autonomous';
  readonly phase:
    | 'needs-plan'
    | 'awaiting-plan-review'
    | 'needs-research'
    | 'directions';
  readonly sessionId?: string;
  readonly plan?: ResearchPlan;
  readonly latestAttempt?: string;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object.');
  }
  return Object.fromEntries(Object.entries(value));
}

export function text(value: unknown, label: string, limit = 12000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) {
    throw new Error(`Invalid ${label}.`);
  }
  return value.trim();
}

/** Accept JSON or one leading code block with optional plain commentary. */
export function parseHostJson(value: string): unknown {
  if (Buffer.byteLength(value) > 2 * 1024 * 1024)
    throw new Error('Host JSON response exceeds the 2 MiB limit.');
  const input = value.trim();
  if (!input.startsWith('```')) return JSON.parse(input) as unknown;
  const lines = input.split(/\r?\n/);
  if (lines[0] !== '```json' && lines[0] !== '```')
    throw new Error('Host response must start with JSON or a JSON code block.');
  const closing = lines.indexOf('```', 1);
  if (closing === -1) throw new Error('Host JSON code block is not closed.');
  const body = lines.slice(1, closing).join('\n');
  const commentary = lines
    .slice(closing + 1)
    .join('\n')
    .trim();
  if (
    body.includes('```') ||
    commentary.includes('```') ||
    commentary.includes('~~~') ||
    commentary.startsWith('{') ||
    commentary.startsWith('[')
  )
    throw new Error('Host response must contain only one JSON code block.');
  return JSON.parse(body) as unknown;
}

export function parseResearchPlan(value: unknown): ResearchPlan {
  const data = object(value);
  if (
    !Array.isArray(data.personas) ||
    data.personas.length < 2 ||
    data.personas.length > 5
  ) {
    throw new Error('A research plan needs 2 to 5 personas.');
  }
  const personas = data.personas.map((value: unknown) => {
    const persona = object(value);
    return {
      name: text(persona.name, 'persona name', 100),
      task: text(persona.task, 'persona task', 4000),
    };
  });
  if (new Set(personas.map(({ name }) => name)).size !== personas.length) {
    throw new Error('Persona names must be unique.');
  }
  return { scope: text(data.scope, 'search scope'), personas };
}

export function parseResearchState(value: unknown): ResearchState {
  const data = object(value);
  if (data.autonomy !== 'guided' && data.autonomy !== 'autonomous')
    throw new Error('Invalid research autonomy.');
  if (
    data.phase !== 'needs-plan' &&
    data.phase !== 'awaiting-plan-review' &&
    data.phase !== 'needs-research' &&
    data.phase !== 'directions'
  ) {
    throw new Error('Invalid research phase.');
  }
  const plan =
    data.plan === undefined ? undefined : parseResearchPlan(data.plan);
  if (data.phase !== 'needs-plan' && !plan)
    throw new Error('Research plan is missing.');
  const latestAttempt =
    data.latestAttempt === undefined
      ? undefined
      : text(data.latestAttempt, 'attempt ID', 100);
  if (latestAttempt && !/^[a-f0-9-]{36}$/.test(latestAttempt))
    throw new Error('Invalid attempt ID.');
  return {
    topic: text(data.topic, 'research topic', 4000),
    autonomy: data.autonomy,
    phase: data.phase,
    ...(plan ? { plan } : {}),
    ...(latestAttempt ? { latestAttempt } : {}),
    ...(data.sessionId === undefined
      ? {}
      : { sessionId: text(data.sessionId, 'host session ID', 200) }),
  };
}

/** Source links establish traceability, not independent verification of a claim. */
export function sourceUrl(value: unknown): string {
  const input = text(value, 'source URL', 2000);
  const url = new URL(input);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Sources require HTTP or HTTPS URLs without credentials.');
  return url.href;
}
