# Repository instructions

These instructions apply to the Verifold repository.
Follow more specific instructions for a nested project when they exist.
User instructions take precedence over repository guidelines.

## Purpose and boundaries

Verifold coordinates computational research through the user's existing coding harnesses.
It preserves questions, decisions, evidence, and deliverables across research tasks.
The selected harness owns its models, credentials, tools, and permissions.

Read the relevant implementation and tests before changing behavior.
Use README.md for current capabilities.
Public product documentation and GitHub issues can describe features that do not exist yet.
Do not present a plan, model report, or interface mockup as an executed capability.

## Required skills

Use the repository editions below so every contributor has the same baseline.
Read each applicable SKILL.md before the first relevant change.

| Work                                                                      | Required skill                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------------------- |
| JavaScript, TypeScript, CLI, storage, subprocesses, or validation tooling | [node-typescript](.agents/skills/node-typescript/SKILL.md) |
| Documentation, comments, prompts, errors, and technical explanations      | [asd-ste100](.agents/skills/asd-ste100/SKILL.md)           |
| Implementation and refactoring                                            | [ponytail](.agents/skills/ponytail/SKILL.md)               |
| Complexity review after correctness review                                | [ponytail-review](.agents/skills/ponytail-review/SKILL.md) |

These are versioned snapshots of the full operating skills, not shortened summaries or automatic mirrors of personal installations.
The English snapshot includes the installed `asd-ste100` v0.4.0 instructions, rule reference, examples, README, and MIT license.
The Node.js snapshot includes the installed `node-typescript` v1.1 instructions, engineering references, and complete validation template.
Its source reference retains official documentation links. Private research comparisons and the personal Python-skill review remain outside the repository snapshot.
Ponytail and ponytail-review are unmodified upstream skills from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/tree/356918eba965ee1eac64bd3a7f0dd02108350de5/skills).
Both are pinned to commit `356918eba965ee1eac64bd3a7f0dd02108350de5`, with the upstream MIT license included.
Preserve imported skill content when updating it. Do not replace full instructions with local summaries.
Keep repository-specific requirements in this file and document any necessary snapshot adjustments here.
The Node.js validation template is a reference package. It does not replace this repository's runtime pins, dependencies, validation gate, or hooks.
Update these files through ordinary review when the shared standard changes.
Do not require a contributor's home directory or a globally installed skill.

## Private agent work

Keep internal research, source comparisons, review reports, planning conversations, and agent coordination under `.local/agents/`.
Use its `research/`, `plans/`, and `coordination/` folders as needed. Git ignores this directory.
Do not commit these records, even with force-add. Do not place them under `docs/` or publish them in issue or PR bodies.
Public documentation and issues should contain the resulting product behavior, acceptance criteria, and necessary technical explanation only.
Never link public documentation to ignored private files. Repository skills and coding rules remain versioned in `.agents/skills/` and this file.
Before creating a report, give each agent its private output path. Check the staged file list before committing.

## Working rules

- Inspect git status before editing. Preserve unrelated work.
- Implement the requested behavior with the smallest complete change.
- Reuse existing operations across CLI and UI surfaces.
- Add abstractions only for a current responsibility, variant, or external dependency.
- Preserve runtime pins, strict types, module conventions, and public command contracts.
- Keep authoritative state changes serialized. Preserve evidence when an operation fails.
- Give background work an owner, limits, cancellation, and a recovery path.
- Keep private context scoped. Publishing a repository does not authorize publishing research records.
- Use controlled fixtures for routine tests. Live provider calls require task authorization.
- Keep the nested verifold-website repository separate unless the task includes it.

## Writing and review

Use direct technical English with concrete subjects and actions.
Preserve uncertainty, constraints, and exact command names.
Comments explain intent, invariants, ownership, or non-obvious behavior.
Remove comments that only restate code.

Before completion, inspect the diff for unnecessary structure and unsupported claims.
Remove unused scaffolding, duplicate state, generic wrappers, placeholder features, and speculative options added by the change.
Do not add marketing language, repeated summaries, or invented measurements.
Do not delete useful explanation merely to meet a word or line count.
The English skill governs technical prose. The ponytail skill governs code simplicity.
Preserve code syntax, command names, and protocol literals when applying the English rules.

## Validation and Git hooks

Run npm run validate after the final edit.
The gate checks formatting, lint, types, tests, builds, and the installed package.
Use separate commands to fix formatting or lint errors.
Never bypass hooks, skip required tests, or weaken checks to obtain a passing result.

The tracked hooks are .githooks/pre-commit and .githooks/pre-push.
Enable them in each clone with this explicit command:

```sh
git config --local core.hooksPath .githooks
```

Check the setting with git config --get core.hooksPath.
Installing the npm package must not install Git hooks.

Before a commit:

1. Review the complete intended diff.
2. Stage only files that belong to the change.
3. Resolve unstaged changes before invoking the hook.
4. Preserve unrelated untracked files outside the validation snapshot when necessary.
5. Let pre-commit run make validate on the snapshot that matches the index.

Before a push:

1. Ensure the working tree matches the committed code.
2. Push the checked-out HEAD.
3. Let pre-push run make validate again.
4. Use a branch and pull request when the remote protects main.

Never stage unrelated files to satisfy a hook.
Restore any temporarily preserved user files after the Git operation.
Do not commit or push unless the current task authorizes it.
Local hooks can be bypassed externally. Required CI checks remain the remote enforcement boundary.

## Completion report

State what changed and why.
Report the validation command and result.
Identify material limitations and checks that did not run.
Distinguish observed harness behavior from claims made by a model.
