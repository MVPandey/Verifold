---
name: node-typescript
description: Apply Verifold's Node.js and TypeScript standards when changing JavaScript, TypeScript, CLI behavior, subprocess adapters, or validation tooling.
metadata:
  source: Adapted from the installed node-typescript skill v1.1
---

# Node.js and TypeScript

Use the repository's existing runtime, dependencies, module system, and formatter.
Read package.json, the lockfile, TypeScript settings, and affected tests before changing them.
Do not copy a new project template into this repository.

## Boundaries and types

- Keep research rules separate from terminal, filesystem, and subprocess operations.
- Keep command handlers responsible for input validation and coordination.
- Give external operations narrow interfaces when the code needs substitution or isolated tests.
- Use explicit parameter and return types at exported boundaries.
- Treat parsed JSON, model output, and configuration as unknown until validation succeeds.
- Preserve strict TypeScript settings. Do not suppress errors to make a check pass.
- Preserve the current import convention and emitted JavaScript behavior.
- Keep mutable state with its owner. Copy caller data when retaining it.

## Processes and storage

- Await promises. Give background work an owner and a shutdown path.
- Bound process output, input, execution time, retries, and concurrency.
- Propagate cancellation. Release files, locks, listeners, and owned processes in finally blocks.
- Use argument arrays with spawn or execFile. Disable shell interpretation for user input.
- Validate file paths at the intended access boundary. Account for symbolic links and concurrent writes.
- Validate data before committing it. Preserve the previous checkpoint when an operation fails.
- Retain error causes without exposing credentials, raw private prompts, or source text in diagnostics.
- Prefer Node built-ins. Add a dependency only when its concrete benefit justifies its cost.

## Harness integration

- Keep models, credentials, tools, and permissions with the selected harness.
- Verify the current official host contract before changing adapter arguments or event parsing.
- Report observed process state separately from delegation reported by a model.
- Reserve stdout for command results. Send prompts and diagnostics to stderr.
- Keep noninteractive commands bounded and machine-readable.
- Preserve resume behavior only when the selected host supports it.

## Verification

Test public behavior, invalid inputs, cancellation, and failure recovery at the affected boundary.
Use isolated fixtures for routine tests. Do not require a live login or network service.
Avoid tests that only repeat the implementation or match internal wording.
Keep tests in the repository's type checks.

Run npm run validate after the final change.
The gate includes formatting, lint, types, tests, builds, and the packed CLI consumer check.
Do not weaken checks, suppress failures, or bypass Git hooks.
Report what passed and what remains unverified.

For code size and extension decisions, apply the repository's ponytail skill.
