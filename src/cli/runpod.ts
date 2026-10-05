import { stripVTControlCharacters } from 'node:util';
import { SessionActionError } from './session.ts';

/** A RunPod reply that the person can act on. No message contains the key. */
export class RunPodError extends SessionActionError {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

/** A GPU type for Secure Cloud pods, with its list price and stock. */
export interface GpuOffer {
  readonly id: string;
  readonly name: string;
  readonly memoryGb: number;
  /** USD per hour for one GPU on Secure Cloud. */
  readonly price: number;
  readonly stock: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | null;
}

const stocks = ['NONE', 'LOW', 'MEDIUM', 'HIGH'] as const;

/** Read a reply body up to 4 MB. */
async function limited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4 * 1024 * 1024) {
      await reader.cancel();
      throw new RunPodError('RunPod sent a reply above 4 MB.', response.status);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The RunPod REST API v2. The key goes only into the Authorization header, and
 * redirects are refused, so the key cannot reach another host. Each call has
 * an 8-second deadline, which fits inside a desk request.
 */
export class RunPod {
  readonly #key: string;
  readonly #base: string;

  /** `base` is the API origin. Tests use a fake server. */
  constructor(key: string, base = 'https://api.runpod.io') {
    this.#key = key;
    this.#base = base;
  }

  async #call(method: 'GET', path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.#base), {
        method,
        headers: {
          Authorization: `Bearer ${this.#key}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
    } catch (error) {
      throw new RunPodError(
        `Verifold could not reach RunPod${error instanceof Error && error.name === 'TimeoutError' ? ' in 8 seconds' : ''}. Check the network and try again.`,
        null,
      );
    }
    const text = await limited(response);
    if (!response.ok)
      throw new RunPodError(this.#problem(response, text), response.status);
    try {
      return text ? (JSON.parse(text) as unknown) : null;
    } catch {
      throw new RunPodError(
        'RunPod sent a reply that Verifold cannot read.',
        response.status,
      );
    }
  }

  /** A message for a failed call: the status and RunPod's short reason, never a header. */
  #problem(response: Response, text: string): string {
    let detail = '';
    try {
      const value: unknown = JSON.parse(text);
      if (
        value &&
        typeof value === 'object' &&
        'detail' in value &&
        typeof value.detail === 'string'
      )
        detail = stripVTControlCharacters(value.detail)
          .replaceAll(this.#key, '[key]')
          .replace(/\s+/g, ' ')
          .slice(0, 200);
    } catch {
      /* Not problem JSON. */
    }
    const reason = detail ? ` RunPod says: ${detail}` : '';
    switch (response.status) {
      case 401:
        return `RunPod did not accept the key (401). Check that it is current, or store a new one.${reason}`;
      case 402:
        return `RunPod reports that the balance is too low (402). Add credit in the RunPod console.${reason}`;
      case 403:
        return `The key does not allow this (403). Give it access to pods in the RunPod console.${reason}`;
      case 429: {
        const wait = Number(response.headers.get('retry-after'));
        return `RunPod limits requests now (429). Try again in ${Number.isFinite(wait) && wait > 0 ? `${Math.ceil(wait)} seconds` : 'a minute'}.`;
      }
      default:
        return `RunPod answered with ${response.status}.${reason}`;
    }
  }

  /** One read-only call that shows that the key works. It does not show that the key can create pods. */
  async check(): Promise<void> {
    await this.#call('GET', '/v2/pods?limit=1');
  }

  /**
   * GPU types for Secure Cloud pods with their price and stock, cheapest
   * first. A type that is not on Secure Cloud, or a price of 0, does not count:
   * the catalog fills in prices for clouds that a type is not on.
   */
  async gpus(): Promise<GpuOffer[]> {
    const value = await this.#call(
      'GET',
      '/v2/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE&count=1',
    );
    const list =
      value &&
      typeof value === 'object' &&
      'gpus' in value &&
      Array.isArray(value.gpus)
        ? (value.gpus as unknown[])
        : [];
    const offers: GpuOffer[] = [];
    for (const entry of list.slice(0, 500)) {
      if (!entry || typeof entry !== 'object') continue;
      const gpu = entry as Record<string, unknown>;
      const price =
        gpu.price && typeof gpu.price === 'object'
          ? (gpu.price as Record<string, unknown>).secure
          : undefined;
      if (
        typeof gpu.id !== 'string' ||
        !/^[A-Za-z0-9 ._()-]{1,100}$/.test(gpu.id) ||
        gpu.secure !== true ||
        typeof price !== 'number' ||
        !(price > 0 && price < 1000)
      )
        continue;
      offers.push({
        id: gpu.id,
        name:
          typeof gpu.name === 'string'
            ? stripVTControlCharacters(gpu.name).slice(0, 100)
            : gpu.id,
        memoryGb: typeof gpu.memory === 'number' ? gpu.memory : 0,
        price,
        stock: stocks.find((stock) => stock === gpu.availability) ?? null,
      });
    }
    return offers.sort((a, b) => a.price - b.price || a.id.localeCompare(b.id));
  }
}
