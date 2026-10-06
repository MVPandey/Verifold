import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { harnessEnvironment } from './harness.ts';
import { SessionActionError } from './session.ts';
import { inScope, projectPath } from './workspaces.ts';

/** Where a lease's pod answers SSH. */
export interface PodTarget {
  readonly lease: string;
  readonly host: string;
  readonly port: number;
}

export const podLimits = {
  /** The tail of a command's output that a tool call returns. */
  output: 64 * 1024,
  commandSeconds: 600,
  command: 8000,
  copyBytes: 200 * 1024 * 1024,
  copyFiles: 2000,
  copyPaths: 20,
} as const;

function fail(message: string): never {
  throw new SessionActionError(message);
}

/** The watchdog's folder on the pod. */
const watchFolder = '/root/verifold/.watchdog';

/** A value inside single quotes for the remote shell. */
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The remote folder of a task. Task IDs are `task-N`, so the path needs no quoting. */
function remoteFolder(task: string): string {
  if (!/^task-\d{1,6}$/.test(task)) fail('Unknown task.');
  return `/root/verifold/${task}`;
}

interface Run {
  readonly code: number;
  /** The last part of stdout, up to the limit. */
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Run a program with bounded output and a deadline. Input comes from a string
 * or from another process's stdout. Only the tail of stdout is kept.
 */
function program(
  command: string,
  args: readonly string[],
  options: {
    readonly input?: string | NodeJS.ReadableStream;
    readonly timeoutMs: number;
    readonly keep?: number;
    readonly cwd?: string;
  },
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: harnessEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const keep = options.keep ?? podLimits.output;
    let stdout = Buffer.alloc(0);
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length > keep) stdout = stdout.subarray(stdout.length - keep);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
    });
    child.stdin.on('error', () => {
      /* The exit code reports a program that closed its input. */
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    if (typeof options.input === 'string' || options.input === undefined)
      child.stdin.end(options.input ?? '');
    else options.input.pipe(child.stdin);
  });
}

/**
 * Verifold's SSH access to pods. Each lease gets its own key pair in
 * `~/.verifold/credentials/ssh/<project>/`, outside the project and away from
 * harnesses, and its own known-hosts file. Only Verifold runs `ssh`; workers
 * reach the pod through Verifold's tools.
 */
export class PodShell {
  private readonly keys: string;
  private readonly hosts: string;
  private readonly ssh: string;
  private readonly keyscan: string;
  private readonly keygen: string;

  /** `credentials` is `~/.verifold/credentials`. Tests use fake programs. */
  constructor(options: {
    readonly root: string;
    readonly credentials: string;
    readonly ssh?: string;
    readonly keyscan?: string;
    readonly keygen?: string;
  }) {
    const tag = createHash('sha256')
      .update(options.root)
      .digest('hex')
      .slice(0, 8);
    this.keys = join(options.credentials, 'ssh', tag);
    this.hosts = join(options.root, '.verifold', 'compute', 'known_hosts');
    this.ssh = options.ssh ?? 'ssh';
    this.keyscan = options.keyscan ?? 'ssh-keyscan';
    this.keygen = options.keygen ?? 'ssh-keygen';
  }

  /** A new key pair for a lease. Returns the public key, which the pod gets as PUBLIC_KEY. */
  async newKey(lease: string): Promise<string> {
    await mkdir(this.keys, { recursive: true, mode: 0o700 });
    const path = join(this.keys, lease);
    await rm(path, { force: true });
    await rm(`${path}.pub`, { force: true });
    const made = await program(
      this.keygen,
      ['-q', '-t', 'ed25519', '-N', '', '-C', `verifold-${lease}`, '-f', path],
      { timeoutMs: 20_000 },
    );
    if (made.code !== 0)
      fail('Verifold could not make an SSH key for the pod.');
    return (await readFile(`${path}.pub`, 'utf8')).trim();
  }

  /** Forget the key pair and the pinned host key of a lease that closed. */
  async forget(lease: string): Promise<void> {
    await rm(join(this.keys, lease), { force: true });
    await rm(join(this.keys, `${lease}.pub`), { force: true });
    await rm(join(this.hosts, lease), { force: true });
  }

