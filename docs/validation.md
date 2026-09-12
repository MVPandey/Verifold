# Validation scope

Updated 2026-09-11. This document describes required checks and their limits.

## Repository gate

`make validate` checks for tracked private files, then runs formatting, type-aware ESLint, strict TypeScript, tests, CLI and website builds, and the packed CLI consumer check.

`npm run check:private` rejects agent research and coordination records in the Git index, including force-staged ignored files. Keep these records under `.local/agents/`. Ordinary public documentation remains in `docs/`.

The consumer check installs the packed executable in a temporary project. It checks the package boundary independently of source imports.

Pre-commit and pre-push run this gate. Enable them in each clone with `git config --local core.hooksPath .githooks`.

Pre-commit rejects unstaged and untracked files before validation. This ensures that validation checks the staged snapshot.
Pre-push requires a clean working tree and the checked-out HEAD. It validates the committed code before the push.
Preserve unrelated files separately when necessary. Do not stage them merely to satisfy a hook.
Restore any temporarily preserved files after the Git operation.

Hook tests use temporary Git repositories and a small fixture validation command.
They check accepted snapshots, rejected local changes, rejected revisions, and validation failures without network access.
The main gate still runs the real build and package checks.

Code simplicity and writing quality require review under [AGENTS.md](../AGENTS.md) and the repository skills.
Passing automated checks does not establish that code is simple or that prose is clear.

Routine tests use controlled fixtures. They must not require live model credentials or network access.

## Research behavior

Initialization first runs a bounded adaptive interview (or a single automated brief request), saves the accepted brief and scaffold, and then runs two research stages:

1. Propose a research scope and personas.
2. Research the approved plan and return sources and directions.

Guided mode pauses between these stages. Feedback revises the plan or directions through a saved host session when available.

Required behavioral checks cover the exact first question, adaptive answers and session reuse, revision without a session ID, selected-directory propagation, scaffold preservation and collisions, concurrent creation, preparation rollback under lock, approval, feedback, explicit selection, invalid source mappings, malformed responses, and state preservation after failure. The packed consumer exercises onboarding through a subprocess harness fixture and verifies the scaffold and sourced research directions. These fixtures validate integration behavior, not live authentication, model quality, or scientific correctness.

Adapter checks cover process errors, host-reported failure, bounded output, cancellation, deadlines, and session references.

A host response that reports subagents is evidence of the host's report. Verifold does not independently verify native delegation.

## Optional literature requests

Initial research does not require PDFs. After selection, `literature` prints a retention request. `literature --memory` also requests Markdown memory and file mappings.

These commands do not fetch files, run the host, create memory, or verify official citation exports. Request-shape tests cannot establish those capabilities.

## Recovery and private files

Research attempts store briefs, responses, reports, or failure details under `.verifold/runs/<attempt-id>/`. State and attempt files remain private project artifacts.

Normal failures preserve the checkpoint and release the research lock. SIGKILL can leave `.verifold/research.lock`.

Before removing a stale lock, inspect the project and confirm that no research process remains active. Resume the saved phase explicitly.

A successful process exit does not establish valid output. Contract checks must pass before the phase advances.

## Prior validation

Earlier scaffold and request-file checks exercised profile storage, explicit selection, planning handoff, and local HTML output. They did not test live research adapters.

The current website does not host the questionnaire. Earlier browser onboarding checks do not establish the current CLI behavior.

No validation described here establishes production readiness, scientific correctness, Automative execution, cloud synchronization, or publication support.
