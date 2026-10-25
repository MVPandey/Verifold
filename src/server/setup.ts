import {
  cardLimits,
  cardMarkdown,
  loadMemory,
  loadSettings,
  parseCard,
  saveAgencyFile,
  withProfileLock,
  writeSettings,
  type Agency,
  type AgencySettings,
  type ProfileCard,
  type SetupStep,
} from '../core/agency.ts';
import {
  parseProfileMoney,
  profileMoneyDefaults,
  type Compute,
} from '../core/compute.ts';
import { detectHarnesses, type HarnessStatus } from '../core/detect.ts';
import { monthFolder, readMonth, type MonthRead } from '../core/gpu-month.ts';
import {
  installedHarnesses,
  runHarness,
  validateModel,
  type HarnessName,
} from '../core/harness.ts';
import { profileModel } from '../core/models.ts';
import {
  answerLimit,
  answersCard,
  nextStep,
  opening,
  type ChatHarness,
  type ChatLine,
} from '../core/profile-chat.ts';
import { importProfile, type ProfileImport } from '../core/profile-import.ts';
import { commonGpus, type GpuOffer } from '../core/runpod.ts';
import { SessionActionError, hostName } from '../core/session.ts';
import type { OwnSkills } from '../core/own-skills.ts';
import type { GitHubHosts } from '../core/skills.ts';
import type { AgentTool, GpuPrice, SetupView } from '../protocol/api.ts';
import { record } from './http.ts';
import { SkillsStep } from './setup-skills.ts';

function fail(message: string): never {
  throw new SessionActionError(message);
}

/**
 * The GPUs of "Prices now", the dearest first. Without one of the common
 * types, the six cheapest with at least 24 GB that RunPod has in stock.
 */
export function shortlist(offers: readonly GpuOffer[]): GpuPrice[] {
  const known = offers.filter((offer) => commonGpus.includes(offer.id));
  const shown = known.length
    ? known
    : offers
        .filter((offer) => offer.memoryGb >= 24 && offer.stock !== 'NONE')
        .slice(0, 6);
  return shown
    .map((offer) => ({
      id: offer.id,
      name: offer.name,
      memoryGb: offer.memoryGb,
      usdPerHour: offer.price,
    }))
    .sort((a, b) => b.usdPerHour - a.usdPerHour);
}

/** How long an action waits before it answers 202 and goes on in the background. */
const waitMs = 2_000;
/** How long the same intent key gets the same answer. */
const keyMs = 60_000;

export interface FirstRunOptions {
  /** The folder of the person's profile. */
  readonly directory: string;
  /** The RunPod key and prices. A project's own compute, or one for the folder without a project. */
  readonly compute: Compute;
  /** The desk's signal: the agent's reply stops when the desk closes. */
  readonly signal: AbortSignal;
  readonly harness?: typeof runHarness;
  /** Tests use fakes. */
  readonly detect?: () => Promise<readonly HarnessStatus[]>;
  /** The harness commands on the PATH. Tests use fakes. */
  readonly installed?: () => Promise<readonly HarnessName[]>;
  /** Where the Skills step reads GitHub. Tests use a fake server. */
  readonly github?: GitHubHosts;
  /** List the skills that the person's own harnesses load, such as `listOwnSkills`. Without it, the Skills step lists none. */
  readonly ownSkills?: (signal: AbortSignal) => Promise<OwnSkills>;
  /** Claude Code's settings folder, which the import reads. Tests use a fake one. */
  readonly claudeConfig?: string;
}

/**
 * The first run behind `GET /api/v1/setup` and the `setup-*` actions. The
 * "About you" conversation lives in memory until the person saves the card.
 * Each write of the profile holds its lock, so a profile setup in a
 * terminal cannot write at the same time.
 */
/** How long a read of the month across projects serves the setup view. */
const monthReadMs = 5_000;

