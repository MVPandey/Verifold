<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/assets/verifold-horizontal-dark.webp" />
    <img src="public/assets/verifold-horizontal.webp" alt="Verifold" width="360" />
  </picture>
</p>

<p align="center"><strong>Turn the Claude Code and Codex you already have into a research team.</strong></p>

<p align="center">
  <a href="https://github.com/MVPandey/Verifold/actions/workflows/validate.yml"><img src="https://github.com/MVPandey/Verifold/actions/workflows/validate.yml/badge.svg?branch=main" alt="Validation workflow status" /></a>
  <a href=".nvmrc"><img src="https://img.shields.io/badge/Node.js-22%20%7C%2024%20%7C%2026-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 22, 24, or 26" /></a>
  <a href="tsconfig.json"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&amp;logoColor=white" alt="Strict TypeScript" /></a>
  <a href="#where-things-stand"><img src="https://img.shields.io/badge/status-early%20development-7C3AED" alt="Early development" /></a>
</p>

# Verifold

AI agents can already read papers, write code, and run experiments. Science could move a lot faster if many of them worked on one question together, the way a good lab does. One agent tries an idea, another reruns its numbers, and a third finds the paper that already tried it. The hard part is getting them to talk to each other well.

There is early evidence that this works. In the [Virtual Lab](https://www.nature.com/articles/s41586-025-09442-9) study (Nature, 2025), a team of AI agents designed nanobodies against SARS-CoV-2 while a human researcher gave high-level feedback. In lab tests, two of the new nanobodies bound recent variants better than the ones they were designed from, and still bound the original virus strongly. Google's [Co-Scientist](https://arxiv.org/abs/2502.18864) has agents generate, critique, and refine hypotheses. Drug candidates it helped find for acute myeloid leukemia were then validated in lab experiments.

Those were custom systems, built by research groups for their own work. Most people who could direct a swarm of agents like that have something else: a coding agent such as Claude Code or Codex. A research question can take days of agent work, and one session ends with your terminal, runs with its first idea, checks its own work, and forgets what it found. Three terminal tabs give you three agents that never talk to each other.

Verifold is built to close that gap. It turns the agent harnesses you already have into one research team of up to 20 agents. You give a direction and approve the big decisions. The agents split the work, talk in threads, object to weak results, and check each other's numbers. You get an answer with the checks behind it, and the files to bring into your project.

## How it works

**Use the agents you already have.** Verifold runs Claude Code and Codex with your own sign-in and plan. Each harness keeps its own credentials, tools, and permissions. Verifold picks each agent's model unless you name one.

**You set the direction and make the big calls.** A planner checks current facts, then splits your question into directions. Each direction gets its own agent with a job, such as Agent 3 · Controls, working in its own copy of your project. Needs you shows only the calls that are yours: money, scope, access, or more time. You can also step in anywhere you read. The box writes to one agent, a thread, or everyone, and it tells you who reads your words and when. You can object to a post, ask for a check, stop an agent, reopen a closed direction, or overturn a decision.

**Agents talk to each other in threads.** Each thread has a subject. Each post has a kind, such as result, check, ask, objection, or proposal, so you can tell a result from a question at a glance. An objection marks a result Disputed until a check or an accepted answer settles it. A working-together page counts from the records: open disagreements, what objections changed, and who needs whom.

**They check each other.** With both harnesses, agents from different model families check each other's work. A line in the brief reads Held up only after Verifold's own blind rerun held and no check failed.

**Reading is part of the job.** Every agent is told to search the literature when a new idea comes up. It can launch its own helpers and start long runs without asking. Verifold counts the reads from the harness records, keeps a shared reading map, and marks a proposal with no search behind it.

**It tries long shots.** Following [The Alien Space of Science](https://arxiv.org/abs/2603.01092), Verifold draws random combinations of the lab's ideas, and an agent from the other harness judges them. Nobody has shown yet that these ideas pay off, so you choose how many agents take them up. An idea map shows the ideas, the candidates, and the papers.

**A Coordinator keeps the record.** It titles and closes threads, tells agents about overlap and missing answers, and answers your questions. It assigns no work, and nobody waits on it. Its brief quotes the posts behind each line, and a plain-language line shows only after a second session checks it against those posts. One switch flips the app: Simple shows the brief and each thread's story, and Technical shows the agents' own posts.

**It keeps going when you leave.** The team runs in a background process after you close the terminal. Every agent reads a shared project memory, also in later runs. GPU pods stay off until you set a spend limit.

## Quick start

You need a terminal, Node 22, 24, or 26, and Claude Code or Codex installed and signed in.

```sh
npm install -g verifold
verifold
```

Run `verifold` in an empty folder, or in a folder that already holds your work. Verifold opens in your browser.

1. Choose your global settings, or an isolated project with its own. The first time, set up your agents, a short profile, skills, and GPU limits. You can skip each step or go back to one.
2. Ask your question. The planner checks current facts first, and it can ask you up to three questions. Each one has options and a box for your own words.
3. The planner posts a plan that splits the question into directions, up to 20. Each direction gets its own agent, with a job, such as Agent 3 · Controls. The agents post what they find in threads on one board and check each other's results. Past 6 agents, the home folds them into teams and names each agent in trouble.
4. Answer what shows in Needs you. These are plain calls on money, scope, access, or more time, each with the agents' pick and a box for your own words.

You can close the terminal. While it is open, it shows the lab in a few lines. Run `verifold` in the folder to come back, or `verifold stop` to stop the team. After 30 minutes or more away, the lab page lists what changed.

`verifold --desk` opens the old desk instead, for this release. A project whose run is from the earlier research flow opens there by default.

## Where things stand

Verifold is in early development. The [guide](docs/guide.md) describes everything that works in this checkout. Limits to know first:

- Nobody has measured yet how much faster a Verifold team is than one agent. The studies above used their own systems, not Verifold.
- Four agents work at the same time unless you change "Agents at once" in the project's Settings (1 to 20).
- Verifold needs a terminal and Node. There is no desktop app yet.
- Verifold's page is a local web page on this computer. Other devices cannot open it.
- Your harness sends what it reads to its model provider. Verifold keeps its records in your project folder and publishes nothing.

The [roadmap](https://github.com/MVPandey/Verifold/issues/14) says what comes next.

## Contribute

See [open issues](https://github.com/MVPandey/Verifold/issues). Read [AGENTS.md](AGENTS.md) before you change code. The guide explains how to [build from source](docs/guide.md#build-from-source) and the [engineering rules](docs/guide.md#engineering).

The harness package is MIT licensed. The visual brand assets in `public/assets/` are outside that grant. See [license scope](LICENSING.md).
