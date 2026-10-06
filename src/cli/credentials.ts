import { execFile, type ExecFileException } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionActionError } from './session.ts';

/** Where the RunPod key is kept. The file is used only when the person chooses it. */
export type KeyPlace = 'keychain' | 'secret-service' | 'file';

/** What Verifold knows about the stored key, without the key. */
export interface KeyStatus {
  readonly place: KeyPlace;
  /** The last four characters, so that the person can tell keys apart. */
  readonly last4: string;
  readonly savedAt: string;
  /** The last check with RunPod: when, and its error, if any. */
  readonly checkedAt?: string;
  readonly problem?: string;
}

export interface KeyStoreOptions {
  /** The home folder. Tests use a temporary one. */
  readonly home?: string;
  readonly platform?: NodeJS.Platform;
  /** The `security` and `secret-tool` programs. Tests use fakes. */
  readonly security?: string;
  readonly secretTool?: string;
}

const service = 'verifold.runpod';
const account = 'default';

export const placeNames: Record<KeyPlace, string> = {
  keychain: 'the macOS Keychain',
  'secret-service': 'the Secret Service keyring',
  file: 'a private file in ~/.verifold/credentials',
};

/** A RunPod API key: letters, digits, and `_.-`. This also keeps the key safe in a `security -i` command line. */
export function validKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{20,256}$/.test(value);
}

function fail(message: string): never {
  throw new SessionActionError(message);
}

/** Run a program with input on stdin, for at most 10 seconds. The input never goes into an argument. */
function run(
  program: string,
  args: readonly string[],
  input = '',
): Promise<{ code: number; stdout: string; missing: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(
      program,
      args,
      { timeout: 10_000, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error: ExecFileException | null, stdout) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : -1) : 0,
          stdout,
          missing: error?.code === 'ENOENT',
        });
      },
    );
    child.stdin?.on('error', () => {
      /* The exit code reports a program that closed its input. */
    });
    child.stdin?.end(input);
  });
}

/**
 * The RunPod key, outside every project: in the macOS Keychain, in the Secret
 * Service keyring on Linux, or in a `0600` file when the person chooses it.
 * `~/.verifold/credentials/runpod.json` records where the key is and its last
 * four characters. Strict workers cannot read that folder or the keychain.
 */
export class KeyStore {
  private readonly home: string;
  private readonly platform: NodeJS.Platform;
  private readonly security: string;
  private readonly secretTool: string;

  constructor(options: KeyStoreOptions = {}) {
    this.home = options.home ?? homedir();
    this.platform = options.platform ?? process.platform;
    this.security = options.security ?? 'security';
    this.secretTool = options.secretTool ?? 'secret-tool';
  }

  private get folder(): string {
    return join(this.home, '.verifold', 'credentials');
  }

  /** Where the key is, and its last check. Null when no key is stored. */
  async status(): Promise<KeyStatus | null> {
    try {
      const value: unknown = JSON.parse(
        await readFile(join(this.folder, 'runpod.json'), 'utf8'),
      );
      if (
        value &&
        typeof value === 'object' &&
        'place' in value &&
        (value.place === 'keychain' ||
          value.place === 'secret-service' ||
          value.place === 'file') &&
        'last4' in value &&
        typeof value.last4 === 'string' &&
        'savedAt' in value &&
        typeof value.savedAt === 'string'
      )
        return value as KeyStatus;
    } catch {
      /* No key yet, or an unreadable record. */
    }
    return null;
  }

  /** The OS store of this computer, or null when it has none that works. */
  async osPlace(): Promise<'keychain' | 'secret-service' | null> {
    if (this.platform === 'darwin') return 'keychain';
    if (this.platform !== 'linux') return null;
    // A lookup tells a working keyring (found, or exit 1 for no item) from a missing program or keyring.
    const probe = await run(this.secretTool, [
      'lookup',
      'service',
      service,
      'account',
      account,
    ]);
    return !probe.missing && (probe.code === 0 || probe.code === 1)
      ? 'secret-service'
      : null;
  }

