import { parseArgs, stripVTControlCharacters } from 'node:util';
import { resolve, join } from 'node:path';
import { writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { escapeHtml as e } from '../ui/dom.ts';
import { parseCandidates } from './contracts.ts';
import type { Workspace } from './contracts.ts';
import { changeWorkspace, loadWorkspace, readJson } from './storage.ts';
import { initializeProject, parseAutonomy } from './initialization.ts';
import { runResearch } from './research.ts';
import { object, text } from './research-contracts.ts';
import type { Choice } from './choices.ts';
export interface CliIO {
  readonly interactive: boolean;
  readonly ask: (question: string) => Promise<string>;
  readonly out: (value: string) => void;
  readonly progress?: (value: string) => void;
  readonly select?: (
    question: string,
    choices: readonly Choice[],
    initial: string,
  ) => Promise<string>;
  readonly busy?: <T>(label: string, work: () => Promise<T>) => Promise<T>;
}
const help = `Verifold - private research with your existing agent harness

verifold init [--host claude|codex] [--topic field] [--autonomy guided|autonomous]
verifold init --setup-only [--profile profile.json] [--host name]
verifold research [--topic field] [--feedback text] [--approve] [--autonomy guided|autonomous]
verifold recommend                    Print a research request for your host
verifold ideas --from ideas.json       Import host recommendations
verifold select [--id idea-id]         Choose an idea explicitly
verifold literature [--memory]        Print an optional paper/context request
verifold handoff                      Print a pilot request for Automative + host
verifold view                         Generate a private local HTML workspace
verifold status                       Print workspace JSON

Options: --workspace path (default: current directory), --help, --version
Init chooses a harness and optional --model, then offers reviewed research memory.
Use --agency-dir path to isolate preferences and USER.md (default: ~/.verifold/agency).
No name or external profile links are required. Noninteractive research requires --host, --topic,
and --autonomy autonomous. Use --setup-only to initialize without research.
The harness searches web sources and proposes ideas. PDF retention is optional
and follows idea selection. No experiments run during initial research.
Research stays private in .verifold/. The host owns its permissions and sessions.
`;

function showWorkspace(root: string, workspace: Workspace, io: CliIO): void {
  if (!io.interactive) {
    io.out(JSON.stringify(workspace));
    return;
  }
  const phase = workspace.research?.phase;
  const next =
    phase === 'directions'
      ? 'Use research --feedback to refine a direction, or select to choose one.'
      : phase === 'awaiting-plan-review'
        ? 'Use research --feedback to revise the plan, or research --approve to continue.'
        : phase
          ? 'Use research to resume the saved research session.'
          : 'Use research --topic "your question" to begin.';
  io.out(
    stripVTControlCharacters(
      `Private workspace: ${root}\nHarness: ${workspace.host} (${workspace.model ?? 'host default model'})\n${next}`,
    ),
  );
}
/** Subprocess CLI contract: machine commands return JSON; prompts are delegated to stderr I/O. */
export async function runCli(
  argv: readonly string[],
  cwd: string,
  io: CliIO,
  signal: AbortSignal = new AbortController().signal,
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
      model: { type: 'string' },
      'agency-dir': { type: 'string' },
      topic: { type: 'string' },
      feedback: { type: 'string' },
      approve: { type: 'boolean' },
      memory: { type: 'boolean' },
      autonomy: { type: 'string' },
      'setup-only': { type: 'boolean' },
      from: { type: 'string' },
      id: { type: 'string' },
    },
  });
  if (values.help) {
    io.out(help);
    return;
  }
  if (values.version) {
    const metadata = object(
      await readJson(
        fileURLToPath(new URL('../../package.json', import.meta.url)),
      ),
    );
    io.out(text(metadata.version, 'package version', 100));
    return;
  }
  const command = positionals[0];
  if (!command || positionals.length !== 1)
    throw new Error('Provide one command. Use --help.');
  const allowed: Record<string, readonly string[]> = {
    init: [
      'profile',
      'host',
      'model',
      'agency-dir',
      'topic',
      'autonomy',
      'setup-only',
    ],
    research: ['topic', 'feedback', 'autonomy', 'approve'],
    literature: ['memory'],
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
  signal.throwIfAborted();
  if (command === 'init') {
    const initialized = await initializeProject(
      root,
      cwd,
      {
        ...(values.profile !== undefined ? { profile: values.profile } : {}),
        ...(values.host !== undefined ? { host: values.host } : {}),
        ...(values.model !== undefined ? { model: values.model } : {}),
        ...(values['agency-dir'] !== undefined
          ? { agencyDir: values['agency-dir'] }
          : {}),
        ...(values.topic !== undefined ? { topic: values.topic } : {}),
        ...(values.autonomy !== undefined ? { autonomy: values.autonomy } : {}),
        setupOnly: values['setup-only'] ?? false,
      },
      io,
      signal,
    );
    const result = initialized.research
      ? await runResearch(root, initialized.research, io, signal)
      : initialized.workspace;
    showWorkspace(root, result, io);
    return;
  }
  if (command === 'research') {
    const result = await runResearch(
      root,
      {
        ...(values.topic !== undefined ? { topic: values.topic } : {}),
        ...(values.approve !== undefined ? { approve: values.approve } : {}),
        ...(values.feedback !== undefined ? { feedback: values.feedback } : {}),
        ...(values.autonomy !== undefined
          ? { autonomy: parseAutonomy(values.autonomy) }
          : {}),
      },
      io,
      signal,
    );
    showWorkspace(root, result, io);
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
        ...(workspace.context ? { context: workspace.context } : {}),
        ...(workspace.model ? { model: workspace.model } : {}),
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
      if (
        JSON.stringify(current.candidates) !==
        JSON.stringify(workspace.candidates)
      ) {
        throw new Error(
          'The ideas changed during selection. Review the updated list before choosing.',
        );
      }
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
  if (command === 'literature') {
    const idea = workspace.candidates.find(
      (candidate) => candidate.id === workspace.selectedId,
    );
    if (!idea)
      throw new Error(
        'Select an idea before requesting optional literature retention.',
      );
    io.out(
      JSON.stringify({
        schemaVersion: 1,
        kind: 'literature-retention-request',
        host: workspace.host,
        idea,
        optional: true,
        mode: values.memory ? 'pdfs-and-markdown-context' : 'pdfs',
        executionStarted: false,
        outputDirectory: '.verifold/literature/',
        instructions:
          'Use the selected harness to fetch relevant PDFs after the user accepts this request. Preserve official source citation responses unchanged. Record source URLs, citation URLs, retrieval times, file hashes, and relative local paths in an index. Map each citation to its PDF. Report unavailable files or official citations. Do not replace missing official citations with generated text.',
        ...(values.memory
          ? {
              memoryInstructions:
                'Read each retrieved PDF before writing its Markdown synthesis. Label the synthesis as agent-written context. Include findings, methods, limitations, relevant page or section references, and relevance to the selected idea. Link each Markdown file to its local PDF and official source URL. Preserve the original PDF and official citation separately. Record partial reading or extraction failures. Never describe a synthesis as an official citation or a full substitute for the paper.',
            }
          : {}),
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
