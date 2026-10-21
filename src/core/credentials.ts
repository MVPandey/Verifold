import { execFile, type ExecFileException } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SessionActionError } from './session.ts';
import { secretFile } from './harness.ts';

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

/** One stored value: its keyring item, its files in the credentials folder, and how messages name it. */
interface Item {
  readonly service: string;
  readonly account: string;
  /** The private file of the value. The record of where it is adds `.json`. */
  readonly file: string;
  readonly label: string;
  /** For example "the RunPod key". */
  readonly what: string;
  readonly valid: (value: unknown) => value is string;
  readonly invalid: string;
}

const runpodItem: Item = {
  service: 'verifold.runpod',
  account: 'default',
  file: 'runpod',
  label: 'Verifold RunPod key',
  what: 'the RunPod key',
  valid: validKey,
  invalid: 'A RunPod key has 20 to 256 letters and digits.',
};

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
  private readonly item: Item;
  private readonly options: KeyStoreOptions;

  /** `item` is the RunPod key unless a pod secret uses this store. */
  constructor(options: KeyStoreOptions = {}, item: Item = runpodItem) {
    this.options = options;
    this.home = options.home ?? homedir();
    this.platform = options.platform ?? process.platform;
    this.security = options.security ?? 'security';
    this.secretTool = options.secretTool ?? 'secret-tool';
    this.item = item;
  }

  /** `~/.verifold/credentials`. Strict workers cannot read it. */
  get folder(): string {
    return join(this.home, '.verifold', 'credentials');
  }

  /** The pod secrets of the same computer, in the same places. */
  secrets(): SecretStore {
    return new SecretStore(this.options);
  }

  /** Where the key is, and its last check. Null when no key is stored. */
  async status(): Promise<KeyStatus | null> {
    try {
      const value: unknown = JSON.parse(
        await readFile(join(this.folder, `${this.item.file}.json`), 'utf8'),
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
      this.item.service,
      'account',
      this.item.account,
    ]);
    return !probe.missing && (probe.code === 0 || probe.code === 1)
      ? 'secret-service'
      : null;
  }

  /** The stored key, or null when there is none. */
  async read(): Promise<string | null> {
    const status = await this.status();
    if (!status) return null;
    const { service, account, file, what } = this.item;
    let key: string;
    if (status.place === 'file') {
      const path = join(this.folder, file);
      const stats = await lstat(path).catch(() => null);
      if (!stats) return null;
      if (!stats.isFile() || (stats.mode & 0o077) !== 0)
        fail(
          `Verifold does not use ${path}, because other users can read it or it is not a regular file. Run \`chmod 600 ${path}\`, or store ${what} again.`,
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
          `Verifold could not read ${what} from ${placeNames[status.place]}. Unlock it, or store ${what} again.`,
        );
      key = result.stdout.trim();
    }
    return this.item.valid(key) ? key : null;
  }

  /** Store the key in one place and remove copies elsewhere. The record keeps only the last four characters. */
  async save(key: string, place: KeyPlace): Promise<void> {
    const { service, account, file, label, what } = this.item;
    if (!this.item.valid(key)) fail(this.item.invalid);
    if (place === 'keychain') {
      // Every part of this line is letters, digits, or symbols without spaces or quotes, so `security -i` reads it as written.
      const result = await run(
        this.security,
        ['-i'],
        `add-generic-password -U -s ${service} -a ${account} -l "${label}" -w ${key}\n`,
      );
      if (result.code !== 0)
        fail(
          `The macOS Keychain did not save ${what}. Unlock the keychain, or keep it in a private file.`,
        );
      await rm(join(this.folder, file), { force: true });
    } else if (place === 'secret-service') {
      const result = await run(
        this.secretTool,
        ['store', `--label=${label}`, 'service', service, 'account', account],
        key,
      );
      if (result.code !== 0)
        fail(
          `The Secret Service keyring did not save ${what}. Unlock the keyring, or keep it in a private file.`,
        );
      await rm(join(this.folder, file), { force: true });
    } else {
      await this.write(file, `${key}\n`);
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
    await rm(join(this.folder, this.item.file), { force: true });
    await rm(join(this.folder, `${this.item.file}.json`), { force: true });
  }

  private async forgetOs(): Promise<void> {
    const { service, account } = this.item;
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
    await this.write(
      `${this.item.file}.json`,
      `${JSON.stringify(status, null, 2)}\n`,
    );
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

/** The name of a pod secret: an environment variable name that Verifold and RunPod do not use themselves. */
export function validSecretName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(value) &&
    !/^(RUNPOD_|LD_|DYLD_)/.test(value) &&
    !['PUBLIC_KEY', 'PATH', 'HOME', 'USER', 'SHELL'].includes(value)
  );
}

const secretInvalid =
  'A secret value has 8 to 1024 letters, digits, and _.+/=:@- characters.';

/** A secret value: 8 to 1024 letters, digits, and `_.+/=:@-`, so no part of it needs quoting. */
export function validSecret(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[A-Za-z0-9_.+/=:@-]{8,1024}$/.test(value)
  );
}

/** What Verifold knows about a pod secret, without its value. */
export interface SecretStatus extends KeyStatus {
  readonly name: string;
}

/**
 * Named secrets for pods, such as HF_TOKEN, kept like the RunPod key: in the
 * keyring, or in a `0600` file by choice. A pod gets them as environment
 * variables. A harness never does: every child process loses variables of
 * these names (see `childEnvironment`).
 */
export class SecretStore {
  private readonly options: KeyStoreOptions;

  constructor(options: KeyStoreOptions = {}) {
    this.options = options;
  }

  private slot(name: unknown): KeyStore {
    if (!validSecretName(name))
      fail(
        'A secret name has capital letters, digits, and _, starts with a letter, and is not PATH, HOME, USER, SHELL, PUBLIC_KEY, or a RUNPOD_, LD_, or DYLD_ name.',
      );
    return new KeyStore(this.options, {
      service: 'verifold.secret',
      account: name,
      file: secretFile(name),
      label: `Verifold secret ${name}`,
      what: `the secret ${name}`,
      valid: validSecret,
      invalid: secretInvalid,
    });
  }

  get folder(): string {
    return new KeyStore(this.options).folder;
  }

  /** The stored secrets, by name. */
  async list(): Promise<SecretStatus[]> {
    const names = (await readdir(this.folder).catch(() => []))
      .map((entry) => /^secret-(.+)\.json$/.exec(entry)?.[1])
      .filter(validSecretName)
      .sort();
    const found: SecretStatus[] = [];
    for (const name of names) {
      const status = await this.slot(name).status();
      if (status) found.push({ ...status, name });
    }
    return found;
  }

  async save(name: unknown, value: unknown, place: KeyPlace): Promise<void> {
    const slot = this.slot(name);
    if (!validSecret(value)) fail(secretInvalid);
    await slot.save(value, place);
  }

  async read(name: unknown): Promise<string | null> {
    return this.slot(name).read();
  }

  async remove(name: unknown): Promise<void> {
    await this.slot(name).remove();
  }
}
