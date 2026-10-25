import {
  loadMemory,
  loadOwnChoices,
  ownSkillName,
  parseCard,
  whenLimit,
  writeOwnChoices,
  type OwnChange,
} from '../core/agency.ts';
import type { runHarness } from '../core/harness.ts';
import type { OwnSkill } from '../core/own-skills.ts';
import type { ChatHarness } from '../core/profile-chat.ts';
import { SessionActionError } from '../core/session.ts';
import {
  addSkill,
  loadSkills,
  removeSkill,
  searchSkills,
  type AddedSkill,
  type GitHubHosts,
  type SkillSearch,
} from '../core/skills.ts';
import type { SetupSkills, SkillCard } from '../protocol/api.ts';

/** The most choices in one request: more than both harnesses list. */
const choicesLimit = 600;
/** A list of the person's own skills older than this is read again when the page asks. */
const ownMs = 5 * 60_000;

function fail(message: string): never {
  throw new SessionActionError(message);
}

/** A reason that the person can read: Verifold's own, or the error's first 300 characters. */
function reason(error: unknown, fallback: string): string {
  if (error instanceof SessionActionError) return error.message;
  return error instanceof Error
    ? `${fallback} ${error.message.slice(0, 300)}`
    : fallback;
}

export interface SkillsStepOptions {
  readonly directory: string;
  readonly signal: AbortSignal;
  readonly harness?: typeof runHarness;
  readonly hosts?: GitHubHosts;
  /** The harness that picks the cards: the one that runs the "About you" conversation. */
  readonly picker: () => Promise<ChatHarness | null>;
  /** Run a change of the profile under its lock. */
  readonly locked: <T>(work: () => Promise<T>) => Promise<T>;
  /** The skills that the person's own harnesses load. Without it, the step lists none. */
  readonly ownSkills?: () => Promise<readonly OwnSkill[]>;
}

/** The choices of a `setup-own-skills` request, or a reason that the person can read. */
function ownChanges(value: unknown): OwnChange[] {
  if (!Array.isArray(value) || !value.length || value.length > choicesLimit)
    fail(`Send from 1 to ${choicesLimit} skill choices.`);
  return value.map((entry: unknown): OwnChange => {
    const data =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)
        : {};
    const { harness, name, use, when } = data;
    if (
      (harness !== 'claude' && harness !== 'codex') ||
      typeof name !== 'string' ||
      !ownSkillName.test(name) ||
      typeof use !== 'boolean'
    )
      fail('Each skill choice needs a harness, the skill name, and yes or no.');
    if (
      when !== undefined &&
      (typeof when !== 'string' || when.length > whenLimit)
    )
      fail(`Write at most ${whenLimit} characters on when to use a skill.`);
    return { harness, name, use, ...(when === undefined ? {} : { when }) };
  });
}

/**
 * The first run's Skills step: the last search, held in memory, and the
 * skills that the person added, in the profile folder. A search and an add
 * run in the background, one at a time. The page asks again while one runs.
 */
export class SkillsStep {
  private readonly options: SkillsStepOptions;
  private found: SkillSearch | null = null;
  private busy: 'search' | 'add' | null = null;
  private problem: string | null = null;
  /** The person's own skills, and when Verifold listed them. */
  private own: {
    readonly at: number;
    readonly skills: readonly OwnSkill[];
  } | null = null;
  private listing: Promise<void> | null = null;

  constructor(options: SkillsStepOptions) {
    this.options = options;
  }

  /** What the search matches: "You work on" and "To explore", or a profile in free form. */
  private async profile(): Promise<string | null> {
    const markdown = await loadMemory(this.options.directory).catch(
      () => undefined,
    );
    if (!markdown) return null;
    const card = parseCard(markdown);
    const text = card ? `${card.workOn}\n${card.explore}` : markdown;
    return text.trim() || null;
  }

  private added(): Promise<AddedSkill[]> {
    return loadSkills(this.options.directory).catch(() => []);
  }

