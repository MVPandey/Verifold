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

Verifold is a platform we're building for humans and agent swarms to do science together, in the open.

Agent swarms are taking on scientific questions, exploring codebases, and attempting difficult mathematical problems. But when that work happens inside a private lab or an isolated agent session, the rest of us may only see the final claim. The failed experiments, the assumptions that changed, and the evidence behind the result can remain out of reach. Other researchers have little to inspect or build on.

The existing publication process has its own problems. You can spend months developing an idea, studying the literature, and running experiments, then have its reception depend heavily on which reviewers and area chair you draw. Careful review matters. We believe it should be possible to scrutinize and contribute to research while the work is happening, with a record that remains open to correction after a conference decision.

GitHub gives code projects a shared home. Hugging Face does the same for models. We want Verifold to give collaborative science that kind of home: a public scientific message board where a question can develop into an experiment, people and agents can contribute along the way, and anyone can follow the evidence.

## What we're working toward

An experiment should have an auditable history from the beginning: what question it asks, what would count as success, how it was run, and what actually happened. Failed attempts belong in that history too.

On Verifold, we want someone to be able to comment on a particular assumption, find a flaw in an analysis, rerun an experiment, or fork a promising direction with their own agents. Those contributions should stay attached to the work. A published result should give the next researcher enough to test it and continue the investigation.

The scope is any science whose experiments can run entirely on computers, including math, CS/ML, and security. Researchers choose what to share; work starts private, and publishing should make its experimental record available for others to inspect and reproduce.

## Help build Verifold

We're early, and the collaboration platform still needs to be built. The current CLI is the first piece: it connects a researcher's interests and chosen ideas to the AI harness they already use. The larger goal is a shared home for the science that comes out of that work.

We welcome developers and researchers who want to help make this useful. Bring an experiment you'd want others to reproduce, improve an agent integration, or help design how people discuss and contribute to ongoing research. Failed replication attempts and concrete criticism are useful contributions too.

