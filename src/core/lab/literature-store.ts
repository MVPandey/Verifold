/**
 * The lab's reading, in `.verifold/lab/literature.json`: lookups and helpers
 * from harness records, the reading map, the idea map, and the record of
 * draws. It keeps them in memory, read once at load, and applies the pure rules
 * of literature.ts, helpers.ts, and ideas.ts. A harness event changes memory in
 * one synchronous step, so events need no queue. A harness can write in the
 * project, so the file is parsed with care and a bad record is skipped.
 */
import { object, type Post, type PostKind } from '../board.ts';
import { longShotLimits, readingLimits } from '../lab-tools.ts';
import type { TranscriptUpdate } from '../transcript.ts';
import {
  afterProcess,
  helpersAfter,
  lostLine,
  parseHelper,
} from './helpers.ts';
import { parseIdea, withIdea, type Idea } from './ideas.ts';
import {
  labLookups,
  lookupOf,
  noLookups,
  noSearchYet,
  parseLookups,
  parseSource,
  withLookup,
  type LookupRecord,
  type Source,
} from './literature.ts';
import { readObject, RecordFile } from './record-file.ts';
import { fail, text, type Helper, type Reading } from './schema.ts';

/** One draw of long shots. */
export interface DrawRecord {
  readonly at: string;
  /** `ruled-out`: a failed line of work started it. */
  readonly by: 'person' | 'ruled-out';
  /** The agent ID of its session. */
  readonly agent: string;
  /** The combinations that it drew, by key. */
  readonly drawn: readonly string[];
}

function parseDraw(value: unknown): DrawRecord | null {
  const entry = object(value);
  return entry &&
    typeof entry.at === 'string' &&
    !Number.isNaN(Date.parse(entry.at)) &&
    (entry.by === 'person' || entry.by === 'ruled-out') &&
    typeof entry.agent === 'string' &&
    /^a-[1-9]\d{0,3}$/.test(entry.agent) &&
    Array.isArray(entry.drawn)
    ? {
        at: entry.at,
        by: entry.by,
        agent: entry.agent,
        drawn: entry.drawn
          .filter(
            (key): key is string => typeof key === 'string' && key.length < 40,
          )
          .slice(0, longShotLimits.batch),
      }
    : null;
}

const list = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

/** The newest entries of a saved list, by the agent that each one names. */
function byAgent<T>(
  value: unknown,
  parse: (entry: Record<string, unknown>) => T | null,
): Map<string, T> {
  return new Map(
    list(value)
      .slice(-readingLimits.agents)
      .flatMap((item) => {
        const entry = object(item);
        const parsed = entry ? parse(entry) : null;
        return parsed !== null &&
          typeof entry?.agent === 'string' &&
          /^a-[1-9]\d{0,3}$/.test(entry.agent)
          ? [[entry.agent, parsed] as const]
          : [];
      }),
  );
}

/** Set an agent's entry, and drop the agent that changed longest ago when the map is full. */
function put<T>(map: Map<string, T>, agent: string, value: T): void {
  map.delete(agent);
  map.set(agent, value);
  for (const old of [...map.keys()].slice(0, -readingLimits.agents))
    map.delete(old);
}

