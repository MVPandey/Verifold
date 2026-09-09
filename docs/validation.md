# Scaffold validation

Verified locally on 2026-09-08 using the pinned Node 24.20.0 runtime inside npm scripts.

- `make validate`: passed formatting, type-aware ESLint, strict TypeScript (including test files), seven behavioral tests, and the Vite production build.
- Dependency audit after patching Vite and updating ESLint: zero reported vulnerabilities.
- Isolated temporary fixture: the full gate passed clean code and rejected a formatting error, unused-parameter lint error, invalid type assignment, failing assertion, and absent tests.
- Isolated hook fixtures: pre-commit passed a staged snapshot and refused untracked/unstaged changes; pre-push passed a clean committed fixture and refused local edits. Hook shell syntax checks passed. The parent repository has `core.hooksPath=.githooks`.
- Browser: profile creation, idea selection, duplicate-seed rejection, locked pilot record worked. The export action is implemented, but browser download-event verification timed out. Run layout checked at 390px width with no horizontal overflow; no browser error logs observed.
- Existing nested website repository remained unchanged.

These checks establish scaffold behavior, not production readiness of the planned autonomous services. No model, paper-ingestion, compute, authentication, multi-user persistence, or remote publication integration was exercised. CI has not run on GitHub because no local files have been pushed. No branch-protection rule was installed.

## CLI correction — 2026-09-09

The active website no longer creates browser-local profiles. CLI tests now cover terminal questionnaire prompts, private state, recommendation validation, explicit selection, refusal to overwrite initialized/selected work, and a task-specific math gate with no seed requirement. Package validation builds and packs the executable, installs it offline in an isolated consumer with a private temporary npm cache, and exercises help/version/errors and the host-request → selection → handoff → local-view flow. This verifies the subprocess/file boundary; it does not claim a native host plugin or Automative execution integration.