export class FirstRun {
  private readonly options: FirstRunOptions;
  private detected: readonly HarnessStatus[] | null = null;
  private detecting: Promise<void> | null = null;
  private lines: ChatLine[] = [...opening];
  /** The draft card. Null: no draft, so the saved card shows. */
  private card: ProfileCard | null = null;
  /** The person started the conversation again, so the saved card stays out of it until a new one replaces it. */
  private fresh = false;
  /** An answer is taken, or the agent writes, since this time. */
  private busy: string | null = null;
  /** The card is being saved. The conversation takes nothing meanwhile. */
  private holding = false;
  /** Each start again and each save makes a new conversation. A reply for an older one is dropped. */
  private generation = 0;
  private error: string | null = null;
  /** What a retry runs again: the last reply, with its note. */
  private retryNote: string | null | undefined;
  private reading: Promise<void> | null = null;
  /** A key was stored while prices were read, so they are read once more. */
  private readAgain = false;
  private saving: Promise<void> | null = null;
  private problem: string | null = null;
  /** The last read of the month across projects. The page polls, so a read a few seconds old serves again. */
  private monthRead: { readonly at: number; readonly read: MonthRead } | null =
    null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly requests = new Map<
    string,
    { readonly status: Promise<number>; readonly at: number }
  >();

  private readonly skills: SkillsStep;
  /** The import that runs: when it started, the harnesses that it asks, and what stops it. Null: none runs. */
  private importing: {
    readonly at: string;
    asking: readonly HarnessName[];
    readonly stop: AbortController;
  } | null = null;
  /** An import that the person stopped, until its harnesses end. The next import waits for it. */
  private stopping: Promise<void> = Promise.resolve();
  /** The import's result, until the person accepts or discards it. */
  private imported: ProfileImport | null = null;
  private importError: string | null = null;

  constructor(options: FirstRunOptions) {
    this.options = options;
    this.skills = new SkillsStep({
      directory: options.directory,
      signal: options.signal,
      ...(options.harness ? { harness: options.harness } : {}),
      ...(options.github ? { hosts: options.github } : {}),
      ...(options.ownSkills ? { ownSkills: options.ownSkills } : {}),
      picker: () => this.chatHarness(),
      locked: (work) => this.locked(work),
    });
  }

  /** Look for the harnesses, once at a time. */
  private check(): void {
    this.detecting ??= (this.options.detect ?? detectHarnesses)()
      .then(
        (list) => {
          this.detected = list;
        },
        () => {
          this.detected ??= [];
        },
      )
      .finally(() => {
        this.detecting = null;
      });
  }

  /** The harness that runs the conversation, once the harnesses are known. */
  private async chatHarness(): Promise<ChatHarness | null> {
    if (!this.detected) this.check();
    await this.detecting;
    return chatChoice(
      this.detected ?? [],
      (await loadSettings(this.options.directory)).agency,
    );
  }

  async view(): Promise<SetupView> {
    if (!this.detected) this.check();
    const settings = await this.settings();
    const markdown = await loadMemory(this.options.directory).catch(() => null);
    const saved = markdown ? parseCard(markdown) : null;
    const compute = this.options.compute.view();
    const chat = chatChoice(this.detected ?? [], settings.agency);
    const month = await this.month();
    return {
      steps: {
        agents: settings.steps.agents ?? null,
        about: settings.steps.about ?? null,
        skills: settings.steps.skills ?? null,
        money: settings.steps.money ?? null,
      },
      agents: {
        checking: this.detecting !== null,
        tools: (this.detected ?? []).map((status) =>
          tool(status, settings.agency),
        ),
      },
      about: {
        lines: this.lines,
        card: this.card ?? (this.fresh ? null : saved),
        saved: saved ? 'card' : markdown ? 'text' : null,
        text: markdown && !saved ? markdown : null,
        harness: chat?.host ?? null,
        busy: this.busy,
        error: this.error,
        limits: { answer: answerLimit, ...cardLimits },
        import: await this.importView(),
      },
      skills: await this.skills.view(),
      money: {
        key: compute.key
          ? {
              last4: compute.key.last4,
              place: compute.key.place,
              problem: compute.key.problem ?? null,
            }
          : null,
        keyring: compute.keyring !== null,
        prices:
          compute.gpus && compute.gpusAt
            ? { at: compute.gpusAt, gpus: shortlist(compute.gpus) }
            : null,
        reading: this.reading !== null || this.saving !== null,
        problem: this.problem,
        limits: settings.money ?? profileMoneyDefaults,
        unreadable: settings.unreadMoney
          ? `The saved GPU limits are not valid: ${settings.unreadMoney.reason} They show the defaults until you save new ones.`
          : null,
        month: {
          spentUsd: Math.round(month.spentUsd * 100) / 100,
          problem: month.unknown ?? month.problem,
        },
      },
    };
  }

