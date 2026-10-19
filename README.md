<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/assets/verifold-horizontal-dark.webp" />
    <img src="public/assets/verifold-horizontal.webp" alt="Verifold" width="360" />
  </picture>
</p>

<p align="center"><strong>Run Claude Code and Codex as a research team.</strong></p>

<p align="center">
  <a href="https://github.com/MVPandey/Verifold/actions/workflows/validate.yml"><img src="https://github.com/MVPandey/Verifold/actions/workflows/validate.yml/badge.svg?branch=main" alt="Validation workflow status" /></a>
  <a href=".nvmrc"><img src="https://img.shields.io/badge/Node.js-22%20%7C%2024%20%7C%2026-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 22, 24, or 26" /></a>
  <a href="tsconfig.json"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&amp;logoColor=white" alt="Strict TypeScript" /></a>
  <a href="#where-things-stand"><img src="https://img.shields.io/badge/status-early%20development-7C3AED" alt="Early development" /></a>
</p>

# Verifold

A research question can take days of agent work. One Claude Code or Codex session ends with your terminal, runs with its first idea, checks its own work, and forgets what it found.

Verifold runs them as a research team:

- It keeps working in a background process after you close the terminal.
- Research compares directions from sources and recommends one.
- A coordinator splits that direction into tasks, each in its own copy of your project.
- Agents object to each other's work with evidence. With both harnesses, the second one does the independent half of a check.
- Every agent reads a shared project memory, also in later runs.

Three terminal tabs give you none of this.

You ask, then decide what the team brings to you. You get reviewed files, check results, and a proposed answer. Agents use your harness plan. GPU pods stay off until you set a spend limit.

## Quick start

You need a terminal, Node 22, 24, or 26, and Claude Code or Codex installed and signed in.

```sh
npm install -g verifold
verifold
```

Run `verifold` in an empty folder, or in a folder that already holds your work. Your browser opens the desk.

1. Type your question. Your harness asks up to three quick questions.
2. Accept the brief of about 120 words. Verifold creates the project.
3. Research finds sources and directions. The coordinator turns the recommended direction into tasks and starts them.
4. Answer what shows in Needs you, for example a question or a version to review.

You can close the terminal. Run `verifold` in the folder to come back, or `verifold stop` to stop the team.

## Where things stand

Verifold is in early development. The [guide](docs/guide.md) describes everything that works in this checkout. Limits to know first:

- At most two agents run tasks or sessions at the same time. Research and the coordinator do not count.
- Verifold needs a terminal and Node. There is no desktop app yet.
- The desk is a local web page on this computer. Other devices cannot open it.
- Your harness sends what it reads to its model provider. Verifold keeps its records in your project folder and publishes nothing.

The [roadmap](https://github.com/MVPandey/Verifold/issues/14) says what comes next.

## Contribute

See [open issues](https://github.com/MVPandey/Verifold/issues). Read [AGENTS.md](AGENTS.md) before you change code. The guide explains how to [build from source](docs/guide.md#build-from-source) and the [engineering rules](docs/guide.md#engineering).

The harness package is MIT licensed. The website and the visual brand assets are outside that grant. See [license scope](LICENSING.md).
