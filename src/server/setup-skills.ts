import {
  loadMemory,
  offTarget,
  ownChoicesFile,
  ownChoicesReader,
  ownLimits,
  parseCard,
  writeOwnChoices,
  type OwnChange,
} from '../core/agency.ts';
import type { runHarness } from '../core/harness.ts';
import type { OwnSkill, OwnSkills } from '../core/own-skills.ts';
import type { ImportedSkill } from '../core/profile-import.ts';
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
  /** List the skills that the person's own harnesses load. `signal` stops the listing. Without it, the step lists none. */
  readonly ownSkills?: (signal: AbortSignal) => Promise<OwnSkills>;
}

/**
 * The choices of a `setup-own-skills` request, each for a skill of the last
 * list, which says what turns it off. Otherwise a reason that the person
 * can read.
 */
function ownChanges(
  value: unknown,
  listed: readonly OwnSkill[] | null,
): OwnChange[] {
  if (!listed) fail('Verifold has not listed your skills yet. Read the list.');
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > ownLimits.choices
  )
    fail(`Send from 1 to ${ownLimits.choices} skill choices.`);
  return value.map((entry: unknown): OwnChange => {
    const data =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)
        : {};
    const { harness, id, use, when } = data;
    if (
      (harness !== 'claude' && harness !== 'codex') ||
      !offTarget(harness, id) ||
      typeof use !== 'boolean'
    )
      fail('Each skill choice needs a harness, the skill, and yes or no.');
    if (
      when !== undefined &&
      (typeof when !== 'string' || when.length > ownLimits.when)
    )
      fail(
        `Write at most ${ownLimits.when} characters on when to use a skill.`,
      );
    const skill =
      listed.find((entry) => entry.harness === harness && entry.id === id) ??
      fail('Verifold does not list that skill now. Read the list again.');
    return {
      harness,
      id,
      name: skill.name,
      use,
      off: skill.off,
      ...(when === undefined ? {} : { when }),
    };
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
  /** The last list of the person's own skills, and what Verifold could not list then. Null: no list yet. */
  private own: readonly OwnSkill[] | null = null;
  private ownProblems: readonly string[] = [];
  /** A save moved an unreadable file of choices aside. The step says so. */
  private moved: string | null = null;
  /** The choices, read again only when the file changes. */
  private readonly choices: ReturnType<typeof ownChoicesReader>;
  private listing: Promise<void> | null = null;

  constructor(options: SkillsStepOptions) {
    this.options = options;
    this.choices = ownChoicesReader(options.directory);
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

  /**
   * List the person's own skills in the background. The Skills step asks
   * for it, and no other read starts it. A list with skills serves until
   * `again`. An empty list, or one that failed, is read again.
   */
  listOwn(again: unknown): number {
    const list = this.options.ownSkills;
    if (!list) return 200;
    if (this.listing) return 202;
    if (again !== true && this.own?.length) return 200;
    const { signal } = this.options;
    this.listing = list(signal)
      .then(({ skills, problems }) => {
        this.own = skills;
        this.ownProblems = problems;
      })
      .catch((error: unknown) => {
        if (!signal.aborted)
          this.ownProblems = [
            reason(error, 'Verifold could not list your skills.'),
          ];
      })
      .finally(() => {
        this.listing = null;
      });
    return 202;
  }

  /** The listed skills. Without a list that has skills, it lists them first and waits. */
  async ownList(): Promise<readonly OwnSkill[]> {
    this.listOwn(false);
    await this.listing;
    return this.own ?? [];
  }

  /**
   * Save an import's choices: Yes with its note for each skill that fits,
   * No for the rest. A skill that the list no longer has stays as it is.
   */
  async importChoices(skills: readonly ImportedSkill[]): Promise<void> {
    const listed = new Set(
      (this.own ?? []).map((skill) => `${skill.harness}\0${skill.id}`),
    );
    const choices = skills
      .filter((skill) => listed.has(`${skill.harness}\0${skill.id}`))
      .map((skill) => ({
        harness: skill.harness,
        id: skill.id,
        use: skill.fits,
        ...(skill.fits ? { when: skill.when } : {}),
      }));
    if (choices.length) await this.ownChoices(choices);
  }

  async view(): Promise<SetupSkills> {
    const added = await this.added();
    // Choices that cannot be read show each skill as on, which is what agents then load.
    const choices = await this.choices();
    const file = ownChoicesFile(this.options.directory);
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
      ...(this.own
        ? {
            own: this.own.map((skill) => {
              const choice = choices?.[skill.harness].get(skill.id);
              return {
                harness: skill.harness,
                id: skill.id,
                name: skill.name,
                description: skill.description,
                source: skill.source,
                use: choice?.use ?? true,
                when: choice?.when ?? '',
              };
            }),
          }
        : {}),
      ownReading: this.listing !== null,
      ownProblems: [
        ...this.ownProblems,
        ...(this.moved
          ? [
              `Verifold could not read the earlier choices, so it kept them as ${this.moved} and started a new file.`,
            ]
          : []),
        ...(!choices
          ? [`Verifold could not read ${file}, so agents load all your skills.`]
          : choices.skipped
            ? [
                `Verifold skipped ${choices.skipped} ${choices.skipped === 1 ? 'entry' : 'entries'} of ${file} that it could not read.`,
              ]
            : []),
      ],
      noteLimit: ownLimits.when,
    };
  }

  /** Save the person's choices for their own skills. */
  async ownChoices(value: unknown): Promise<number> {
    const changes = ownChanges(value, this.own);
    const moved = await this.options.locked(() =>
      writeOwnChoices(this.options.directory, changes),
    );
    if (moved) this.moved = moved;
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
