<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/assets/verifold-horizontal-dark.webp" />
    <img src="public/assets/verifold-horizontal.webp" alt="Verifold" width="360" />
  </picture>
</p>

<p align="center"><strong>Research beyond the paper plane.</strong></p>

<p align="center">
  <a href="https://github.com/MVPandey/Verifold/actions/workflows/validate.yml"><img src="https://github.com/MVPandey/Verifold/actions/workflows/validate.yml/badge.svg?branch=main" alt="Validation workflow status" /></a>
  <a href=".nvmrc"><img src="https://img.shields.io/badge/Node.js-22%20%7C%2024%20%7C%2026-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 22, 24, or 26" /></a>
  <a href="tsconfig.json"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&amp;logoColor=white" alt="Strict TypeScript" /></a>
  <a href="#project-status"><img src="https://img.shields.io/badge/status-early%20development-7C3AED" alt="Early development" /></a>
</p>

# Verifold

Verifold coordinates computational research through the coding harnesses you already use.

Run `verifold` to connect your installed Claude Code or Codex, review optional personal background, and choose a project folder. Supply existing work, a written brief, or notes before your harness asks follow-up questions. Verifold saves the reviewed brief and research records, then opens a local browser desk to follow research.

We're building toward a research **meta-harness**: a shared workspace that coordinates several harness instances from ideation to a paper, repository, figure, proof, or other deliverable. Each harness keeps its models, credentials, tools, and permissions. Verifold will connect their tasks, discussions, memory, and evidence across sessions.

