# One validation gate

## Adopt the template

The assets/validation directory is a runnable example, not a command to overwrite an existing repository. Merge scripts, configuration, and ignore entries deliberately. Preserve current tests, hooks, package manager, framework tsconfig, CI, and coverage thresholds. Replace the small port-parser example with the application's own behavior tests.

The fixture targets Node 22.15.0 because that was available for local verification. For a new production app, select the latest patched supported LTS (Node 24 at research time), align engines, runtime pins, CI, and @types/node, and test that combination. Fixture dependency ranges describe a compatible stack, not claims about latest releases. Resolve dependencies with npm install, review and commit package-lock.json, then use npm ci in CI. No automatic dependency install occurs in validation.

The scripts expose:

| Command | Purpose |
| --- | --- |
| npm run validate | Run all four checks concurrently; wait for all and fail on any error |
| make validate | Optional identical entrypoint for Python-style muscle memory |
| npm run format:check | Prettier check without edits |
| npm run lint | ESLint with type-aware promise rules; warnings fail |
| npm run typecheck | tsc --noEmit on application and test code |
| npm test | Clean isolated test output, compile, then run node:test on emitted JS |
| npm run format / npm run lint:fix | Explicit repair commands, outside the gate |

The test compiler writes only .test-build; formatting/lint/type checking ignore it. The Node runner discovers compiled test files explicitly and rejects an empty list; Node 22 can otherwise accept an unmatched test glob with zero tests. Discovery uses filesystem APIs rather than shell glob expansion. Tests use node:assert/strict. No Jest, Vitest, tsx, hook manager, or parallel runner dependency is required for this baseline.

Use existing Jest/Vitest or framework runners when needed. For native TypeScript execution, verify runtime support and still run tsc. For monorepos, aggregate required workspace checks at the root; do not use --if-present to quietly skip required scripts. Include relevant dependent packages. A bundler/transpiler build alone is not a type check.

## Git hooks and CI

If a hook manager or core.hooksPath already exists, integrate the gate there. Inspect it first. For a repository with no hooks, copy the template's .githooks/pre-commit, make it executable, and configure locally:

```sh
git config --local core.hooksPath .githooks
```

This is per clone. Do not silently set global Git configuration or add a prepare script that rewires consumers' hooks. Windows Git hooks run through Git's shell; the npm validation runner itself uses portable Node child-process APIs. Make is optional.

The included hook rejects unstaged tracked changes and untracked non-ignored files before validation. This intentionally prevents partial staging from validating different source than the index. It does not stash, stage, or discard files. Repositories that need partial commits should use an established staged-snapshot workflow in an isolated checkout and install dependencies from that snapshot's lockfile. Do not merely remove this guard and claim that the staged snapshot was validated. Concurrent external edits during commit are outside the hook's guarantee; CI validates committed content.

Git runs pre-commit before a local commit, not before a GitHub push. The hook exits nonzero on failure. The same command in GitHub Actions runs on pushes, pull requests, and merge queues. The example uses a least-privilege token, a timeout, and reproducible install. Follow the repository's policy for pinning action commits; review/update action versions when adopting it.

Make the validate job a required status check using the repository's GitHub ruleset/branch protection settings when that change is authorized. Do not treat a workflow file alone as enforced branch protection. Local hooks can be skipped; server-side merge rules are the durable control. This template does not prevent every push to an arbitrary branch.

## Coverage and behavioral checks

Node provides coverage options, but coverage support/flags vary by version and can remain experimental. Verify the target's documentation before enabling line/branch/function thresholds. Preserve existing gates; do not invent a 95% requirement for every project. Include uncovered source modules and test meaningful behavior rather than mock wiring or trivial assertions. Coverage does not replace integration or security tests.

For behavior changes, test success, error, and boundary conditions. For async work test cancellation/deadline cleanup and bounded concurrency where they matter. Test real adapter contracts with disposable resources separately. Keep tests deterministic: inject clocks/randomness, avoid real sleeps/external network, restore mocks, and always close handles.

When changing the gate itself, verify a passing run and deliberately introduce one formatting error, lint-only error, type error, and failing assertion in an isolated fixture. Each must produce a nonzero gate exit. Check no-test behavior and hook refusal as well. Do not weaken checks or create meaningless tests to force green status.

## Template verification

Verified locally with Node 22.15.0 and npm 10.9.2: the complete gate passes; independent formatting, floating-promise lint, type, and assertion failures each fail the gate while all four checks finish; removing the test suite fails; the hook accepts the clean staged fixture and rejects unstaged, untracked, and staged lint-failing cases. The lockfile records the tested tool versions. GitHub-hosted execution and branch protection were not activated as part of skill creation.

## CLI packages

For npm/npx distribution, extend the four-check fixture with a test:package check following [CLI packaging and host integration](cli-packaging.md). Run production build, pack, isolated consumer install, and executable tests in dependency order. The generic fixture does not yet implement this project-specific check.
