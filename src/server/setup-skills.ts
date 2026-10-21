import { loadMemory, parseCard } from '../core/agency.ts';
import type { runHarness } from '../core/harness.ts';
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

  async view(): Promise<SetupSkills> {
    const added = await this.added();
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
    };
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