[Install](#install-the-cli) · [Usage](#start-a-research-project) · [Current capabilities](#project-status) · [Roadmap](#development-plan) · [Contribute](#help-build-verifold)

## Install the CLI

Use Node 22, 24, or 26 and an installed, authenticated Claude Code or Codex harness. Use the latest patch release of your chosen major:

```sh
npm install -g verifold
verifold
```

You can also run `npx verifold` or install locally with `npm install verifold`. A local installation runs through `npx verifold`.

Verifold starts the selected harness with its existing configuration and permissions. See [security boundaries](SECURITY.md).

## Start a research project

Run `verifold` from your terminal. An existing Verifold project checks for unfinished global setup, then opens its desk. This setup does not change the project’s saved harness or research. Otherwise, setup connects your harness, loads your global profile if available, and offers profile creation before selecting a project folder. After you review the research brief, Verifold creates the project and opens the desk before planning and research. Keep the terminal open. Ctrl+C stops its work and the desk, and pauses a running session.

In a folder without a project, `verifold` asks where to set it up: in the browser (the default) or in the terminal. The browser path opens the desk on the same setup steps: harness and model, the optional profile, the project folder and context, the interview, the brief, and the research mode. The desk shows one question at a time. Consent steps, file limits, retries, and the six-turn interview limit are the same as in the terminal, because both paths run the same setup. The terminal stays open and shows each step as one line. Ctrl+C cancels setup and saves nothing. In the brief review, you can also edit the brief yourself and accept your version. When setup ends, the same desk shows the new project and planning starts. `verifold init`, `--no-open`, and runs without a terminal set up in the terminal.

Use `verifold init` for setup and research entirely in the CLI. Bare launch requires an interactive terminal. `verifold --no-open` prints the desk URL without opening a browser.

Run subsequent commands from that project directory, or add `--workspace <path>`:

```sh
verifold research --feedback "Focus on methods that run on one GPU."
verifold research --approve
verifold status
verifold select
```

`init` connects to Claude Code or Codex with its default model or one you choose. Verifold remembers the harness preference in a global private agency directory. It shows the saved profile summary and Markdown path before collecting project context.

The selected harness asks one follow-up at a time, using your answers and any saved background. Its prompt asks it to reason from first principles: why the problem matters, what assumptions need testing, what evidence would change your mind, and what scope is feasible. It asks about experience and constraints when needed. There is no fixed research questionnaire. The agent writes Markdown, not a required JSON brief. The conversation has up to six turns, with one explicit retry per failed turn. Press Enter or type `/finish` at a follow-up to request the brief early. If a reply fails, retry with your answers intact or review a local brief made from those answers.

Choose your project directory before the interview. `--workspace path` supplies the directory directly. After any directory investigation, add a direction, question, or notes, or enter `/file <path>` to supply a written brief. File import asks permission before reading up to 12000 bytes and sending them to the selected harness. An unreadable file produces a diagnostic, then setup continues with the available context. Press Enter without notes to let your harness help identify a direction from the available context.

Review the full research brief, press Enter to accept it, enter feedback to revise it, or type `/cancel` to stop. Then choose guided or autonomous exploration. Relative paths resolve against the directory where you launched Verifold; the interactive path also accepts `~/`. Missing directories are created. Existing folder contents are preserved; conflicting files, a preexisting `.verifold.md`, and linked scaffold directories are rejected.

Every initialized project receives:

```text
project/
  .verifold.md   Research brief, folder guide, and continuation commands
  .verifold/     Private state, research attempts, and source reports
  literature/   Papers, source notes, and provenance
  experiments/  Reproducible code and configurations
  results/      Raw outputs, metrics, and negative results
  figures/      Plots and regeneration scripts
  docs/         Plans, decisions, methods, and write-ups
  agents/       Project agent briefs and review notes
```

If the selected directory contains existing work, Verifold offers a harness investigation before the interview. With consent, Verifold supplies a bounded selection of top-level documentation and manifests. Your harness can inspect relevant paper, code, and result files, search the web, and use native agents. The request prohibits edits, experiments, installations, and downloads. You review the resulting context before the interview; declining or a failed investigation preserves your original brief. Accepted context stays in the project’s `.verifold.md` and workspace state, not your personal profile. The following interview can use the same project tool scope. These prompts guide the harness; its own permissions remain the enforcement boundary. Topic-only interviews can also use native web search. If local context would help, the harness asks which files or directories it may inspect. Declined directories remain excluded unless you explicitly authorize them later. Personal-profile interviews remain limited to supplied answers.

Verifold starts your installed harness in a background CLI session. The terminal shows observed tool activity without exposing tool inputs or results. The desk shows the full transcript of each run. Claude Code also reports its model and session when available. Tools that require interactive permission can be denied in this mode. Verifold reports Claude permission denials and a `claude --resume <session-id>` command when available, so you can review permissions in the native harness. Verifold does not bypass approvals. A requested tool or agent is not proof that it completed successfully.

The approved brief feeds planning and research in the selected directory. It stays project-scoped; onboarding does not automatically turn it into a reusable personal profile. Run subsequent commands from that directory or pass `--workspace path`.

Use arrow keys or number keys in the harness and research-mode menus. Press Enter to accept, or Escape to cancel. Simple terminals offer numbered text prompts.

When no approved background or previous setup outcome exists, interactive setup offers an optional profile step after harness selection and before project selection. Verifold remembers skipped, declined, and failed setup, so subsequent launches do not repeat it automatically. Choose “Ask my harness to review my chats” to let your harness inspect a selected local history source and draft research context. The source prompt suggests the harness’s usual local session folder; you can choose a narrower folder or an export instead. This does not provide access to cloud chats or guarantee that earlier conversations are available. You can also import a bounded chat sample or one memory file, write an introduction locally, or skip. `init --setup-only` also offers an agent interview.

Imports require permission before reading and sending the text to the harness. You review the Markdown before saving it as `~/.verifold/agency/USER.md`; `settings.json` stores harness preferences. `--agency-dir path` selects an empty directory or an existing Verifold agency.

Later onboarding reuses this approved background without repeating profile questions or rereading its source. Edit or delete `USER.md` to change future reuse; existing project briefs and host records remain. Deleting `USER.md` stops future reuse and does not trigger another history import.

“Import a sample of my chats” inspects at most 200 directory entries and ten files, with a 256 KB per-file limit and 512 KB total. It skips links, hidden subdirectories, oversized files, and unsupported native records. Native JSONL imports retain recognized user-role messages, excluding model responses, tool results, and subagent folders. User-role records can still include harness-injected context; review the profile’s inferences. Ordinary text and JSON exports are supplied as selected. The harness-directed option chooses relevant conversations within the selected source and reports its coverage. Its own permissions enforce access. Both options show the full draft for review before saving `USER.md`. Local storage does not imply offline model processing.

The coordinator proposes a search scope and personas. Guided mode pauses for approval. In the desk, approve the plan or ask for changes. In the terminal that runs the desk, type `/approve` or `/feedback` and your changes. Without a running desk, use `research --feedback` to revise that plan, then `research --approve` to continue. The harness researches the approved scope and returns sources and directions. Initial research does not require PDF downloads.

After directions are available, use `research --feedback` to refine them through the saved coordinator session. `select` asks for an explicit idea ID. Noninteractive selection requires `select --id <idea-id>`. Selection does not start a pilot or experiment.

Autonomous mode proceeds through planning and research, then stops at directions. It preserves the host's tool permissions.

Interactive `init` and `research` show readable results and next steps. Noninteractive runs and `status` return JSON. Interactive mode requires a terminal on stdin and stderr; use `status` when piping saved state to another tool.

Noninteractive initialization requires explicit research inputs. The harness drafts a brief with unknowns from these inputs, then plans and researches without an interview or brief-review prompt:

```sh
verifold init --host claude --topic "Efficient graph algorithms" --autonomy autonomous
# Optional: --model <host-model-id> --agency-dir <private-directory>
```

Use `--host codex` to select Codex. Paths resolve against the current directory. Add `--workspace <path>` to select another project directory.

### Setup and request commands

Use `init --setup-only` to save harness preferences and optionally review context without starting research. Existing `--profile profile.json` imports remain supported as project-scoped legacy profiles:

```sh
verifold init --setup-only --profile profile.json --host codex
verifold recommend
verifold ideas --from ideas.json
verifold select
verifold literature --memory
verifold handoff
verifold view
```

`recommend` prints a host request. `ideas --from` imports an array with `id`, `title`, `recommendation`, and a nonempty `gates` array.

After selection, `literature` prints an optional retention request. `--memory` also requests a Markdown memory file with source-to-file mappings. Both forms only print instructions. They do not invoke the harness or verify downloads. Official citation exports must remain separate from generated summaries.

`handoff` prints a pilot-planning request for the host and Automative. The user must approve scope, evaluator, budget, and gates before execution. Verifold does not execute Automative in this version.

### Manage your global profile

Run `verifold profile` to inspect the full approved Markdown, its path, and its current status. Outside an interactive terminal, the command returns JSON. Inspection reads only Verifold’s global records; it does not create a directory or invoke a harness.

Run `verifold profile --setup` to create, retry, or revise a profile without initializing a project. Setup requires an interactive terminal for source consent and review. Use `--host claude|codex`, `--model <id>`, or `--agency-dir <path>` when needed. These settings apply globally; existing project settings remain unchanged.

`USER.md` determines which background can be reused. `profile-state.json` records the last completed setup outcome separately. Declining a replacement or a failed synthesis preserves the approved profile. Profile inspection reports a missing approved file if it was deleted. The harness preference is saved when setup starts. Cancelling preserves the previous profile and setup outcome; it does not undo that preference.

Profile setup and initialization share a lock for global settings. Only one can update an agency at a time. If its process is killed, the error identifies `profile.lock`; confirm no setup is running before removing it. Drafts still require review before adoption. Profile editing in the browser and selecting several history sources remain planned work.

### Editable harness prompts

Harness instructions live in `src/cli/prompts/*.md`. Each filename is a prompt ID loaded by `src/cli/prompts.ts`. Edit these files to change interview, profile, project-context, research, or handoff instructions. Dynamic user evidence is appended separately by the caller.

Run `npm run build:cli` to copy the prompts into `dist-cli/cli/prompts/` for the CLI package. Installed commands load these bundled files independently of the working directory. No template engine or per-user override directory is configured.

### Local research desk

Run `verifold` inside an initialized project, or `verifold ui --workspace <path>`, to open its browser desk. Keep that terminal open. It runs the project owner, and the desk is a second view of the same owner. Ctrl+C stops the desk and pauses a running session. Use `--no-open` to print the URL without launching a browser. The URL includes a private access token. Keep it private and use the complete URL if the desk asks you to reconnect. Type `/open` in the terminal to open the desk again with a new one-time link.

One Verifold process owns a project at a time. A second `verifold` for the same project names the running process and exits. The owner writes `.verifold/owner.json` with its process ID and start time, and no access token. If that process stopped, the next owner moves the record aside and continues.

The desk shows the question, saved context, research phase, attempt history, and source reports. It refreshes every two seconds. Opening or refreshing the desk does not launch a harness. You start a harness session in the desk or with `verifold session`.

Research runs in the same process as the desk. The desk offers the next research decision: start or continue research, approve the plan, ask for changes, or choose a direction. Choosing a direction needs a second click, because it locks the direction. The terminal that runs the desk accepts the same decisions: `/research`, `/approve`, `/feedback`, and `/select`. While research runs, the Research section shows the step, the time, and the harness events as they arrive. Summary shows a count and the latest event. Details shows the [transcript](#harness-transcripts) of the step. You can cancel the step. A cancel keeps the saved checkpoint and the attempt files. A research step and a harness session do not run at the same time. While the desk runs, `verifold research` in another terminal names the running process and stops.

The desk renders Markdown from the harness. Raw HTML stays visible as text. Links keep only http, https, and mailto targets, and images show only their text. The page sanitizes the rendered Markdown again with a bundled copy of DOMPurify.

Recent activity in the desk means the research owner wrote an observation within ten seconds. It does not prove that a native worker is alive. Research that runs in the desk's process shows the observed harness tool events in the desk and in the terminal. The terminal shows tool names only, not tool inputs or results. A controlled session shows its events in the desk.

### Harness transcripts

Details shows the transcript of each harness run, close to what you see in the harness CLI. This includes research steps, sessions, and the setup interview. Each tool call shows its name and target. Open a call to see its full input and output. Subagent work shows under the tool call that started it: Claude Code subagents under their Agent call, and Codex agent threads under their agent call. Open all and Close all change every call. Full screen fills the window with the transcript. Press Escape to close it. Selected attempt shows the transcript of an earlier research attempt.

Verifold saves transcripts in private project files: `.verifold/runs/<attempt-id>/transcript.jsonl` for research and `.verifold/sessions/<session-id>.transcript.jsonl` for sessions. Setup keeps its transcript in memory only. Each text field keeps at most 64 KB, with a note where Verifold cut it. A transcript stops at 16 MB, with a note. Verifold removes terminal control characters. A transcript shows what the harness reported. It does not show processes that a command started, and agent text remains a model claim. Research attempts from before Verifold saved transcripts have none. Requested models, returned session IDs, and model claims about delegation remain distinct from observed protocol events.

### Controlled harness session

Start one harness session from the desk, or from the terminal:

```sh
verifold session --prompt "Reproduce the baseline" --host codex --mode ask
```

The session runs in the project folder with the harness's own sign-in, settings, and permissions. Verifold starts Claude Code with its stream-json control protocol (`--permission-prompt-tool stdio`) and Codex with `codex app-server`. The owner controls one session at a time. The desk cannot start a session while `verifold` runs research in the same terminal. The desk shows that research is running and disables Start session until research ends. If a desk action fails, the reason appears next to that control.

In Ask me mode, each permission request from the harness goes to the desk and to the terminal. You allow it once or deny it, and the harness enforces the answer. For Codex, Verifold sends approvals to you (`approvalsReviewer: "user"`), even if your Codex configuration uses its reviewer agent. Codex runs commands inside its sandbox without a request. A network call that the sandbox blocks can fail without a request.

In Auto mode, Claude Code uses its `auto` permission mode, and Codex sends approvals to its reviewer agent. The desk shows the mode that the harness reports. It can differ from the requested mode, for example when Claude Code does not allow Auto for a model.

While a turn runs, you can cancel it. When a turn ends, send a follow-up or end the session. In the terminal, type `/start` and a request to start a session with the project's harness in Ask me mode. Type `a` to allow once or `d` to deny the open request. When several requests are open, add the ID, for example `a R2`. Type a follow-up when the agent waits, or type `/cancel` or `/end`. Type `/help` for all terminal commands. Without an interactive terminal, requests wait for the desk, the session ends after the first turn, and `session` prints a JSON summary with the record path.

The Commands table lists each tool call that the harness reports, with the exact command or target, who let it run, risk tags, and the result:

| Label                                          | Meaning                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| You allowed, You denied, Not answered          | You answered the permission request, or the turn ended before you answered.                                                                                        |
| Denied by Claude Code                          | The harness denied the call, for example through a settings rule or its Auto classifier.                                                                           |
| Auto, no person                                | Claude Code ran the call in Auto mode without a request. Claude Code does not report whether its classifier or a rule allowed it.                                  |
| Codex reviewer approved, Codex reviewer denied | The Codex reviewer agent decided. The table shows its reason.                                                                                                      |
| No prompt, Ran in the sandbox                  | The call ran without a request under the harness's own rules, for example a read-only command. Ran in the sandbox applies to Codex commands and file changes only. |

A permission request shows the tool input, not a description written by the model. For a write or an edit, the desk also shows the content that would change. Risk tags (Network, Install, Deletes files, Settings files, Outside folder) come from the command text. A risky call that no person approved waits for review until you mark it reviewed. The record shows the command that the agent asked for. It does not show commands inside a script or processes that a command starts. Agent text is a model claim. Tool calls, requests, and decisions come from the harness protocol.

Verifold saves each session in `.verifold/sessions/<session-id>.json` before it starts the harness. The record keeps the latest 400 events and 1000 tool calls, and one entry for each harness process that ran the session. Verifold gives Claude Code its session ID at launch (`--session-id`) and records the Codex thread ID when Codex reports it.

Ctrl+C pauses a running session: Verifold stops the current turn and the harness process, and keeps the native session ID. The outcome of a turn that Ctrl+C stopped is unknown. The next `verifold` in the folder lists paused sessions in the desk. Resume, or `/resume` in the terminal, continues the same conversation in a new harness process with Claude Code `--resume` or Codex `thread/resume`. A session that ended or failed cannot resume.

If Verifold stops without saving the end of its work, for example after a forced termination, the next `verifold` in the folder checks each unfinished session and research attempt before it starts anything. A harness process that still runs stops first, but only when its recorded process start time matches, so a reused process ID cannot cause a wrong stop. The work becomes interrupted, with an unknown outcome, and tool calls that were running show as unknown. A session with a recorded conversation can resume. A session without one runs its first request again. Claude Code keeps its session ID for that run, so it cannot create a second conversation. An interrupted research attempt keeps its files. Continue research to run the step again.

## Privacy and website

Project state stays in `.verifold/workspace.json`. Research attempts keep briefs, responses, reports, and harness transcripts under `.verifold/runs/<attempt-id>/`. Session records under `.verifold/sessions/` keep your messages, agent text, exact commands, and harness transcripts. A transcript keeps full tool inputs and results, for example the contents of files that a tool read. These files can contain private research information.

Initialization adds `/.verifold/` and `/.verifold.md` to the workspace's `.gitignore` and creates state with private permissions. This prevents ordinary accidental staging. It does not prevent intentional publication or access by processes under the same account.

The selected harness uses its configured model services and research tools. Local state does not imply that those services run offline. Verifold creates no remote profile or publication.

`ui` serves only the selected project on loopback, with authenticated project reads and bundled assets. Session actions use authenticated JSON requests to the same local server. It rejects unexpected hosts and origins. It serves the harness transcripts of the selected project only to the authenticated page. It does not serve arbitrary files. `view` creates a read-only local HTML snapshot with no external assets. The Vite website explains the CLI entry point. Remote profile synchronization remains future work. The nested `verifold-website/` repository remains independent.

## Project status

This README describes the current source checkout. The published npm package can lag changes that have not been released.

| Available in this checkout | What it does                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| Context-first onboarding   | Reviews optional personal background and project context before your harness interviews you.        |
| Project initialization     | Creates `.verifold.md` and folders for literature, experiments, results, figures, docs, and agents. |
| Landscape research         | Saves planning, source links, proposed directions, and feedback; you explicitly select an idea.     |
| Reviewed background        | Imports one selected text export with consent and review through setup-only personalization.        |
| Local research records     | Retains attempt files and provides CLI status plus a read-only HTML snapshot.                       |
| Controlled session         | Runs one Claude Code or Codex session from the desk or terminal and relays its permission requests. |
| Command record             | Records each tool call in a session with who let it run, risk tags, and a review mark.              |

This is an early implementation. Native delegation is requested and reported by the host, not independently verified by Verifold.

Optional literature retention and pilot handoff commands produce requests for the host. They do not download PDFs, create a literature memory file, or run experiments. Worker supervision and experiment execution follow the development sequence below. Scheduled memory, public collaboration, and cloud synchronization are deferred.

## Development plan

Build a local workspace for independently controlled research agents. Keep one npm distribution and a browser UI initially. CLI and browser will use the same operations, while the selected harness retains its models, credentials, tools, and permissions.

Stage 1 is available in this checkout as the [controlled harness session](#controlled-harness-session). The later stages are planned work. Each stage builds on the preceding stage's completion criteria.

| Order | Deliverable                       | Complete when                                                                                                                                                                                        |
| ----- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | One controllable harness session  | Start a session, see identified live events, send a follow-up, and cancel from the browser through shared CLI operations. Native permission requests have a supported response or continuation path. |
| 2     | Persistent ownership and recovery | A local owner keeps sessions independent of browser connections. Reconnect restores identity; owner restart reconciles surviving, interrupted, and unknown work before retry.                        |
| 3     | Scoped tasks and isolated writes  | Tasks have objectives, dependencies, input records, writable scopes, outputs, owners, and limits. Writers use separate workspaces; duplicate or stale claims are rejected.                           |
| 4     | Two independent harness workers   | Claude Code and Codex run adjacent assignments concurrently. Cancelling or blocking one does not stop or mislabel the other. Both are visible in the desk.                                           |
| 5     | Interactive terminal workspace    | Supported workers have native terminal views with input, resize, bounded replay, and explicit input ownership. Reload and protocol handoff preserve identity without duplicate live owners.          |
| 6     | Coordinator and durable handoffs  | A coordinator assigns and labels tasks, exchanges evidence-linked messages, and revises dependent work through the same manager operations. Runtime code enforces ownership and limits.              |
| 7     | Reviewed research deliverables    | Parallel investigation, an objection, and revision produce a reviewed memo/report bundle. Accepted artifact versions, producing attempts, failed work, and unresolved objections remain inspectable. |
| 8     | Owned experiment execution        | An approved local experiment has fixed inputs and evaluator, resource allocation, cancellation, retained results, and recovery. Managed jobs cannot double-book a shared compute slot.               |

The first usable multi-agent workspace ends at stage 6. Stage 7 completes the research-delivery workflow. Stage 8 adds experiment execution; a planning record or report does not establish that an experiment ran.

Start by extending the existing attempt record and harness adapter. Extract shared operations where the first browser control needs them. Record native session identity and bounded structured events as they arrive. Keep existing CLI JSON and foreground Ctrl+C behavior; persistent sessions have an explicit attach/detach contract.

Worktrees reduce checkout collisions but do not establish sandbox isolation. Keep authoritative writes serialized and require review before integrating worker output. Record scoped inputs with each attempt. A generated label or model report cannot override observed execution state or expand permissions.

The first complete demonstration connects a prior-art worker and a method/baseline reviewer. The researcher observes both, intervenes in one, and reconnects without relaunch. An evidence-linked objection leads to revised work and a reviewed literature-gap memo with a reproducible report. Experiment measurements enter this flow only after stage 8.

After the core workflow is used, reassess desktop distribution from actual installation and interaction needs. A native launcher or optional desktop application can reuse the same manager and UI. Split installation only when native dependencies or an independently shipped application justify it.

Full browser onboarding, automatic memory maintenance, procedure optimization, a public board, cloud synchronization, and broad remote provisioning are outside this sequence. Existing approved background and project context remain available. Harness readiness checks and scoped context belong inside the execution features that need them.

See the [implementation roadmap](https://github.com/MVPandey/Verifold/issues/14) for completion criteria and validation requirements.

## Help build Verifold

See [open issues](https://github.com/MVPandey/Verifold/issues) for current contributions. Each issue defines its prerequisites and acceptance criteria.

The wider goal is a shared home for computational science, including math, CS/ML, and security. Researchers should be able to inspect assumptions, critique an analysis, rerun an experiment, or contribute an adjacent investigation. Failed attempts and unresolved objections belong beside successful results.

Work starts private. The planned public board will share only what the owner selects, with enough evidence for others to test and continue the investigation. Publication should preserve an inspectable record of how a conclusion was reached.

[Open an issue](https://github.com/MVPandey/Verifold/issues) with a workflow, a reproducible problem, or a contribution you want to make. Use public examples and keep private research out of the issue. For code changes, read the engineering rules below and run `make validate` before opening a pull request.

## Build from source

For development or unreleased changes, clone the repository and use its pinned Node version. With `nvm` installed:

```sh
git clone https://github.com/MVPandey/Verifold.git
cd Verifold
nvm use
npm ci
npm run build:cli
node dist-cli/cli.js init
```

In this checkout, replace `verifold` in the examples above with `node dist-cli/cli.js`. Rebuild after source changes.

## Engineering

Internal agent research, planning notes, and coordination records belong in `.local/agents/`, which Git ignores. Keep public documentation in `docs/`. Do not publish private notes through commits, issue bodies, or pull request descriptions.

Read [AGENTS.md](AGENTS.md) before contributing.
It defines the required Node.js, technical-English, and ponytail skills, plus review and validation rules.
The skill editions live in `.agents/skills/` and require no personal skill installation.

`src/cli.ts` owns process lifecycle and terminal streams. CLI command handlers coordinate research and profile operations. The harness adapter owns subprocess arguments and response parsing. Research contracts validate returned data, and storage owns atomic state changes.

Structured results use stdout. Prompts, diagnostics, the violet/lavender folded VF welcome, and activity indicators use stderr. The welcome has a brief fold highlight; selected menu rows update in place and completed choices collapse into a short transcript. Agent Markdown in the terminal shows headings, bold, italics, inline code, and links in color. Text wraps to the terminal width, including long paths and common wide Unicode characters. Short windows show a compact selector. Indicators show time spent waiting for a real harness response; they do not claim individual subagent progress. Set `VERIFOLD_REDUCED_MOTION=1` for static activity messages. `NO_COLOR` disables color and animation; `TERM=dumb` also uses numbered text menus. Noninteractive commands keep their machine-readable output.

Normal research failures preserve the saved checkpoint. Inspect `status` and the attempt files before continuing. A forced termination such as SIGKILL can leave `.verifold/research.lock`. The next owner removes it when no research attempt shows activity in the last ten seconds. Older Verifold versions do not take the owner lock, so confirm that none of them runs research before you remove a lock yourself. Apply the same check to a stale `write.lock` before another state write.

New research attempts save `attempt.json` beside their evidence. It records the Verifold attempt ID, harness, requested model, starting phase, timestamps, requested session, and returned native session separately. A null model means the harness default was requested. It does not identify the resolved model.

`succeeded` means the response passed Verifold validation and the phase checkpoint was saved, not that its scientific claims were verified. `failed` and `cancelled` preserve available evidence. Inspect the checkpoint before retrying. A record left at `started` has an unknown final outcome and does not prove that a process remains alive. Older attempts have no record. The desk scans at most 200 history entries, includes the latest recorded attempt separately, and marks unreadable records as unknown. Process recovery remains manual.

`make validate` runs formatting, type-aware linting, strict types, tests, both builds, and a packed CLI consumer check. Enable the commit and push hooks in each clone:

```sh
git config --local core.hooksPath .githooks
```

See [validation scope](docs/validation.md). Source-link validation does not verify scientific claims or establish citation provenance.

The harness package is MIT licensed. The website and visual brand assets are outside that grant. See [license scope](LICENSING.md). The bundled Manrope font retains its SIL Open Font License.