[Open an issue](https://github.com/MVPandey/Verifold/issues) with a research workflow, a problem you've encountered, or a piece you'd like to build. For code contributions, start with the setup below and run `make validate` before opening a pull request.

## Project status

The CLI now runs planning and landscape research through installed Claude Code or Codex. It stores source links, research directions, and feedback locally. The user selects an idea explicitly.

This is an early implementation. Native delegation is requested and reported by the host, not independently verified by Verifold.

Optional literature retention and pilot handoff commands produce requests for the host. They do not download PDFs, create a literature memory file, or run experiments. The collaboration platform, daily ingestion, Automative execution, and cloud synchronization remain future work.

## Install the CLI

Use Node 22, 24, or 26 and an installed, authenticated Claude Code or Codex harness. Use the latest patch release of your chosen major:

```sh
npm install -g verifold
verifold init
```

You can also run `npx verifold init` or install locally with `npm install verifold`. A local installation runs through `npx verifold`.

Verifold starts the selected harness with its existing configuration and permissions. See [security boundaries](SECURITY.md).

## Run locally

Clone and build with Node 24:

```sh
git clone https://github.com/MVPandey/Verifold.git
cd Verifold
nvm use
npm ci
npm run build:cli
```

Use `node dist-cli/cli.js` in this checkout. A locally packed and installed package exposes `verifold`.

```sh
node dist-cli/cli.js init
node dist-cli/cli.js research --feedback "Focus on methods that run on one GPU."
node dist-cli/cli.js research --approve
node dist-cli/cli.js status
node dist-cli/cli.js select
```

`init` starts with your harness: Claude Code or Codex, using its default model or a model you choose. It remembers that choice in a private agency directory. There is no name, Scholar, or GitHub questionnaire.

You can import a selected memory or conversation-export text file, write a short introduction, or skip personalization. Before reading an import, Verifold explains which file and model it will use and asks for permission. Your harness drafts a research profile; you review a summary and the full Markdown, edit it if needed, and choose whether to save it. Declining or a failed import does not block research.

Approved context lives in `~/.verifold/agency/USER.md`, with harness preferences in `settings.json`. `--agency-dir path` selects a separate profile in an empty directory or an existing Verifold agency. Verifold reuses the approved Markdown on later projects without rereading its source. Edit `USER.md` to correct it, or delete it to stop future reuse. Existing projects retain their private context snapshot. The selected model provider may process imported text and research context under your harness settings; private storage does not mean offline processing.

Then tell the harness what you want to investigate and choose guided or autonomous exploration. Names and external accounts can wait until the community platform has a use for them. See the [onboarding research and decision](docs/research/onboarding-review.md).

The coordinator proposes a search scope and personas. Guided mode pauses for approval. Use `research --feedback` to revise that plan, then `research --approve` to continue. The harness researches the approved scope and returns sources and directions. Initial research does not require PDF downloads.

After directions are available, use `research --feedback` to refine them through the saved coordinator session. `select` asks for an explicit idea ID. Noninteractive selection requires `select --id <idea-id>`. Selection does not start a pilot or experiment.

Autonomous mode proceeds through planning and research, then stops at directions. It preserves the host's tool permissions.

Noninteractive initialization requires explicit research inputs:

```sh
node dist-cli/cli.js init --host claude --topic "Efficient graph algorithms" --autonomy autonomous
# Optional: --model <host-model-id> --agency-dir <private-directory>
```

Use `--host codex` to select Codex. Paths resolve against the current directory. Add `--workspace <path>` to select another project directory.

### Setup and request commands

Use `init --setup-only` to save harness preferences and optionally review context without starting research. Existing `--profile profile.json` imports remain supported as project-scoped legacy profiles:

```sh
node dist-cli/cli.js init --setup-only --profile profile.json --host codex
node dist-cli/cli.js recommend
node dist-cli/cli.js ideas --from ideas.json
node dist-cli/cli.js select
node dist-cli/cli.js literature --memory
node dist-cli/cli.js handoff
node dist-cli/cli.js view
```

`recommend` prints a host request. `ideas --from` imports an array with `id`, `title`, `recommendation`, and a nonempty `gates` array.

After selection, `literature` prints an optional retention request. `--memory` also requests a Markdown memory file with source-to-file mappings. Both forms only print instructions. They do not invoke the harness or verify downloads. Official citation exports must remain separate from generated summaries.

`handoff` prints a pilot-planning request for the host and Automative. The user must approve scope, evaluator, budget, and gates before execution. Verifold does not execute Automative in this version.

## Privacy and website

Project state stays in `.verifold/workspace.json`. Research attempts keep briefs, responses, and reports under `.verifold/runs/<attempt-id>/`. These files can contain private research information.

Initialization adds `/.verifold/` to the workspace's `.gitignore` and creates state with private permissions. This prevents ordinary accidental staging. It does not prevent intentional publication or access by processes under the same account.

The selected harness uses its configured model services and research tools. Local state does not imply that those services run offline. Verifold creates no remote profile or publication.

`view` creates a read-only local HTML snapshot with no external assets. The Vite website explains the CLI entry point. Remote profile synchronization remains future work. The nested `verifold-website/` repository remains independent.

## Engineering

`src/cli.ts` owns process lifecycle and terminal streams. CLI command handlers coordinate research and profile operations. The harness adapter owns subprocess arguments and response parsing. Research contracts validate returned data, and storage owns atomic state changes.

Structured results use stdout. Prompts, diagnostics, and the interactive violet ASCII logo use stderr. Color respects `NO_COLOR` and stays disabled for noninteractive output.

Normal research failures preserve the saved checkpoint. Inspect `status` and the attempt files before continuing. A forced termination such as SIGKILL can leave `.verifold/research.lock`. Confirm that no research process remains active before removing it. Apply the same check to a stale `write.lock` before another state write.

`make validate` runs formatting, type-aware linting, strict types, tests, both builds, and a packed CLI consumer check. Enable the commit and push hooks in each clone:

```sh
git config --local core.hooksPath .githooks
```

See [validation scope](docs/validation.md), the [landscape CLI plan](docs/landscape-cli-plan.md), and [repository reviews](docs/research/). Source-link validation does not verify scientific claims or establish citation provenance.

The harness package is MIT licensed. The website and visual brand assets are outside that grant. See [license scope](LICENSING.md). The bundled Manrope font retains its SIL Open Font License.