  /** List the person's own skills in the background, once, or again when the list is old. */
  private listOwn(): void {
    const list = this.options.ownSkills;
    if (!list || this.listing || (this.own && Date.now() - this.own.at < ownMs))
      return;
    this.listing = list()
      .then((skills) => {
        this.own = { at: Date.now(), skills };
      })
      .catch(() => {
        this.own = { at: Date.now(), skills: [] };
      })
      .finally(() => {
        this.listing = null;
      });
  }

  async view(): Promise<SetupSkills> {
    this.listOwn();
    const added = await this.added();
    // Choices that cannot be read show each skill as on, which is what agents then load.
    const choices = await loadOwnChoices(this.options.directory).catch(
      () => null,
    );
    // The search and `busy` are read with no wait between them, so a search that ends meanwhile never shows as neither.
    const found = this.found;
    return {
      busy: this.busy,
      search: found
        ? { at: found.at, catalogs: found.catalogs, picker: found.picker }
        : null,
      cards: (found?.cards ?? []).map(({ skill, ...card }): SkillCard => {
        const mine = added.find((entry) => entry.id === skill.id);
        return {
          id: skill.id,
          name: skill.name,
          what: card.what,
          repo: `${skill.owner}/${skill.repo}`,
          commit: skill.commit,
          path: skill.path,
          updated: card.updated,
          license: card.license,
          runs: card.runs,
          state: !mine ? 'new' : mine.tree === skill.tree ? 'added' : 'update',
        };
      }),
      added: added.map(({ id, name, repo, commit, path, addedAt }) => ({
        id,
        name,
        repo,
        commit,
        path,
        addedAt,
      })),
      needsProfile: (await this.profile()) === null,
      problem: this.problem,
      own: (this.own?.skills ?? []).map((skill) => {
        const choice = choices?.[skill.harness].get(skill.name);
        return { ...skill, use: choice?.use ?? true, when: choice?.when ?? '' };
      }),
      ownReading: this.own === null && this.listing !== null,
    };
  }

  /** Save the person's choices for their own skills. */
  async ownChoices(value: unknown): Promise<number> {
    const changes = ownChanges(value);
    await this.options.locked(() =>
      writeOwnChoices(this.options.directory, changes),
    );
    return 200;
  }

  private idle(): void {
    if (this.busy)
      fail('Verifold reads the catalogs or adds a skill now. Wait a moment.');
  }

  /** Read the catalogs and match them to the profile. The view shows the cards when they come. */
  search(): number {
    this.idle();
    this.busy = 'search';
    this.problem = null;
    const { signal } = this.options;
    void (async () => {
      try {
        const profile = await this.profile();
        const added = await this.added();
        if (!profile && !added.length)
          fail(
            'Fill in "About you" first. The search matches skills to your profile.',
          );
        this.found = await searchSkills({
          directory: this.options.directory,
          profile: profile ?? '',
          picker: await this.options.picker(),
          added,
          signal,
          ...(this.options.harness ? { run: this.options.harness } : {}),
          ...(this.options.hosts ? { hosts: this.options.hosts } : {}),
        });
      } catch (error) {
        if (!signal.aborted)
          this.problem = reason(
            error,
            'Verifold could not read the skill catalogs.',
          );
      } finally {
        this.busy = null;
      }
    })();
    return 202;
  }

  /** Add a skill of the last search. The view shows it as added, or why it is not. */
  add(id: unknown): number {
    this.idle();
    const card =
      this.found?.cards.find((entry) => entry.skill.id === id) ??
      fail('That skill is not in the last search. Search again.');
    this.busy = 'add';
    this.problem = null;
    const { signal } = this.options;
    void addSkill({
      directory: this.options.directory,
      skill: card.skill,
      license: card.license,
      signal,
      locked: this.options.locked,
      ...(this.options.hosts ? { hosts: this.options.hosts } : {}),
    })
      .catch((error: unknown) => {
        if (!signal.aborted)
          this.problem = reason(error, 'Verifold could not add the skill.');
      })
      .finally(() => {
        this.busy = null;
      });
    return 202;
  }

  async remove(id: unknown): Promise<number> {
    this.idle();
    if (typeof id !== 'string') fail('Name the skill to remove.');
    this.problem = null;
    await removeSkill({
      directory: this.options.directory,
      id,
      locked: this.options.locked,
    });
    return 200;
  }
}