export class LiteratureStore {
  private lookups = new Map<string, LookupRecord>();
  private helpers = new Map<string, readonly Helper[]>();
  private map: readonly Source[] = [];
  private ideaMap: readonly Idea[] = [];
  private drawList: readonly DrawRecord[] = [];
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
              seen: undefined,
            })),
            helpers: [...this.helpers].map(([agent, helpers]) => ({
              agent,
              helpers,
            })),
            sources: this.map,
            ideas: this.ideaMap,
            draws: this.drawList,
          },
    );
  }

  /** Read the records. `on`: a lab with threads. Any other lab holds none. */
  async load(on: boolean): Promise<void> {
    const saved = on ? await readObject(this.path) : null;
    this.lookups = byAgent(saved?.lookups, parseLookups);
    this.helpers = byAgent(saved?.helpers, (entry) =>
      list(entry.helpers)
        .flatMap((item) => parseHelper(item) ?? [])
        .slice(-readingLimits.helpers),
    );
    this.map = list(saved?.sources)
      .slice(0, readingLimits.sources)
      .flatMap((item) => parseSource(item) ?? []);
    this.ideaMap = list(saved?.ideas)
      .slice(0, readingLimits.ideas)
      .flatMap((item) => parseIdea(item) ?? []);
    this.drawList = list(saved?.draws)
      .slice(-longShotLimits.draws)
      .flatMap((item) => parseDraw(item) ?? []);
  }

  /** Wait until the newest records are on disk. */
  flush(): Promise<void> {
    return this.file.flush();
  }

  /** A failed save comes again with the next one. */
  private save(): void {
    void this.file.save().catch(() => {});
  }

  /**
   * One update of a harness. Lookups count for the session's agent, with its
   * subagents. `handle`: the name of an agent that owns a direction, which
   * has helpers. `launch`: the process that reported the update.
   */
  heard(
    agent: string,
    handle: string | null,
    launch: string,
    update: TranscriptUpdate,
    at: string,
  ): void {
    const lookup = lookupOf(update);
    const before = this.lookups.get(agent) ?? noLookups;
    const counted = lookup
      ? withLookup(before, `${launch}:${lookup.id}`, lookup.title, at)
      : before;
    if (counted !== before) put(this.lookups, agent, counted);
    const helpers = this.helpers.get(agent) ?? [];
    const next = handle
      ? helpersAfter(helpers, update, handle, launch, at)
      : helpers;
    if (next !== helpers) put(this.helpers, agent, next);
    if (counted !== before || next !== helpers) this.save();
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
            `- ${idea.id} [${idea.tried ? 'tried' : 'not tried'}] ${JSON.stringify(idea.text)}${idea.sources.length ? ` from ${idea.sources.join(', ')}` : ''}`,
        )
        .join('\n') || 'The idea map holds no idea yet.'
    );
  }

  ideas(): readonly Idea[] {
    return this.ideaMap;
  }

  /** The draws, oldest first. */
  draws(): readonly DrawRecord[] {
    return this.drawList;
  }

  /** Record a draw. A failed save comes again with the next one. */
  addDraw(draw: DrawRecord): void {
    this.drawList = [...this.drawList, draw].slice(-longShotLimits.draws);
    this.save();
  }

  /** An agent's helpers, oldest first. */
  helpersOf(agent: string): readonly Helper[] {
    return this.helpers.get(agent) ?? [];
  }

  /** A helper of the agent runs now. */
  helping(agent: string): boolean {
    return this.helpersOf(agent).some((helper) => helper.state === 'running');
  }

  /**
   * The helpers that stopped with no result and that their agents have not
   * heard of, each with the line for its agent, once. `live`: the process of
   * an agent that runs now. A helper of any other process is lost.
   */
  lostHelpers(
    live: (agent: string) => string | null,
  ): readonly { readonly agent: string; readonly line: string }[] {
    const at = new Date().toISOString();
    const lines: { agent: string; line: string }[] = [];
    for (const [agent, helpers] of this.helpers) {
      if (!helpers.some((helper) => helper.state !== 'done' && !helper.told))
        continue;
      const after = afterProcess(helpers, live(agent), at);
      const told = after.map((helper) =>
        helper.state === 'lost' && !helper.told
          ? { ...helper, told: true as const }
          : helper,
      );
      lines.push(
        ...after
          .filter((helper) => helper.state === 'lost' && !helper.told)
          .map((helper) => ({ agent, line: lostLine(helper) })),
      );
      if (after !== helpers || told.some((helper, i) => helper !== after[i])) {
        this.helpers.set(agent, told);
        this.save();
      }
    }
    return lines;
  }
}