  /** The stored key, or null when there is none. */
  async read(): Promise<string | null> {
    const status = await this.status();
    if (!status) return null;
    let key: string;
    if (status.place === 'file') {
      const path = join(this.folder, 'runpod');
      const stats = await lstat(path).catch(() => null);
      if (!stats) return null;
      if (!stats.isFile() || (stats.mode & 0o077) !== 0)
        fail(
          `Verifold does not use ${path}, because other users can read it or it is not a regular file. Run \`chmod 600 ${path}\`, or store the key again.`,
        );
      key = (await readFile(path, 'utf8')).trim();
    } else {
      const result =
        status.place === 'keychain'
          ? await run(this.security, [
              'find-generic-password',
              '-s',
              service,
              '-a',
              account,
              '-w',
            ])
          : await run(this.secretTool, [
              'lookup',
              'service',
              service,
              'account',
              account,
            ]);
      if (result.code !== 0)
        fail(
          `Verifold could not read the RunPod key from ${placeNames[status.place]}. Unlock it, or store the key again.`,
        );
      key = result.stdout.trim();
    }
    return validKey(key) ? key : null;
  }

  /** Store the key in one place and remove copies elsewhere. The record keeps only the last four characters. */
  async save(key: string, place: KeyPlace): Promise<void> {
    if (!validKey(key)) fail('A RunPod key has 20 to 256 letters and digits.');
    if (place === 'keychain') {
      const result = await run(
        this.security,
        ['-i'],
        `add-generic-password -U -s ${service} -a ${account} -l "Verifold RunPod key" -w ${key}\n`,
      );
      if (result.code !== 0)
        fail(
          'The macOS Keychain did not save the key. Unlock the keychain, or keep the key in a private file.',
        );
      await rm(join(this.folder, 'runpod'), { force: true });
    } else if (place === 'secret-service') {
      const result = await run(
        this.secretTool,
        [
          'store',
          '--label=Verifold RunPod key',
          'service',
          service,
          'account',
          account,
        ],
        key,
      );
      if (result.code !== 0)
        fail(
          'The Secret Service keyring did not save the key. Unlock the keyring, or keep the key in a private file.',
        );
      await rm(join(this.folder, 'runpod'), { force: true });
    } else {
      await this.write('runpod', `${key}\n`);
      await this.forgetOs();
    }
    await this.note({
      place,
      last4: key.slice(-4),
      savedAt: new Date().toISOString(),
    });
  }

  /** Record the result of a check with RunPod. */
  async noteCheck(problem: string | null): Promise<void> {
    const status = await this.status();
    if (!status) return;
    await this.note({
      place: status.place,
      last4: status.last4,
      savedAt: status.savedAt,
      checkedAt: new Date().toISOString(),
      ...(problem ? { problem } : {}),
    });
  }

  /** Remove the key from every place. RunPod keeps the key valid until the person revokes it in the console. */
  async remove(): Promise<void> {
    await this.forgetOs();
    await rm(join(this.folder, 'runpod'), { force: true });
    await rm(join(this.folder, 'runpod.json'), { force: true });
  }

  private async forgetOs(): Promise<void> {
    if (this.platform === 'darwin')
      await run(this.security, [
        'delete-generic-password',
        '-s',
        service,
        '-a',
        account,
      ]);
    else if (this.platform === 'linux')
      await run(this.secretTool, [
        'clear',
        'service',
        service,
        'account',
        account,
      ]);
  }

  private async note(status: KeyStatus): Promise<void> {
    await this.write('runpod.json', `${JSON.stringify(status, null, 2)}\n`);
  }

  /** Replace one file in the credentials folder atomically, readable only by the person. */
  private async write(name: string, content: string): Promise<void> {
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.folder)).isDirectory())
      fail(`${this.folder} must be a folder, not a link.`);
    const temporary = join(this.folder, `.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(content);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(this.folder, name));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
