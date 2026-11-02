/**
 * The lab's reading, in `.verifold/lab/literature.json`: lookups from harness
 * records, the reading map, and the idea map. It keeps them in memory, read
 * once at load, and applies the pure rules of literature.ts and ideas.ts. A
 * harness event changes memory in one synchronous step, so events need no
 * queue. A harness can write in the project, so the file is parsed with care
 * and a bad record is skipped.
 */
import type { Post, PostKind } from '../board.ts';
import { readingLimits } from '../lab-tools.ts';
import { webRead, type TranscriptUpdate } from '../transcript.ts';
import { parseIdea, withIdea, type Idea } from './ideas.ts';
import {
  afterRead,
  labLookups,
  noLookups,
  noSearchYet,
  parseLookups,
  parseSource,
  searchSince,
  type LookupRecord,
  type Source,
} from './literature.ts';
import {
  agentEntries,
  putAgent,
  readObject,
  RecordFile,
} from './record-file.ts';
import { fail, text, type Reading } from './schema.ts';

const list = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

export class LiteratureStore {
  private lookups = new Map<string, LookupRecord>();
  private map: readonly Source[] = [];
  private ideaMap: readonly Idea[] = [];
  private readonly path: string;
  private readonly file: RecordFile;

  /** `paused`: the lab's records moved, so nothing writes until the next load. */
  constructor(path: string, paused: () => boolean) {
    this.path = path;
    this.file = new RecordFile(path, () =>
      paused()
        ? null
        : {
            schemaVersion: 1,
            lookups: [...this.lookups].map(([agent, record]) => ({
              ...record,
              agent,
              pending: undefined,
              seen: undefined,
            })),
            sources: this.map,
            ideas: this.ideaMap,
          },
    );
  }

  /** Read the records. `on`: a lab with threads. Any other lab holds none. */
  async load(on: boolean): Promise<void> {
    const saved = on ? await readObject(this.path) : null;
    this.lookups = agentEntries(saved?.lookups, parseLookups);
    this.map = list(saved?.sources)
      .slice(0, readingLimits.sources)
      .flatMap((item) => parseSource(item) ?? []);
    this.ideaMap = list(saved?.ideas)
      .slice(0, readingLimits.ideas)
      .flatMap((item) => parseIdea(item) ?? []);
  }

  /** Wait until the newest records are on disk. */
  flush(): Promise<void> {
    return this.file.flush();
  }

  /** A failed save comes again with the next one. */
  private save(): void {
    void this.file.save().catch(() => {});
  }

  /** One update of a harness, from the process `launch`. Lookups count for the session's agent, with its subagents. */
  heard(
    agent: string,
    launch: string,
    update: TranscriptUpdate,
    at: string,
  ): void {
    const read = webRead(update);
    if (!read) return;
    const before = this.lookups.get(agent) ?? noLookups;
    const after = afterRead(before, `${launch}:${read.id}`, read, at);
    if (after === before) return;
    putAgent(this.lookups, agent, after);
    if (after.count !== before.count) this.save();
  }

  /** Whether a new post of `author` shows "No search yet". */
  noSearch(author: string, kind: PostKind, posts: readonly Post[]): boolean {
    return noSearchYet(
      kind,
      this.lookups.get(author)?.last ?? null,
      posts.findLast(
        (post) =>
          post.author === author &&
          (post.kind === 'proposal' || post.kind === 'ruled-out'),
      )?.at,
    );
  }

  /**
   * What the harness records say of the search behind a new post of `author`.
   * An agent's own words never set these. `label`: a helper's label by its ID.
   */
  marks(
    author: string,
    kind: PostKind,
    posts: readonly Post[],
    label: (helper: string) => string | undefined,
  ): Pick<Post, 'noSearch' | 'search'> {
    if (kind !== 'proposal' && kind !== 'ruled-out') return {};
    const search = searchSince(this.lookups.get(author), posts, author, label);
    return {
      ...(this.noSearch(author, kind, posts)
        ? { noSearch: true as const }
        : {}),
      ...(search ? { search } : {}),
    };
  }

