---
name: node-typescript
description: Production engineering standards for Node.js and TypeScript services, libraries, and CLIs. Use when writing, refactoring, or reviewing server-side JavaScript/TypeScript, designing async APIs, packaging npm/npx CLIs, integrating with host tools, or configuring tests and commit validation.
metadata:
  version: "1.1"
---

# Node.js and TypeScript Engineering

MUST means required for new or modified code; SHOULD means the default unless repository constraints justify another approach. Apply standards to the task's scope; do not rewrite unrelated code.

## Start with the repository

Inspect local instructions, package.json, lockfile, runtime pins, tsconfig, lint/format configuration, tests, hooks, and CI before editing. Preserve established framework, module system, package manager, and coverage requirements. Surface conflicting requirements; do not silently weaken checks or upgrade runtimes.

For a new project, use a supported Node LTS, TypeScript strict mode, ESM, npm with a committed package-lock.json, and src/ plus tests/. Verify current compatibility before installing tools. Node 24 is the LTS baseline researched on 2026-09-07; this is a dated default, not a permanent version rule. Match @types/node to the target runtime major. Framework conventions can own the directory layout.

Prefer built-in Node APIs: node:test, node:assert/strict, node:fs/promises, node:stream/promises, fetch, AbortController, URL, node:crypto, and node:worker_threads. Node has no built-in linter, formatter, or static TypeScript checker. Use ESLint + typescript-eslint, Prettier, and the official typescript package's tsc. No Rust tooling is required. Do not add a second tool stack to an established project.

## Engineering contract

- Keep domain logic independent of HTTP, databases, environment variables, and framework objects. Inject narrow dependency interfaces; assemble real resources at the application entrypoint.
- Keep handlers thin: decode and validate input, authorize, invoke a use case, map the result. Services own orchestration and transaction boundaries; adapters own I/O details. Add layers when they isolate a real responsibility, not for every function.
- Use explicit parameter types and return types for exported functions and architectural boundaries. Allow inference for local variables and contextually typed callbacks. Treat untrusted values as unknown until runtime validation succeeds. Never use assertions as validation.
- Prefer immutable domain values and readonly collection interfaces. readonly and Object.freeze are shallow; neither guarantees deep immutability. Copy mutable inputs when retaining them and avoid exposing live internal collections. Keep intentional state explicit and lifecycle-owned.
- Await or return every promise; intentional background work needs an owner, rejection handling, and shutdown behavior. Bound concurrency, queues, retries, and I/O time. Propagate cancellation and release resources in finally.
- Libraries return values or throw typed errors; services own log configuration and boundary logging. Optional injected diagnostic callbacks are acceptable when explicitly part of a library contract. Preserve causes, redact sensitive data, and do not log and rethrow at every layer.
- Parse configuration once at startup and inject validated settings. Avoid I/O, listeners, mutable singletons, and process exits at import time. Bootstrap and CLI boundaries own process lifecycle.
- Validate public behavior with meaningful tests: edge cases, errors, authorization, cancellation, and integration contracts. Keep network services out of unit tests; use isolated fixtures and clean up resources.
- Follow the repository formatter. Defaults: two spaces, single quotes, semicolons, camelCase functions/variables, PascalCase types/classes, descriptive filenames. Document public contracts, side effects, units, errors, and cancellation with concise JSDoc; explain decisions rather than narrating code.

Read [architecture and types](references/architecture-types.md) when designing modules, contracts, or configuration. Read [async and security](references/async-security.md) when implementing I/O or production request handling.

Read [CLI packaging and host integration](references/cli-packaging.md) for executable entrypoints, package layout, npm/npx delivery, machine-readable CLI behavior, and adapters for existing agent harnesses. Keep host-owned lifecycle, permissions, and sessions with the host unless the feature explicitly needs otherwise.

## Required validation workflow

Before committing task changes, run the repository's complete validation command after the final edit and require a zero exit status. For a new setup, expose npm run validate and optionally make validate as an alias. Validation MUST include formatting checks, linting, type checking, and unit tests, including test-file types. Include build/integration checks when the repository requires them. For distributable CLIs, also build, pack, install the tarball into an isolated consumer, and test the installed executable; follow the CLI packaging reference.

Checks MUST NOT auto-fix code, silently skip missing commands/tests, or weaken thresholds. Use separate fix commands, review changes, and rerun validation. Never bypass hooks or disable checks to make a commit succeed. If validation cannot run or fails, report the actual blocker and do not claim the changes passed.

Use the [validation reference](references/validation.md) and [runnable template](assets/validation/) when setting up or repairing validation. The template runs all four checks concurrently with Node APIs, waits for every result, and fails if any check fails. A plain sequential npm script is also valid; a single reliable gate matters more than concurrency.

Use the same command in local hooks and CI. Local hooks can be bypassed; required GitHub status checks enforce the merge gate. Creating this skill does not activate hooks or modify GitHub settings in any application repository.

## Review before completion

Check responsibility boundaries, type/runtime agreement, resource ownership, cancellation, bounded work, error causes, authorization, sensitive logging, and meaningful tests. Report the validation command and outcome, plus material limitations. Review the build output for deployable services and the package exports/declarations for libraries.

Official documentation links are in [sources](references/sources.md).
