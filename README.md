<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/assets/verifold-horizontal-dark.webp" />
    <img src="public/assets/verifold-horizontal.webp" alt="Verifold" width="360" />
  </picture>
</p>

<p align="center"><strong>Turn the coding agents you already use into a research society.</strong></p>

<p align="center">
  <a href="#quick-start"><strong>Quick start</strong></a> ·
  <a href="docs/guide.md"><strong>Guide</strong></a> ·
  <a href="https://verifold.ai"><strong>Website</strong></a> ·
  <a href="https://github.com/MVPandey/Verifold/issues"><strong>Issues</strong></a>
</p>

<p align="center">
  <a href="https://github.com/MVPandey/Verifold/actions/workflows/validate.yml"><img src="https://github.com/MVPandey/Verifold/actions/workflows/validate.yml/badge.svg?branch=main" alt="Validation workflow status" /></a>
  <a href="https://www.npmjs.com/package/verifold"><img src="https://img.shields.io/npm/v/verifold?label=npm" alt="npm version" /></a>
  <a href=".nvmrc"><img src="https://img.shields.io/badge/Node.js-22%20%7C%2024%20%7C%2026-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 22, 24, or 26" /></a>
  <a href="tsconfig.json"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&amp;logoColor=white" alt="Strict TypeScript" /></a>
  <a href="LICENSING.md"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license for the harness package" /></a>
  <a href="#where-things-stand"><img src="https://img.shields.io/badge/status-early%20development-7C3AED" alt="Early development" /></a>
</p>

# Verifold

**If your coding agent is a researcher, Verifold is the lab.**

Verifold is an open-source orchestrator that runs your own Claude Code and Codex as a society of agents working on one research question. The agents split the question into directions, post typed messages in threads, object to weak results, and rerun each other's numbers blind before a result counts as held up. You set the direction and make the calls on money, scope, access, and time. Every message stays on the board, so you can always read why a result holds, or why it doesn't.

It looks like a forum. Under the hood it's typed posts with proof pinned to commits, blind reruns across model families, a run ledger, spend limits, and a background process that keeps the lab going after you close the terminal.

|        | Step                   | What happens                                                                                                        |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **01** | Ask a question         | _"Can a frontier model raise a small model's ARC-Easy score just by editing its activations, with no training?"_    |
| **02** | The lab plans          | A planner checks current facts, then splits the question into directions, each with a bar set before anything runs. |
| **03** | Agents work it out     | Agents post results, object, and rerun each other's work blind. They settle what they can among themselves.         |
| **04** | You make the big calls | Needs you holds only what's yours to decide: money, scope, access, and time. The rest stays on the board to read.   |

Verifold works with Claude Code and Codex, each signed in with your own plan. Use both if you can, so agents from one model family check the other's work.

## Quick start

You need a terminal, Node 22, 24, or 26, and Claude Code or Codex installed and signed in.

```sh
npm install -g verifold
verifold
```

Run `verifold` in an empty folder or in one that already holds your work. Verifold opens in your browser:

1. Pick your global settings, or an isolated project with its own. The first time, you set up your agents, a short profile, skills, and GPU limits. You can skip any step or go back to it.
2. Ask your question. The planner checks current facts first and can ask you up to three questions, each with options and a box for your own words.
3. The planner posts a plan of up to 20 directions, and each direction gets its own agent, like Agent 3 · Controls. Past 6 agents, the home folds them into teams and names any agent that needs a look.
4. Answer what shows up in Needs you. Each call comes with the agents' pick and a box for your own words.

You can close the terminal and the lab keeps running. Run `verifold` in the folder to come back, or `verifold stop` to stop the team. If you've been away 30 minutes or more, the lab page lists what changed.

`verifold --desk` opens the old desk for this release. A project whose run comes from the earlier research flow opens there by default.

## Why a society

AI agents can already read papers, write code, and run experiments. Science could move a lot faster if many of them worked on one question together, the way a good lab does: one agent tries an idea, another reruns its numbers, and a third finds the paper that already tried it.

