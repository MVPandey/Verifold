# Security

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/MVPandey/Verifold/security/advisories/new) for a suspected security issue. Do not put credentials or private research in a public issue.

Include the package version, operating system, reproduction steps, and expected impact. Use a disposable project for reproduction.

## Trust boundary

Verifold starts the selected `claude` or `codex` executable from the user's PATH. Use a trusted installation and a project that you trust.

The selected harness owns models, tool permissions, configured extensions, and its session data. Its normal startup can load project or user configuration. Verifold does not sandbox the harness or override its permission policy.

Model providers and research tools can receive project prompts according to the harness configuration. Local project storage does not imply offline execution.

Source links and model reports are untrusted data. Valid JSON and a successful subprocess do not establish scientific correctness or source authenticity.

## Package contents

The npm package contains compiled CLI code and its license and usage documents. It has no runtime dependencies and no install lifecycle scripts.

Installing Verifold does not install an agent harness, change its settings, or configure Git hooks. The user starts research explicitly through the CLI.

Optional personalization reads one explicitly selected plain-text memory or conversation export only after consent (128 KB maximum). The text is sent to the selected harness for synthesis. Drafts are removed after review; only accepted Markdown is reused. The harness may retain its own session records. Verifold does not scan native history stores or change harness permissions. Imported text is untrusted evidence, not authorization.

Reusable preferences and approved `USER.md` live in `~/.verifold/agency` or an explicit `--agency-dir`. Files are created with private permissions and an ignore rule. The editable Markdown is copied into each new project. Deleting the shared file prevents future imports but does not erase existing project snapshots or host/provider records.

Research records remain under the project's ignored `.verifold/` directory. They are not included in the published package. Processes running as the same user can still access local project data.

## Release checks

`make validate` checks formatting, lint, strict types, tests, builds, and a packed CLI installed in an isolated consumer. The package test enforces the distribution file boundary.

`npm run audit:security` checks dependency advisories and available registry signatures and attestations. It requires network access. It runs before publication.

GitHub publishing uses a designated workflow and short-lived OIDC credentials. Release checks reduce risk but do not prove that software or dependencies are free from vulnerabilities.