  /** The month across projects, from each project's record, at most a few seconds old. */
  private async month(): Promise<MonthRead> {
    const now = Date.now();
    if (!this.monthRead || now - this.monthRead.at > monthReadMs)
      this.monthRead = {
        at: now,
        read: await readMonth(monthFolder(this.options.directory), now),
      };
    return this.monthRead.read;
  }

  /** The settings, or a reason that the person can act on. */
  private async settings(): Promise<AgencySettings> {
    try {
      return await loadSettings(this.options.directory);
    } catch (error) {
      fail(
        error instanceof Error
          ? error.message
          : 'Verifold could not read the profile settings.',
      );
    }
  }

  /**
   * Run `work` under the profile's lock, one at a time. A failure, such as
   * a lock that a terminal holds, comes back as a reason for the person.
   */
  private locked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue
      .then(() =>
        withProfileLock(this.options.directory, this.options.signal, work),
      )
      .catch((error: unknown) => {
        if (error instanceof SessionActionError) throw error;
        throw new SessionActionError(
          `Verifold could not save the profile: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Change the settings under the profile's lock. */
  private write(
    change: (current: AgencySettings) => AgencySettings,
  ): Promise<AgencySettings> {
    return this.locked(async () =>
      writeSettings(this.options.directory, await this.withLead(change)),
    );
  }

  /**
   * The change, with a lead harness when the settings have none, so an
   * older Verifold can read the file: Claude Code when it is on the PATH,
   * else Codex, with Codex as the helper when both are. `steps.agents`
   * keeps the record that the person chose nothing.
   */
  private async withLead(
    change: (current: AgencySettings) => AgencySettings,
  ): Promise<(current: AgencySettings) => AgencySettings> {
    const found = await (this.options.installed ?? installedHarnesses)();
    const host: HarnessName =
      found.includes('codex') && !found.includes('claude') ? 'codex' : 'claude';
    const lead: Agency = {
      host,
      ...(host === 'claude' && found.includes('codex')
        ? { helper: 'codex' as const }
        : {}),
    };
    return (current) => {
      const next = change(current);
      return next.agency ? next : { ...next, agency: lead };
    };
  }

  /**
   * Run one `setup-*` action. The same intent key within a minute gets the
   * same answer and runs nothing again. Returns 200, or 202 when it goes on
   * in the background, and the view then shows how it ends.
   */
  act(body: Record<string, unknown>): Promise<number> {
    const key =
      typeof body.key === 'string' && /^[a-f0-9]{32}$/.test(body.key)
        ? body.key
        : null;
    const now = Date.now();
    for (const [old, entry] of this.requests)
      if (entry.at < now - keyMs) this.requests.delete(old);
    const known = key ? this.requests.get(key) : undefined;
    if (known) return known.status;
    const status = this.run(body);
    if (key) {
      this.requests.set(key, { status, at: now });
      // A refused request keeps no answer: the same request again tries again.
      status.catch(() => this.requests.delete(key));
    }
    return status;
  }

  private async run(body: Record<string, unknown>): Promise<number> {
    switch (body.action) {
      case 'setup-agents':
        await this.saveAgents(body);
        return 200;
      case 'setup-check':
        if (!this.detecting) {
          this.detected = null;
          this.check();
        }
        return 200;
      case 'setup-say':
        return this.say(body.text, body.card);
      case 'setup-retry':
        if (this.retryNote === undefined) fail('Nothing waits for a retry.');
        return this.reply(this.retryNote);
      case 'setup-fill':
        this.idle();
        if (!this.lines.some((line) => line.from === 'you'))
          fail('Answer the first question first.');
        this.card = answersCard(this.lines);
        this.error = null;
        this.retryNote = undefined;
        return 200;
      case 'setup-restart':
        this.idle();
        this.reset();
        // A new conversation: the saved card stays saved until "Looks right" replaces it.
        this.fresh = true;
        return 200;
      case 'setup-about':
        await this.saveAbout(body);
        return 200;
      case 'setup-key':
        return this.saveKey(body);
      case 'setup-prices':
        return this.readPrices();
      case 'setup-money':
        await this.saveMoney(body);
        return 200;
      case 'setup-skip':
        await this.skip(body.step);
        return 200;
      case 'setup-skills-search':
        return this.skills.search();
      case 'setup-skill-add':
        return this.skills.add(body.id);
      case 'setup-skill-remove':
        return this.skills.remove(body.id);
      case 'setup-own-skills':
        return this.skills.ownChoices(body.choices);
      case 'setup-own-skills-list':
        return Promise.resolve(this.skills.listOwn(body.again));
      case 'setup-import':
        return this.startImport();
      case 'setup-import-accept':
        await this.acceptImport();
        return 200;
      case 'setup-import-discard':
        // While the import runs, this stops it.
        this.importing?.stop.abort();
        this.importing = null;
        this.imported = null;
        this.importError = null;
        return 200;
      case 'setup-skills-done':
        await this.write((current) => ({
          ...current,
          steps: { ...current.steps, skills: 'done' },
        }));
        return 200;
      default:
        return 400;
    }
  }

  private async saveAgents(body: Record<string, unknown>): Promise<void> {
    const pick = (
      name: HarnessName,
    ): { readonly use: boolean; readonly model: string | undefined } => {
      const entry = record(body[name]) ? body[name] : {};
      const model =
        typeof entry.model === 'string' && entry.model
          ? entry.model
          : undefined;
      try {
        validateModel(model);
      } catch {
        fail(`Choose a model of ${hostName(name)} from the list.`);
      }
      // Verifold's own pick is saved as no choice, so a better default later reaches the agents.
      const first = this.detected?.find((status) => status.harness === name)
        ?.models[0]?.id;
      return {
        use: entry.use === true,
        model: model === first ? undefined : model,
      };
    };
    const claude = pick('claude');
    const codex = pick('codex');
    if (!claude.use && !codex.use)
      fail('Use at least one agent tool, or skip this step.');
    await this.write((current) => {
      // The lead stays while it is in use. Otherwise Claude Code leads.
      const host: HarnessName =
        current.agency &&
        (current.agency.host === 'claude' ? claude : codex).use
          ? current.agency.host
          : claude.use
            ? 'claude'
            : 'codex';
      const lead = host === 'claude' ? claude : codex;
      const helper: HarnessName = host === 'claude' ? 'codex' : 'claude';
      const help = helper === 'claude' ? claude : codex;
      const agency: Agency = {
        host,
        ...(lead.model ? { model: lead.model } : {}),
        ...(help.use
          ? { helper, ...(help.model ? { helperModel: help.model } : {}) }
          : {}),
      };
      return {
        ...current,
        agency,
        steps: { ...current.steps, agents: 'done' },
      };
    });
  }

  /** The import as the page shows it. A skill that the person already chose says so: Accept leaves it as it is. */
  private async importView(): Promise<
    NonNullable<SetupView['about']['import']>
  > {
    const result = this.imported;
    const chosen = result ? await this.skills.savedChoices() : null;
    return {
      busy: this.importing?.at ?? null,
      asking: this.importing?.asking ?? [],
      error: this.importError,
      result: result && {
        ...result,
        skills: result.skills.map((skill) => {
          const choice = chosen?.[skill.harness].get(skill.id);
          return choice ? { ...skill, chosen: choice.use } : skill;
        }),
      },
    };
  }

  /**
   * Ask each harness that the person uses what it knows about them. The
   * view shows the result when it comes. Nothing is saved until the person
   * accepts it. An import that the person stopped ends first.
   */
  private async startImport(): Promise<number> {
    if (this.importing) fail('Verifold asks your agents now. Wait a moment.');
    // Taken before the first wait, so a second request at the same time is refused.
    const run = {
      at: new Date().toISOString(),
      asking: [] as readonly HarnessName[],
      stop: new AbortController(),
    };
    this.importing = run;
    this.imported = null;
    this.importError = null;
    let harnesses: ChatHarness[];
    try {
      await this.stopping;
      if (!this.detected) this.check();
      await this.detecting;
      harnesses = inUse(this.detected ?? [], (await this.settings()).agency);
      if (!harnesses.length)
        fail(
          'No agent that you use is signed in. Sign in to Claude Code or Codex, then try again.',
        );
    } catch (error) {
      if (this.importing === run) this.importing = null;
      throw error;
    }
    if (run.stop.signal.aborted) return 200;
    run.asking = harnesses.map((harness) => harness.host);
    const signal = AbortSignal.any([this.options.signal, run.stop.signal]);
    const work = (async () => {
      try {
        const [merger, skills] = await Promise.all([
          this.chatHarness(),
          this.skills.ownList(),
        ]);
        const result = await importProfile({
          harnesses,
          merger,
          skills,
          signal,
          ...(this.options.harness ? { run: this.options.harness } : {}),
          ...(this.options.claudeConfig
            ? { claudeConfig: this.options.claudeConfig }
            : {}),
        });
        if (!signal.aborted) this.imported = result;
      } catch (error) {
        if (!signal.aborted)
          this.importError =
            error instanceof SessionActionError
              ? error.message
              : `Verifold could not ask your agents${error instanceof Error ? `: ${error.message.slice(0, 300)}` : '.'}`;
      } finally {
        if (this.importing === run) this.importing = null;
      }
    })();
    // A stop leaves the harnesses to end. The next import waits for them.
    run.stop.signal.addEventListener('abort', () => {
      this.stopping = work;
    });
    return 202;
  }

  /**
   * Accept the import: the card becomes the draft, which the person still
   * edits and saves with "Looks right", and each skill that it named and
   * the person never chose is set. It holds the conversation meanwhile, so
   * an answer, a save, or a new start waits.
   */
  private async acceptImport(): Promise<void> {
    const result =
      this.imported ??
      fail('Nothing waits to be accepted. Ask your agents first.');
    this.idle();
    this.holding = true;
    const generation = this.generation;
    try {
      await this.skills.importChoices(result.skills);
    } finally {
      this.holding = false;
    }
    // Discarded, replaced, or the conversation started again meanwhile.
    if (this.imported !== result || generation !== this.generation) return;
    this.imported = null;
    const { card } = result;
    if (card.workOn || card.explore || card.talk) {
      this.card = card;
      this.error = null;
      this.retryNote = undefined;
    }
  }

  /** Refuse a change of the conversation while an answer or a save runs. */
  private idle(): void {
    if (this.busy || this.holding)
      fail(
        'The agent still writes, or the card is being saved. Wait a moment.',
      );
  }

  /** A new conversation. A reply for the one before is dropped when it comes. */
  private reset(): void {
    this.generation += 1;
    this.lines = [...opening];
    this.card = null;
    this.error = null;
    this.retryNote = undefined;
  }

  /**
   * An answer, or, once a card shows, a note on it: on the draft, else on
   * the saved card. The person's edits of the card, if any, are what the
   * note changes. The answer is taken before the first wait, so a second
   * one at the same time is refused.
   */
  private async say(value: unknown, edited: unknown): Promise<number> {
    this.idle();
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) fail('Write an answer first.');
    if (text.length > answerLimit)
      fail(`Write at most ${answerLimit} characters.`);
    this.busy = new Date().toISOString();
    this.error = null;
    try {
      if (!this.card && !this.fresh) {
        const markdown = await loadMemory(this.options.directory).catch(
          () => null,
        );
        this.card = markdown ? parseCard(markdown) : null;
      }
      if (this.card && edited !== undefined) this.card = cardOf(edited);
    } catch (error) {
      this.busy = null;
      throw error;
    }
    this.lines = [...this.lines, { from: 'you', text, suggestions: [] }];
    return this.start(this.card ? text : null);
  }

  /** Ask the agent again. */
  private reply(note: string | null): Promise<number> {
    this.idle();
    this.busy = new Date().toISOString();
    this.error = null;
    return this.start(note);
  }

  /** Start the next reply: a question or the card. The view shows it when it comes. */
  private start(note: string | null): Promise<number> {
    this.retryNote = note;
    void this.turn(note, this.generation);
    return Promise.resolve(202);
  }

  private async turn(note: string | null, generation: number): Promise<void> {
    try {
      const harness = await this.chatHarness();
      const step = await nextStep({
        lines: this.lines,
        card: this.card,
        note,
        harness,
        signal: this.options.signal,
        ...(this.options.harness ? { run: this.options.harness } : {}),
      });
      // The person started again or saved meanwhile: this reply is for a conversation that ended.
      if (generation !== this.generation) return;
      if ('card' in step) this.card = step.card;
      else
        this.lines = [
          ...this.lines,
          {
            from: harness?.host ?? 'verifold',
            text: step.question,
            suggestions: step.suggestions,
            ...(step.asks ? { asks: step.asks } : {}),
          },
        ];
      this.retryNote = undefined;
    } catch (error) {
      if (this.options.signal.aborted || generation !== this.generation) return;
      this.error =
        error instanceof SessionActionError
          ? error.message
          : `The agent did not answer${error instanceof Error ? `: ${error.message.slice(0, 300)}` : '.'} Try again, or fill the card from your answers.`;
    } finally {
      this.busy = null;
    }
  }

  private async saveAbout(body: Record<string, unknown>): Promise<void> {
    this.idle();
    // The conversation takes nothing until the save ends.
    this.holding = true;
    try {
      if (body.keep === true) {
        const markdown = await loadMemory(this.options.directory).catch(
          () => null,
        );
        if (!markdown) fail('No profile is saved to keep.');
        await this.write((current) => ({
          ...current,
          steps: { ...current.steps, about: 'done' },
        }));
      } else {
        const card = cardOf(body.card);
        const change = await this.withLead((current) => ({
          ...current,
          steps: { ...current.steps, about: 'done' },
        }));
        await this.locked(async () => {
          await saveAgencyFile(
            this.options.directory,
            'USER.md',
            cardMarkdown(card),
          );
          // A profile setup in the terminal sees an accepted profile too.
          await saveAgencyFile(
            this.options.directory,
            'profile-state.json',
            JSON.stringify({ schemaVersion: 1, status: 'accepted' }, null, 2),
          );
          await writeSettings(this.options.directory, change);
        });
        this.reset();
      }
      this.fresh = false;
    } finally {
      this.holding = false;
    }
  }

  /**
   * Wait for slow work a moment. It answers 200 when the work ended, and
   * the reason when it failed. After the wait it answers 202, and a later
   * failure shows in the view.
   */
  private background(
    work: Promise<void>,
    failed: string,
    asked = true,
  ): Promise<number> {
    // Work that no request waits for shows its failure in the view at once.
    let late = !asked;
    const tracked = work.catch((error: unknown) => {
      const message =
        error instanceof SessionActionError ? error.message : failed;
      if (!late) throw new SessionActionError(message);
      this.problem = message;
    });
    return Promise.race([
      tracked.then(() => 200),
      new Promise<number>((resolve) =>
        setTimeout(() => {
          late = true;
          resolve(202);
        }, waitMs).unref(),
      ),
    ]);
  }

  /** Check the key with RunPod, store it, then read the prices. No message holds the key. */
  private saveKey(body: Record<string, unknown>): Promise<number> {
    if (this.saving) fail('Verifold checks a key now. Wait a moment.');
    this.problem = null;
    const work = this.options.compute
      .setKey(body.runpodKey, body.file === true)
      .then(() => {
        this.readPrices(false).catch(() => {});
      });
    this.saving = work.then(
      () => {
        this.saving = null;
      },
      () => {
        this.saving = null;
      },
    );
    return this.background(work, 'Verifold could not store the key.');
  }

  private readPrices(asked = true): Promise<number> {
    if (!this.options.compute.keySaved())
      fail('Add a RunPod key first. Prices come from RunPod with your key.');
    // A read that runs may use the key before this one, so one more read follows it.
    if (this.reading) {
      this.readAgain = true;
      return Promise.resolve(202);
    }
    this.problem = null;
    const work = this.options.compute.refreshGpus();
    const done = (): void => {
      this.reading = null;
      if (!this.readAgain) return;
      this.readAgain = false;
      try {
        this.readPrices(false).catch(() => {});
      } catch {
        /* The key is gone, so there is nothing to read. */
      }
    };
    this.reading = work.then(done, done);
    return this.background(work, 'Verifold could not read the prices.', asked);
  }

  private async saveMoney(body: Record<string, unknown>): Promise<void> {
    const money = parseProfileMoney(body);
    await this.write((current) => ({
      ...current,
      money,
      steps: { ...current.steps, money: 'done' },
    }));
  }

  private async skip(step: unknown): Promise<void> {
    const names: readonly SetupStep[] = ['agents', 'about', 'skills', 'money'];
    if (step !== 'all' && !names.includes(step as SetupStep))
      fail('Skip agents, about, skills, money, or all.');
    await this.write((current) => {
      const steps = { ...current.steps };
      for (const name of names)
        if (step === name || (step === 'all' && !steps[name]))
          steps[name] = 'skipped';
      return { ...current, steps };
    });
  }
}

/** A card that the page sent, checked: each field within its limit, and one field at least. */
function cardOf(value: unknown): ProfileCard {
  const input = record(value) ? value : fail('Send the card.');
  const field = (name: keyof ProfileCard): string => {
    const text = input[name];
    if (typeof text !== 'string') fail('Send each field of the card.');
    const trimmed = text.trim();
    if (trimmed.length > cardLimits[name])
      fail(
        `Keep each field within its limit of ${cardLimits[name]} characters.`,
      );
    return trimmed;
  };
  const card = {
    workOn: field('workOn'),
    explore: field('explore'),
    talk: field('talk'),
  };
  if (!card.workOn && !card.explore && !card.talk)
    fail('Write at least one field, or skip this step.');
  return card;
}

/**
 * The harness that asks and drafts: the first one in use that is signed
 * in, the lead first, with its model. Before the agents step, Claude Code
 * first, then Codex.
 */
function chatChoice(
  detected: readonly HarnessStatus[],
  agency: Agency | null,
): ChatHarness | null {
  for (const name of harnessOrder(agency)) {
    const status = detected.find((entry) => entry.harness === name);
    if (status?.signedIn === true) return withModel(status, agency);
  }
  return null;
}

/** The lead and the helper of the agents step. Before it, Claude Code, then Codex. */
function harnessOrder(agency: Agency | null): HarnessName[] {
  return agency
    ? [agency.host, ...(agency.helper ? [agency.helper] : [])]
    : ['claude', 'codex'];
}

/** A harness with the model that the person picked for it, else the first one offered. */
function withModel(status: HarnessStatus, agency: Agency | null): ChatHarness {
  const model = profileModel(status.harness, agency) ?? status.models[0]?.id;
  return { host: status.harness, ...(model ? { model } : {}) };
}

/**
 * The harnesses that the import asks, the lead first: each one that the
 * agents step uses, else each one that is installed. A harness that is
 * signed out is left out. One whose sign-in Verifold could not tell is
 * asked, and its failure shows in the result.
 */
function inUse(
  detected: readonly HarnessStatus[],
  agency: Agency | null,
): ChatHarness[] {
  return harnessOrder(agency).flatMap((name) => {
    const status = detected.find((entry) => entry.harness === name);
    return status?.installed && status.signedIn !== false
      ? [withModel(status, agency)]
      : [];
  });
}

/** A harness as the agents step shows it, with the person's saved choice. */
function tool(status: HarnessStatus, agency: Agency | null): AgentTool {
  const saved = profileModel(status.harness, agency);
  const models =
    saved && !status.models.some((model) => model.id === saved)
      ? [...status.models, { id: saved, label: saved }]
      : status.models;
  return {
    harness: status.harness,
    installed: status.installed,
    version: status.version,
    signedIn: status.signedIn,
    plan: status.plan,
    // Before a choice, each harness that is installed and not signed out is in use.
    use: agency
      ? agency.host === status.harness || agency.helper === status.harness
      : status.installed && status.signedIn !== false,
    // A first choice without an ID is the harness's own model.
    model: saved ?? (models[0]?.id || null),
    models,
  };
}
