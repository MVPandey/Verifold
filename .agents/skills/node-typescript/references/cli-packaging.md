# CLI packages and host integrations

Use this reference for Node CLIs delivered through npm/npx, including tools invoked by an existing agent harness. These are reusable packaging and integration standards; do not assume the package owns an agent loop, model provider, permissions system, or session store.

## Separate entrypoints from behavior

A useful starting layout is:

```text
src/
  cli.ts                 Executable: parse arguments, wire dependencies, set exit status
  index.ts               Public library exports, only if an importable API is needed
  commands/              Command orchestration
  core/                  Framework-independent behavior and contracts
  adapters/              Filesystem, subprocess, and host-specific integrations
  config.ts              Configuration loading and validation
tests/                  Unit and integration tests
scripts/                Build and package-verification helpers
dist/                   Generated JavaScript and optional declarations
```

Keep only directories that represent actual responsibilities. Follow existing repository naming and layout conventions. cli.ts should call testable functions that accept argv, configuration, I/O streams, and dependencies; core modules must not read process.argv or call process.exit. Importing a library entrypoint must not start the CLI, install signal handlers, connect to services, or mutate host state.

Use node:util.parseArgs for simple argument parsing. Adopt an established parser when subcommands, completion, or complex help warrant it. Define stable flags, help/version behavior, unknown-option handling, and exit codes. Help and version should work without credentials or a running harness.

## Package contract

- Map package.json bin to emitted JavaScript. Begin the executable source with #!/usr/bin/env node, preserve that line in output, and verify executable delivery on supported platforms.
- Ship a reviewed files allowlist, appropriate metadata/license, and an engines range matching tested runtimes. Verify that bin, exports, and types targets exist in the actual tarball. Provide declarations if exposing a TypeScript-consumable library API. A CLI-only package need not invent library exports.
- Compile before packing. Consumers should not need TypeScript, repository source, a global CLI install, or a devDependency to execute the package. Runtime imports must resolve from declared dependencies; build tools belong in devDependencies. Peer dependencies are appropriate for an in-process host SDK only when the compatibility contract requires the host to provide it.
- Keep the generic validation fixture private. Remove private: true only from a package intended for publication, with deliberate registry/access configuration. Do not run npm publish as part of validate, test, pack verification, or installation.
- Avoid install/postinstall/prepare scripts that configure a user's harness, alter Git hooks, download optional tools, or require a source build. Perform integration setup through an explicit command with scoped, reviewable changes.
- Resolve bundled assets relative to import.meta.url; resolve user paths against a documented workspace/cwd. Never write state into the npx cache or assume the process starts in the package directory.
- For automated host configuration, document an explicit package version and executable name. npm exec --package=<package>@<version> -- <command> avoids ambiguity when bin names differ. Explain initial package fetching and offline requirements; npx is distribution, not a sandbox or an update policy.

The package metadata and executable behavior above follow [npm package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/) and [npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec/). Recheck supported npm/Node versions when adopting configuration.

## Command-line behavior

Reserve stdout for results or protocol messages and stderr for diagnostics. Offer structured output when machine consumers need it; document schemas and compatibility. Disable prompts, progress animation, and ANSI decoration in protocol/noninteractive modes. If required information is missing without a TTY, fail promptly with an actionable error rather than hanging. Never print banners or logs onto a host protocol's stdout channel.

Use an explicit configuration precedence, for example flags over environment over project config over user config over defaults. Validate once, document paths and units, redact secrets, and treat executable project configuration as code with its own trust implications. Prefer data configuration where execution is unnecessary.

Handle SIGINT/SIGTERM at the standalone executable boundary. Propagate cancellation to owned operations, close resources, and produce documented exit statuses. In-process plugins must return control and errors to the host rather than exit its process or replace its global handlers. Handle broken output pipes according to the CLI contract; do not expose an unhandled stack trace during normal pipeline use.

Use path/URL APIs and argument arrays rather than shell interpolation. Verify Windows behavior if supported, especially npm command shims, signal handling, quoting, and paths containing spaces. Bound subprocess output and input sizes; preserve meaningful failures and avoid orphaned child processes.

## Plug into an existing harness

First establish the host's supported extension mechanism: subprocess CLI, hook, in-process plugin, or documented protocol. Use that contract and check the host's current documentation before implementing an adapter. Do not assume MCP, stdio JSON, a specific SDK, or access to internal state merely because the host is an agent harness.

Keep host-specific APIs and serialization in adapters. Version exchanged data, validate messages at runtime, and test supported host versions/capabilities. Follow the chosen protocol's framing, correlation, error, cancellation, and backpressure rules; do not invent a second envelope over an existing standard.

Document ownership: who launches/stops the integration, supplies credentials and workspace paths, grants permissions, owns sessions, and handles retries. Respect host authorization and cancellation; tool output cannot expand permissions. Create only resources the integration owns and release them on disconnect. Do not duplicate the host's model routing, session persistence, or orchestration unless the requested feature actually requires that responsibility.

When registering an integration, preserve unrelated host configuration. Make setup repeatable, show the intended changes, and provide removal that affects only entries this integration owns. Never scan unrelated harness credentials or silently take over the default agent. Tests should use a fake host or disposable configuration, not the person's active harness.

## Validation for a distributable CLI

Extend the repository's single validation gate with a package check when building a distributable CLI. Keep the baseline formatting, lint, type, and unit checks. The package check must run these dependent steps in order:

1. Build production JavaScript into clean, owned output; fail on compilation errors.
2. Create a real tarball with npm pack --json into an isolated output directory. Inspect its file list for missing assets and unintended secrets, fixtures, or build artifacts. npm pack --dry-run alone does not prove the package can execute.
3. Install that exact tarball in a fresh temporary consumer outside the source checkout, without the package's development dependencies. Resolve runtime dependencies from the lock/cache or an explicitly allowed registry. Keep verification offline when dependencies are already cached; report unavailable dependencies as a blocker.
4. Execute the installed bin through npm's executable resolution. Test help/version, bad arguments, a representative successful command, and failure status. Also test package-name imports and declarations from a consumer if those are public interfaces. Do not rely only on node dist/cli.js or npm link.
5. For a host integration, run a representative host interaction using the packed executable or imported package and a fake host. Assert clean protocol output, errors, cancellation/disconnect cleanup, and preservation of unrelated host state.
6. Clean up only verification-owned files/resources, including on failure. Test supported runtime/platform combinations in CI.

Use a script such as test:package for this sequence. Add it to the validation runner's check list; it may run alongside independent checks only if build outputs do not race. Do not launch build and packaging independently in Promise.all. Avoid recursion: a prepack build must not call validate if validate calls npm pack. This reference adds requirements for CLI repositories; the generic assets/validation fixture remains a four-check example until adapted.

Packing is local artifact creation, not publication. See [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/) for tarball output options and lifecycle behavior.