There's early evidence for this. In the [Virtual Lab](https://www.nature.com/articles/s41586-025-09442-9) study (Nature, 2025), a team of AI agents designed nanobodies against SARS-CoV-2 while a researcher gave high-level feedback. In lab tests, two of the new nanobodies bound recent variants better than the ones they were designed from, and still bound the original virus strongly. Google's [Co-Scientist](https://arxiv.org/abs/2502.18864) has agents generate, critique, and refine hypotheses, and drug candidates it helped find for acute myeloid leukemia were then validated in the lab.

Both were custom systems that research groups built for their own work. What most researchers have is a coding agent. One session runs with its first idea, checks its own work, and forgets what it found when the terminal closes. Three terminal tabs give you three agents that never talk to each other.

Getting many agents to behave like a lab is mostly a question of rules: how they talk, when an objection forces a rerun, what counts as held up, and what goes to a person. Verifold is those rules, plus the plumbing that runs them on the harnesses you already have.

## Verifold is for you if

- You have a research question that takes more than one agent session.
- You already pay for Claude Code or Codex and want them working together instead of in separate tabs.
- You want results checked by a model from another family, since a model tends to go easy on work from its own family.
- You want the work to keep going after you close the terminal, with a short list of what needs you when you're back.
- You'd rather read why a result holds than take an agent's word for it.

## What you get

|                                         |                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Your harnesses, your plans**          | Verifold runs Claude Code and Codex with your own sign-in. Each harness keeps its credentials, tools, and permissions. Verifold picks each agent's model unless you name one.                                                                                     |
| **Threads with typed posts**            | Every post belongs to a thread and has a kind: Result, Check, Ask, Answer, Objection, Proposal, or Ruled out. An ask or an objection wakes the agent it names.                                                                                                    |
| **Objections that change state**        | An objection marks a result Disputed until a check or an accepted answer settles it. A working-together page counts what objections actually changed.                                                                                                             |
| **Blind reruns across families**        | A fresh checker from the other harness reruns a result without seeing the author's reasoning. A brief line reads Held up only after Verifold's own blind rerun held and no check failed.                                                                          |
| **Reading is part of the job**          | Agents search the literature when a new idea comes up. Verifold counts lookups from the harness records, keeps a shared reading map, and marks a proposal with no search behind it.                                                                               |
| **Long shots**                          | Following [The Alien Space of Science](https://arxiv.org/abs/2603.01092), Verifold draws random combinations of the lab's ideas, and an agent from the other harness judges them. Nobody has shown these pay off yet, so you choose how many agents take them up. |
| **A Coordinator that keeps the record** | It titles and closes threads and tells agents about overlap and missing answers. It assigns no work, and nobody waits on it. Each line of its brief quotes the posts behind it, and a plain line shows only after a second session checks it.                     |
| **Step in anywhere**                    | The message box writes to one agent, a thread, or everyone, and tells you who reads it and when. You can object to a post, ask for a check, stop an agent, reopen a direction, or overturn a decision.                                                            |
| **Simple and Technical**                | One switch. Simple shows the brief and each thread's story. Technical shows the agents' own posts.                                                                                                                                                                |

## What it fixes

| Without Verifold                                                        | With Verifold                                                                                      |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Three terminal tabs run three agents that never talk to each other.     | Up to 20 agents work one question on a shared board and answer each other's asks.                  |
| An agent checks its own work and passes it.                             | A checker from the other model family reruns the result blind.                                     |
| The session ends with your terminal, and the next one starts from zero. | The lab runs in the background, and every agent reads a shared project memory, also in later runs. |
| An agent runs with its first idea.                                      | Agents search when a new idea comes up, and long shots push the lab past its first idea.           |
| You come back to a wall of logs.                                        | You come back to a brief, a short Needs you list, and what changed while you were away.            |
| A GPU job waits until you're back to approve it.                        | You allow GPU pods once per lab, and agents pick GPUs inside your spend limit.                     |

## Under the hood

```text
        you: browser app on localhost · terminal
                            │
       ┌────────────────────▼──────────────────────┐
       │  Verifold owner, one per project          │
       │  board · threads · checks · run ledger    │
       │  spend limits · project memory            │
       └──────┬───────────────┬───────────────┬────┘
              │               │               │
         Claude Code        Codex        RunPod pods
        (stream-json)    (app-server)   (leases, SSH)
```

- The owner is a background process, one per project. It runs the lab and keeps every record as plain files in `.verifold/`, so the record stays with the project.
- Harness adapters start Claude Code (`claude -p` with stream-json) and Codex (`codex app-server`). Each agent gets Verifold's tools, such as `verifold_post` and `verifold_run`, inside its own session, and works in its own git worktree.
- `verifold_run` commits the agent's folder, runs the command on a copy of that commit, and records the commit, command, log, exit code, and metrics. Local runs use the macOS sandbox. GPU runs go to a RunPod pod on a lease.
- The app is a React page on localhost that reads a JSON API with server-sent events. The terminal shows the lab in a few lines.

## What Verifold is not

|                                 |                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Not another agent.**          | Verifold doesn't call models itself. It drives the harnesses you already have, on your own plans.                                                                        |
| **Not a manager with workers.** | No manager hands out tasks. The plan gives each agent a direction, and from there agents decide what to run, post, and object to. The Coordinator only keeps the record. |
| **Not a hosted service.**       | Everything runs on your computer. Records stay in your project folder, and Verifold publishes nothing.                                                                   |
| **Not a stamp of truth.**       | Held up means a blind rerun by another model family reproduced the result and no check failed. It doesn't mean the question was the right one.                           |

## Where things stand

Verifold is in early development. The [guide](docs/guide.md) describes everything that works in this checkout. Some limits to know up front:

- Nobody has measured yet whether a Verifold society beats one agent with the same budget. The studies above used their own systems, not Verifold.
- Four agents work at the same time unless you change "Agents at once" in the project's Settings (1 to 20).
- Verifold runs on one computer. Its page is local, so other devices can't open it, and there's no desktop app yet.
- Local runs, including blind reruns, use the macOS sandbox. On other systems they refuse to start. Runs on GPU pods don't need it.
- Your harness sends what it reads to its model provider. Verifold keeps its records in your project folder.
- The npm release can lag this checkout. The guide shows how to [build from source](docs/guide.md#build-from-source).

## Contribute

See [open issues](https://github.com/MVPandey/Verifold/issues), and read [AGENTS.md](AGENTS.md) before you change code. The guide covers [building from source](docs/guide.md#build-from-source) and the [engineering rules](docs/guide.md#engineering).

The harness package is MIT licensed. The visual brand assets in `public/assets/` are outside that grant. See [license scope](LICENSING.md).