  /**
   * Pin the pod's host key. The pod's start script prints its fingerprints in
   * the container log; Verifold compares them with what `ssh-keyscan` sees. A
   * pod whose log has no fingerprint is trusted on first use. Fails while
   * SSH does not answer yet.
   */
  async pin(
    target: PodTarget,
    logged: readonly string[],
  ): Promise<'verified' | 'first use'> {
    const scan = await program(
      this.keyscan,
      ['-T', '10', '-t', 'ed25519', '-p', String(target.port), target.host],
      { timeoutMs: 20_000, keep: 8192 },
    );
    const line = scan.stdout
      .toString('utf8')
      .split('\n')
      .find((entry) => / ssh-ed25519 [A-Za-z0-9+/=]+$/.test(entry.trim()));
    if (scan.code !== 0 || !line) fail('SSH on the pod does not answer yet.');
    const key = line.trim().split(' ').slice(1).join(' ');
    const seen = `SHA256:${createHash('sha256')
      .update(Buffer.from(key.split(' ')[1] ?? '', 'base64'))
      .digest('base64')
      .replace(/=+$/, '')}`;
    const expected = logged.flatMap(
      (entry) =>
        /^256 (SHA256:[A-Za-z0-9+/]+) .*\(ED25519\)$/.exec(entry)?.[1] ?? [],
    );
    if (expected.length && !expected.includes(seen))
      fail(
        'The SSH host key of the pod does not match the key in its log. Verifold does not connect.',
      );
    await mkdir(this.hosts, { recursive: true, mode: 0o700 });
    await writeFile(
      join(this.hosts, target.lease),
      `[${target.host}]:${target.port} ${key}\n`,
      { mode: 0o600 },
    );
    return expected.length ? 'verified' : 'first use';
  }

