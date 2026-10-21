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
import {
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
import type { GpuOffer } from '../core/runpod.ts';
import { SessionActionError, hostName } from '../core/session.ts';
import type { AgentTool, GpuPrice, SetupView } from '../protocol/api.ts';
import { record } from './http.ts';

function fail(message: string): never {
  throw new SessionActionError(message);
}

/**
 * Common GPUs for research, by RunPod's type IDs (docs.runpod.io GPU types,
 * read on 2026-10-21). "Prices now" shows those that RunPod lists, at the
 * price that RunPod gives.
 */
const commonGpus = [
  'NVIDIA H200',
  'NVIDIA H100 80GB HBM3',
  'NVIDIA H100 PCIe',
  'NVIDIA A100-SXM4-80GB',
  'NVIDIA A100 80GB PCIe',
  'NVIDIA L40S',
  'NVIDIA GeForce RTX 4090',
];

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
}

/**
 * The first run behind `GET /api/v1/setup` and the `setup-*` actions. The
 * "About you" conversation lives in memory until the person saves the card.
 * Each write of the profile holds its lock, so a profile setup in a
 * terminal cannot write at the same time.
 */
export class FirstRun {
  private readonly options: FirstRunOptions;
  private detected: readonly HarnessStatus[] | null = null;
  private detecting: Promise<void> | null = null;
  private lines: ChatLine[] = [...opening];
  /** The draft card. Null: no draft, so the saved card shows. */
  private card: ProfileCard | null = null;
  private busy: string | null = null;
  private error: string | null = null;
  /** What a retry runs again: the last reply, with its note. */
  private retryNote: string | null | undefined;
  private reading: Promise<void> | null = null;
  private saving: Promise<void> | null = null;
  private problem: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly requests = new Map<
    string,
    { readonly status: Promise<number>; readonly at: number }
  >();

  constructor(options: FirstRunOptions) {
    this.options = options;
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
    return {
      steps: {
        agents: settings.steps.agents ?? null,
        about: settings.steps.about ?? null,
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
        card: this.card ?? saved,
        saved: saved ? 'card' : markdown ? 'text' : null,
        text: markdown && !saved ? markdown : null,
        harness: chat?.host ?? null,
        busy: this.busy,
        error: this.error,
        limits: { answer: answerLimit, ...cardLimits },
      },
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
      },
    };
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
    return this.locked(() => writeSettings(this.options.directory, change));
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
        if (this.busy) fail('The agent still writes. Wait a moment.');
        if (!this.lines.some((line) => line.from === 'you'))
          fail('Answer the first question first.');
        this.card = answersCard(this.lines);
        this.error = null;
        this.retryNote = undefined;
        return 200;
      case 'setup-restart':
        if (this.busy) fail('The agent still writes. Wait a moment.');
        this.lines = [...opening];
        this.card = null;
        this.error = null;
        this.retryNote = undefined;
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

  /**
   * An answer, or, once a card shows, a note on it: on the draft, else on
   * the saved card. The person's edits of the card, if any, are what the
   * note changes.
   */
  private async say(value: unknown, edited: unknown): Promise<number> {
    if (this.busy) fail('The agent still writes. Wait for its reply.');
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) fail('Write an answer first.');
    if (text.length > answerLimit)
      fail(`Write at most ${answerLimit} characters.`);
    if (!this.card) {
      const markdown = await loadMemory(this.options.directory).catch(
        () => null,
      );
      this.card = markdown ? parseCard(markdown) : null;
    }
    if (this.card && edited !== undefined) this.card = cardOf(edited);
    this.lines = [...this.lines, { from: 'you', text, suggestions: [] }];
    return this.reply(this.card ? text : null);
  }

  /** Start the next reply: a question or the card. The view shows it when it comes. */
  private reply(note: string | null): Promise<number> {
    if (this.busy) fail('The agent still writes. Wait for its reply.');
    this.busy = new Date().toISOString();
    this.error = null;
    this.retryNote = note;
    void this.turn(note);
    return Promise.resolve(202);
  }

  private async turn(note: string | null): Promise<void> {
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
      if ('card' in step) this.card = step.card;
      else
        this.lines = [
          ...this.lines,
          {
            from: harness?.host ?? 'verifold',
            text: step.question,
            suggestions: step.suggestions,
          },
        ];
      this.retryNote = undefined;
    } catch (error) {
      if (this.options.signal.aborted) return;
      this.error =
        error instanceof SessionActionError
          ? error.message
          : `The agent did not answer${error instanceof Error ? `: ${error.message.slice(0, 300)}` : '.'} Try again, or fill the card from your answers.`;
    } finally {
      this.busy = null;
    }
  }

  private async saveAbout(body: Record<string, unknown>): Promise<void> {
    if (this.busy) fail('The agent still writes. Wait a moment.');
    if (body.keep === true) {
      const markdown = await loadMemory(this.options.directory).catch(
        () => null,
      );
      if (!markdown) fail('No profile is saved to keep.');
      await this.write((current) => ({
        ...current,
        steps: { ...current.steps, about: 'done' },
      }));
      return;
    }
    const card = cardOf(body.card);
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
      await writeSettings(this.options.directory, (current) => ({
        ...current,
        steps: { ...current.steps, about: 'done' },
      }));
    });
    this.lines = [...opening];
    this.card = null;
    this.retryNote = undefined;
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
    if (this.reading) return Promise.resolve(202);
    this.problem = null;
    const work = this.options.compute.refreshGpus();
    this.reading = work.then(
      () => {
        this.reading = null;
      },
      () => {
        this.reading = null;
      },
    );
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
    const names: readonly SetupStep[] = ['agents', 'about', 'money'];
    if (step !== 'all' && !names.includes(step as SetupStep))
      fail('Skip agents, about, money, or all.');
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
  const order: HarnessName[] = agency
    ? [agency.host, ...(agency.helper ? [agency.helper] : [])]
    : ['claude', 'codex'];
  for (const name of order) {
    const status = detected.find((entry) => entry.harness === name);
    if (status?.signedIn !== true) continue;
    const model = profileModel(name, agency) ?? status.models[0]?.id;
    return { host: name, ...(model ? { model } : {}) };
  }
  return null;
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
    model: saved ?? models[0]?.id ?? null,
    models,
  };
}