  /** The lab's reading, for a screen. */
  reading(): Reading {
    const lab = labLookups([...this.lookups.values()]);
    return {
      papers: this.map.length,
      lookups: lab.count,
      lastPaperAt: lab.lastPaper?.at ?? null,
    };
  }

  /** `verifold_source`. Returns the reply to the agent. */
  async addSource(by: string, args: Record<string, unknown>): Promise<string> {
    const title = text(args.title, readingLimits.title, 'the title of a paper');
    const url = text(args.url, readingLimits.url, 'the address of the paper');
    if (!/^https?:\/\//i.test(url))
      fail('Give the address of the paper, with http or https.');
    const date = text(args.date, readingLimits.date, "the paper's date");
    const ideas = list(args.ideas)
      .slice(0, readingLimits.ideasPerSource)
      .map((idea) => text(idea, readingLimits.idea, 'each idea'));
    const known = this.map.find((source) => source.url === url);
    if (!known && this.map.length >= readingLimits.sources)
      fail(`The reading map holds ${readingLimits.sources} papers, the limit.`);
    const at = new Date().toISOString();
    const last = Math.max(0, ...this.map.map(({ id }) => Number(id.slice(2))));
    const source = known ?? { id: `s-${last + 1}`, title, url, date, by, at };
    if (!known) this.map = [...this.map, source];
    this.ideaMap = ideas.reduce(
      (map, idea) =>
        withIdea(map, { text: idea, tried: false, by, at, source: source.id }),
      this.ideaMap,
    );
    await this.file.save().catch(() => {});
    return `${source.id} is on the reading map, with ${ideas.length} ideas.`;
  }

  /** `verifold_idea`. Returns the reply to the agent. */
  async addIdea(by: string, args: Record<string, unknown>): Promise<string> {
    const idea = text(args.text, readingLimits.idea, 'the idea');
    if (typeof args.tried !== 'boolean')
      fail('Say with tried whether the lab tried this idea.');
    const at = new Date().toISOString();
    const next = withIdea(this.ideaMap, {
      text: idea,
      tried: args.tried,
      by,
      at,
    });
    if (next === this.ideaMap)
      fail(`The idea map holds ${readingLimits.ideas} ideas, the limit.`);
    this.ideaMap = next;
    await this.file.save().catch(() => {});
    return `The idea is on the map, as ${next.find((entry) => entry.text === idea)?.id ?? 'a new idea'}.`;
  }

  /** `verifold_tried`: one idea gets its tried mark, with the post that tried it. Returns the reply to the session. */
  async markTried(id: unknown, post: string): Promise<string> {
    const idea =
      this.ideaMap.find((entry) => entry.id === id) ??
      fail('Name an idea of the map, such as i-3.');
    if (idea.tried) return `${idea.id} has its tried mark already.`;
    this.ideaMap = this.ideaMap.map((entry) =>
      entry === idea ? { ...entry, tried: true, post } : entry,
    );
    await this.file.save().catch(() => {});
    return `${idea.id} is marked tried, with ${post}.`;
  }

  /** The reading map, newest last, one line each. Agents wrote its texts, so they are quoted. */
  sourceLines(limit: number): string {
    return (
      this.map
        .slice(-limit)
        .map(
          (source) =>
            `- ${source.id} ${JSON.stringify(source.title)}, ${JSON.stringify(source.date)}: ${JSON.stringify(source.url)}`,
        )
        .join('\n') || 'The reading map holds no paper yet.'
    );
  }

  /** The idea map, newest last, one line each. Agents wrote its texts, so they are quoted. */
  ideaLines(limit: number): string {
    return (
      this.ideaMap
        .slice(-limit)
        .map(
          (idea) =>
            `- ${idea.id} [${idea.tried ? `tried${idea.post ? ` in ${idea.post}` : ''}` : 'not tried'}] ${JSON.stringify(idea.text)}${idea.sources.length ? ` from ${idea.sources.join(', ')}` : ''}`,
        )
        .join('\n') || 'The idea map holds no idea yet.'
    );
  }

  ideas(): readonly Idea[] {
    return this.ideaMap;
  }

  sources(): readonly Source[] {
    return this.map;
  }
}
