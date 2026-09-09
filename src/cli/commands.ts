import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseProfile } from '../domain/profile.ts';
import { escapeHtml as e } from '../ui/dom.ts';
import { parseCandidates } from './contracts.ts';
import { changeWorkspace, loadWorkspace, readJson } from './storage.ts';
export interface CliIO {
  readonly interactive: boolean;
  readonly ask: (question: string) => Promise<string>;
  readonly out: (value: string) => void;
}
const help = `Verifold — private research workspace for your existing AI harness

verifold init [--profile profile.json] [--host name] [--workspace path]
verifold recommend [--workspace path]   Print a research request for your host
verifold ideas --from ideas.json       Import host recommendations; never execute
verifold select [--id idea-id]         Choose an idea explicitly
verifold handoff                       Print the selected task for Automative + host
verifold view                          Generate a private local HTML workspace
verifold status                        Print workspace JSON

Options: --workspace path (default: current directory), --help, --version
Interactive init asks the questionnaire; noninteractive init requires --profile.
All research stays in .verifold/ and defaults private. No cloud sync or compute
is started. The host owns models, permissions, sessions, and execution.
`;
/** Subprocess CLI contract: machine commands return JSON; prompts are delegated to stderr I/O. */
export async function runCli(
  argv: readonly string[],
  cwd: string,
  io: CliIO,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      version: { type: 'boolean' },
      workspace: { type: 'string' },
      profile: { type: 'string' },
      host: { type: 'string' },
      from: { type: 'string' },
      id: { type: 'string' },
    },
  });
  if (values.help) {
    io.out(help);
    return;
  }
  if (values.version) {
    io.out('0.1.0');
    return;
  }
  const command = positionals[0];
  if (!command || positionals.length !== 1)
    throw new Error('Provide one command. Use --help.');
  const allowed: Record<string, readonly string[]> = {
    init: ['profile', 'host'],
    recommend: [],
    ideas: ['from'],
    select: ['id'],
    handoff: [],
    view: [],
    status: [],
  };
  if (!Object.hasOwn(allowed, command))
    throw new Error(`Unknown command: ${command}. Use --help.`);
  for (const key of Object.keys(values))
    if (key !== 'workspace' && !allowed[command]?.includes(key))
      throw new Error(`--${key} is not valid for ${command}.`);
  const root = resolve(cwd, values.workspace ?? '.');
  if (command === 'init') {
    if (!values.profile && !io.interactive)
      throw new Error('Noninteractive init requires --profile profile.json.');
    const profile = values.profile
      ? parseProfile(await readJson(resolve(cwd, values.profile)))
      : parseProfile({
          name: await io.ask('Your name: '),
          interests: (
            await io.ask(
              'What do you publish or want to research? (comma-separated; math, CS/ML, security, etc.): ',
            )
          ).split(','),
          scholar: await io.ask('Google Scholar URL (optional): '),
          github: await io.ask('GitHub URL (optional): '),
          session: await io.ask(
            'Coding session reference (optional; no automatic import): ',
          ),
        });
    const host =
      values.host ??
      (io.interactive
        ? await io.ask('Existing AI harness name: ')
        : 'existing-harness');
    const result = await changeWorkspace(root, (current) => {
      if (current)
        throw new Error('Workspace already exists; refusing to overwrite it.');
      return {
        schemaVersion: 1,
        visibility: 'private',
        profile,
        host,
        candidates: [],
        selectedId: null,
      };
    });
    io.out(JSON.stringify(result));
    return;
  }
  if (command === 'ideas') {
    if (!values.from)
      throw new Error(
        'ideas requires --from with host-generated recommendations. Run recommend first.',
      );
    const candidates = parseCandidates(
      await readJson(resolve(cwd, values.from)),
    );
    const result = await changeWorkspace(root, (current) => {
      if (!current) throw new Error('Run init first.');
      if (current.selectedId)
        throw new Error(
          'A selected idea already exists; refusing to replace its evidence.',
        );
      return { ...current, candidates };
    });
    io.out(JSON.stringify(result.candidates));
    return;
  }
  const workspace = await loadWorkspace(root);
  if (command === 'status') {
    io.out(JSON.stringify(workspace));
    return;
  }
  if (command === 'recommend') {
    io.out(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'recommendation-request',
        profile: workspace.profile,
        host: workspace.host,
        scope: 'Any research whose end-to-end experimentation is computational',
        instructions:
          'Propose promising falsifiable ideas grounded in sources. Explain recommendation, uncertainty, feasibility, and task-specific verification gates. Do not execute or select an idea. Return a JSON array of {id,title,recommendation,gates:string[]}; gates are proposals for human review, not approvals.',
      }),
    );
    return;
  }
  if (command === 'select') {
    if (!workspace.candidates.length)
      throw new Error('Import host recommendations with ideas --from first.');
    let id = values.id;
    if (!id) {
      if (!io.interactive)
        throw new Error(
          'Noninteractive selection requires --id. No idea was selected.',
        );
      const choices = workspace.candidates
        .map(
          (idea) =>
            `${idea.id}: ${idea.title}\n  Agent recommendation: ${idea.recommendation}\n  Proposed gates: ${idea.gates.join('; ')}`,
        )
        .join('\n\n');
      id = (
        await io.ask(
          `${choices}\n\nChoose an idea ID (no execution is authorized): `,
        )
      ).trim();
    }
    const selectedId = id;
    const result = await changeWorkspace(root, (current) => {
      if (!current || current.selectedId)
        throw new Error('Workspace missing or selection already locked.');
      if (!current.candidates.some((idea) => idea.id === selectedId))
        throw new Error('Choose an ID from the recommendation list.');
      return { ...current, selectedId };
    });
    io.out(
      JSON.stringify({
        selectedId: result.selectedId,
        status: 'awaiting-pilot-plan',
        visibility: 'private',
      }),
    );
    return;
  }
  if (command === 'handoff') {
    const idea = workspace.candidates.find(
      (candidate) => candidate.id === workspace.selectedId,
    );
    if (!idea) throw new Error('Select an idea before requesting a handoff.');
    io.out(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'pilot-planning-request',
        host: workspace.host,
        executionAdapter: 'automative',
        visibility: 'private',
        idea,
        executionAuthorized: false,
        instructions:
          'Use the existing host session. Draft a task-specific Automative goal, protected evaluator, scope, budget and guards. Explain the purpose and proposed verification gates; obtain user approval before execution. Preserve failed attempts and evidence. Do not edit host permissions or install hooks automatically.',
        nextSteps: [
          'Review AUTOMATIVE.md with the user',
          'automative doctor',
          'automative run start',
        ],
      }),
    );
    return;
  }
  const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verifold — private workspace</title><style>body{font:16px system-ui;background:#f8f7fa;color:#101014;max-width:900px;margin:50px auto;padding:24px}h1{color:#4c1d95}article{padding:20px 0;border-top:1px solid #ddd}p{line-height:1.7}</style><h1>Verifold</h1><p>Private workspace · managed by the CLI · ${e(workspace.profile.name)}</p><p>${workspace.profile.interests.map(e).join(', ')}</p><p>Host: ${e(workspace.host)} · Selection: ${e(workspace.selectedId ?? 'Awaiting your choice')}</p>${workspace.candidates.map((idea) => `<article><h2>${e(idea.title)}</h2><p>${e(idea.recommendation)}</p><ul>${idea.gates.map((gate) => `<li>${e(gate)}</li>`).join('')}</ul></article>`).join('')}<p>Run <code>verifold select</code> to choose an idea. This view sends no data and starts no experiments.</p></html>`;
  const path = join(root, '.verifold', 'workspace.html');
  const temporary = join(root, '.verifold', `${randomUUID()}.html.tmp`);
  try {
    await writeFile(temporary, page, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  io.out(
    JSON.stringify({
      path,
      visibility: 'private',
      note: 'Local read-only snapshot. No remote account or cloud synchronization is configured.',
    }),
  );
}
