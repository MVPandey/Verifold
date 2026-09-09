<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/assets/verifold-horizontal-dark.webp" />
    <img src="public/assets/verifold-horizontal.webp" alt="Verifold" width="360" />
  </picture>
</p>

<p align="center"><strong>Research beyond the paper plane.</strong></p>

<p align="center">
  <a href="https://github.com/MVPandey/Verifold/actions/workflows/validate.yml"><img src="https://github.com/MVPandey/Verifold/actions/workflows/validate.yml/badge.svg?branch=main" alt="Validation workflow status" /></a>
  <a href=".nvmrc"><img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24" /></a>
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

The CLI questionnaire, private workspace, recommendation import, explicit idea selection, planning handoff, and local HTML view are implemented. Host-specific plugins, automated paper ingestion, live Automative execution, and cloud synchronization are still in development. The package is not published to npm.

## Run locally

Clone and build with Node 24:

```sh
git clone https://github.com/MVPandey/Verifold.git
cd Verifold
nvm use
npm ci
npm run build:cli
```

The executable is `node dist-cli/cli.js`; a locally packed and installed package exposes `verifold`. The package is not published to npm.

```sh
node dist-cli/cli.js init
node dist-cli/cli.js recommend
node dist-cli/cli.js ideas --from ideas.json
node dist-cli/cli.js select
node dist-cli/cli.js handoff
node dist-cli/cli.js view
```

`init` asks the questionnaire in the terminal: researcher name, scientific interests, optional Scholar/GitHub links, a selected coding-session reference, and existing harness name. It never scans session directories. Noninteractive hosts supply `--profile profile.json` and optionally `--host name`. Paths resolve against the current directory; `--workspace` selects a workspace.

`recommend` emits a JSON request for the existing host to act on. The host returns an idea array containing `id`, `title`, `recommendation`, and `gates` (a nonempty array of proposed task-specific checks). `ideas --from` validates and imports that file. `select` displays the options, agent recommendations, and proposed gates before asking for an ID; noninteractive use requires explicit `--id`. No automatic choice or experiment launch occurs.

`handoff` returns a structured pilot-planning request for the host and Automative. It does not install a host plugin, generate a validated Automative specification, or execute Automative yet. The host must obtain approval of the pilot scope, evaluator, budget, and task-specific gates before launching. Math, CS/ML, security, and any other fully computational research are in scope. Agent opinions on verification remain proposals until accepted.

## Privacy and website

State is stored in `.verifold/workspace.json` with private permissions; initialization adds `/.verifold/` to the workspace's `.gitignore`. This prevents accidental normal Git staging, not intentional publication or access by other processes under the same account. No remote profile, cloud connection, or publication is created.

`view` generates `.verifold/workspace.html` from the CLI-owned state. It is a read-only local snapshot with no external assets or network requests. The Vite website is now an entry-point explanation, not a second onboarding form. Remote website profile synchronization remains a future CLI adapter. The nested `verifold-website/` landing-page repository remains independent and unchanged.

## Engineering

`src/cli.ts` owns process lifecycle, signals, and terminal streams. `src/cli/commands.ts` orchestrates commands with injected terminal I/O. `contracts.ts` validates host data; `storage.ts` owns private atomic state changes under an exclusive lock. Host commands emit JSON to stdout; prompts and diagnostics use stderr. An interrupted write may leave a `write.lock`; inspect the workspace and confirm no writer is active before removing that lock. Initialization and existing selections are not silently overwritten.

`make validate` checks formatting, type-aware lint, strict types, tests, both builds, and a real packed CLI installed offline into an isolated consumer. It tests help/errors and a representative host recommendation → selection → handoff flow. Pre-commit and pre-push use this same gate; enable per clone with `git config --local core.hooksPath .githooks` (already active here).

The software package is currently marked `UNLICENSED`; public visibility does not grant an open-source license. The bundled Manrope font retains its included SIL Open Font License.

See [product direction](docs/product-direction.md) and [repository reviews](docs/research/). Live paper ingestion, host-specific plugin registration, Automative execution, and cloud synchronization are not implemented yet.