  private args(target: PodTarget): string[] {
    return [
      '-i',
      join(this.keys, target.lease),
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${join(this.hosts, target.lease)}`,
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'LogLevel=ERROR',
      '-p',
      String(target.port),
      `root@${target.host}`,
      '--',
    ];
  }

  /**
   * Start the watchdog on a pod. Each minute it stops the pod with the pod's
   * own RunPod key when the lease ends, or when Verifold's heartbeat is older
   * than 15 minutes, so a pod stops even when Verifold is gone. The watchdog
   * ends with the container, so Verifold starts it after each start.
   */
  async watch(target: PodTarget, deadline: string): Promise<void> {
    const end = Math.floor(Date.parse(deadline) / 1000);
    if (!Number.isFinite(end)) fail('The lease has no end time.');
    const script = `set -e
mkdir -p ${watchFolder}
touch ${watchFolder}/heartbeat
echo ${end} > ${watchFolder}/deadline
cat > ${watchFolder}/watchdog.sh <<'WATCH'
while sleep 60; do
  now=$(date +%s)
  beat=$(stat -c %Y ${watchFolder}/heartbeat 2>/dev/null || echo 0)
  if [ "$now" -ge "$(cat ${watchFolder}/deadline)" ] || [ $((now - beat)) -ge 900 ]; then
    set -a; . /etc/rp_environment; set +a
    runpodctl stop pod "$RUNPOD_POD_ID" || runpodctl pod stop "$RUNPOD_POD_ID"
    sleep 60
  fi
done
WATCH
pkill -f ${watchFolder}/watchdog.sh || true
nohup bash ${watchFolder}/watchdog.sh > ${watchFolder}/watchdog.log 2>&1 &
echo watching
`;
    const result = await program(this.ssh, [...this.args(target), 'bash -s'], {
      input: script,
      timeoutMs: 60_000,
      keep: 1024,
    });
    if (result.code !== 0 || !result.stdout.toString().includes('watching'))
      fail(
        `Verifold could not start the watchdog on the pod. ${result.stderr.trim().slice(0, 300)}`,
      );
  }

  /** Tell the watchdog that Verifold still runs. */
  async beat(target: PodTarget): Promise<void> {
    await program(
      this.ssh,
      [...this.args(target), `touch ${watchFolder}/heartbeat`],
      { timeoutMs: 30_000, keep: 1024 },
    );
  }

  /** Run a command in the task's folder on the pod, under `timeout`. The command goes on stdin. */
  async run(
    target: PodTarget,
    task: string,
    command: string,
    seconds: number,
  ): Promise<{ readonly exit: number | null; readonly output: string }> {
    const folder = remoteFolder(task);
    const result = await program(
      this.ssh,
      [
        ...this.args(target),
        `mkdir -p ${folder} && cd ${folder} && timeout ${seconds} bash -s 2>&1`,
      ],
      { input: command, timeoutMs: (seconds + 30) * 1000 },
    );
    if (result.code === 255)
      fail(
        `Verifold could not reach the pod over SSH. ${result.stderr.trim().slice(0, 300)}`,
      );
    return {
      exit: result.timedOut ? null : result.code,
      output: result.stdout.toString('utf8'),
    };
  }

  /** Start a background job in the task's folder. Returns its ID at once. */
  async start(
    target: PodTarget,
    task: string,
    command: string,
  ): Promise<string> {
    const folder = remoteFolder(task);
    const job = `job-${randomBytes(4).toString('hex')}`;
    const result = await program(
      this.ssh,
      [
        ...this.args(target),
        `mkdir -p ${folder}/.verifold-jobs && cd ${folder} && cat > .verifold-jobs/${job}.sh && (nohup bash -c 'bash .verifold-jobs/${job}.sh > .verifold-jobs/${job}.log 2>&1; echo $? > .verifold-jobs/${job}.exit' > /dev/null 2>&1 &) && echo started`,
      ],
      { input: command, timeoutMs: 60_000, keep: 1024 },
    );
    if (result.code !== 0 || !result.stdout.toString().includes('started'))
      fail(
        `The pod did not start the job. ${result.stderr.trim().slice(0, 300)}`,
      );
    return job;
  }

  /** The state, exit code, and last output of a background job. */
  async job(
    target: PodTarget,
    task: string,
    job: string,
  ): Promise<{
    readonly state: 'running' | 'done' | 'unknown';
    readonly exit: number | null;
    readonly output: string;
  }> {
    if (!/^job-[0-9a-f]{8}$/.test(job))
      fail('Name a job that verifold_pod_run started.');
    const folder = remoteFolder(task);
    const result = await program(
      this.ssh,
      [
        ...this.args(target),
        `cd ${folder}/.verifold-jobs 2>/dev/null && if [ -f ${job}.exit ]; then echo "exit $(cat ${job}.exit)"; elif [ -f ${job}.sh ]; then echo running; else echo unknown; fi && tail -c ${podLimits.output} ${job}.log 2>/dev/null`,
      ],
      { timeoutMs: 60_000 },
    );
    const text = result.stdout.toString('utf8');
    const [first = '', ...rest] = text.split('\n');
    const exit = /^exit (-?\d+)$/.exec(first.trim());
    return {
      state: exit ? 'done' : first.trim() === 'running' ? 'running' : 'unknown',
      exit: exit ? Number(exit[1]) : null,
      output: rest.join('\n'),
    };
  }

  /** Copy files and folders from the task folder to the task's folder on the pod. */
  async copyTo(
    target: PodTarget,
    task: string,
    folder: string,
    paths: readonly unknown[],
  ): Promise<{ readonly files: number; readonly bytes: number }> {
    const chosen = this.paths(paths);
    let files = 0;
    let bytes = 0;
    const walk = async (path: string): Promise<void> => {
      const stats = await lstat(join(folder, path)).catch(() =>
        fail(`${path} is not in the task folder.`),
      );
      if (stats.isSymbolicLink())
        fail(`${path} is a link. Copy regular files only.`);
      if (stats.isDirectory()) {
        for (const name of await readdir(join(folder, path)))
          await walk(join(path, name));
        return;
      }
      if (!stats.isFile()) fail(`${path} is not a regular file.`);
      files++;
      bytes += stats.size;
      if (files > podLimits.copyFiles || bytes > podLimits.copyBytes)
        fail('A copy can hold at most 2,000 files and 200 MB.');
    };
    for (const path of chosen) await walk(path);
    // macOS tar adds AppleDouble `._` files for extended attributes unless COPYFILE_DISABLE is set.
    const archive = spawn('tar', ['-cf', '-', '--', ...chosen], {
      cwd: folder,
      env: { ...harnessEnvironment(), COPYFILE_DISABLE: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const remote = remoteFolder(task);
    const result = await program(
      this.ssh,
      [
        ...this.args(target),
        `mkdir -p ${remote} && tar -xf - --no-same-owner -C ${remote}`,
      ],
      { input: archive.stdout, timeoutMs: 600_000, keep: 4096 },
    );
    if (result.code !== 0)
      fail(`The copy to the pod failed. ${result.stderr.trim().slice(0, 300)}`);
    return { files, bytes };
  }

  /**
   * Copy files from the task's folder on the pod into the task folder. Only
   * regular files inside the writable paths arrive; Verifold refuses links and
   * other paths, and stops a copy above 200 MB or 2,000 files.
   */
  async copyFrom(
    target: PodTarget,
    task: string,
    folder: string,
    writable: readonly string[],
    paths: readonly unknown[],
  ): Promise<{
    readonly copied: readonly string[];
    readonly refused: readonly string[];
  }> {
    const chosen = this.paths(paths);
    const outside = chosen.filter((path) => !inScope(path, writable));
    if (outside.length)
      fail(
        `These paths are outside the writable paths of the task: ${outside.join(', ')}.`,
      );
    const landing = await mkdtemp(join(tmpdir(), 'vf-pod-'));
    try {
      const source = spawn(
        this.ssh,
        [
          ...this.args(target),
          `cd ${remoteFolder(task)} && tar -cf - -- ${chosen.map(quote).join(' ')}`,
        ],
        { env: harnessEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let size = 0;
      let errors = '';
      source.stderr.on('data', (chunk: Buffer) => {
        errors = `${errors}${chunk.toString()}`.slice(-2000);
      });
      // The archive passes through a counter, so a copy above the limit stops.
      source.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > podLimits.copyBytes + 10 * 1024 * 1024)
          source.kill('SIGKILL');
      });
      const unpacked = await program('tar', ['-xf', '-', '-C', landing], {
        input: source.stdout,
        timeoutMs: 600_000,
        keep: 4096,
      });
      if (size > podLimits.copyBytes + 10 * 1024 * 1024)
        fail('The copy from the pod is above 200 MB. Copy fewer files.');
      if (unpacked.code !== 0)
        fail(
          `The copy from the pod failed. ${(errors || unpacked.stderr).trim().slice(0, 300)}`,
        );
      const copied: string[] = [];
      const refused: string[] = [];
      const walk = async (path: string): Promise<void> => {
        const stats = await lstat(join(landing, path));
        if (stats.isDirectory()) {
          for (const name of await readdir(join(landing, path)))
            await walk(path ? join(path, name) : name);
          return;
        }
        if (!stats.isFile() || !inScope(path, writable)) {
          refused.push(path);
          return;
        }
        if (copied.length >= podLimits.copyFiles)
          fail('A copy can hold at most 2,000 files.');
        // No folder on the way to the target may be a link, so nothing lands outside the task folder.
        let at = folder;
        for (const part of dirname(path)
          .split('/')
          .filter((entry) => entry && entry !== '.')) {
          at = join(at, part);
          const inside = await lstat(at).catch(() => null);
          if (inside?.isSymbolicLink())
            fail(`${relative(folder, at)} is a link in the task folder.`);
        }
        await mkdir(dirname(join(folder, path)), { recursive: true });
        const existing = await lstat(join(folder, path)).catch(() => null);
        if (existing && !existing.isFile()) {
          refused.push(path);
          return;
        }
        await copyFile(join(landing, path), join(folder, path));
        copied.push(path);
      };
      await walk('');
      return { copied, refused };
    } finally {
      await rm(landing, { recursive: true, force: true });
    }
  }

  private paths(paths: readonly unknown[]): string[] {
    if (!paths.length || paths.length > podLimits.copyPaths)
      fail(`Name 1 to ${podLimits.copyPaths} paths.`);
    return paths.map((path) => {
      const checked = projectPath(path);
      if (checked === '.')
        fail('Name files or folders, not the whole task folder.');
      return checked;
    });
  }
}
