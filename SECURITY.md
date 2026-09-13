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

Optional personalization can import a selected memory file (128 KB maximum), sample a selected local chat source, or ask the harness to inspect that source. Consent precedes source access. Drafts are removed after review; only accepted Markdown is reused. The harness may retain its own session records. Verifold does not change harness permissions. Imported text is untrusted evidence, not authorization.

Normal initialization sends the research topic, follow-up answers, and saved background to the selected harness to draft a research brief. Interactive users review the brief before project creation; explicit noninteractive autonomous initialization accepts an automatically drafted brief. The interview is bounded to six turns and one explicitly requested retry per failed turn. Interactive failures offer a local draft without another model call. A separate optional reusable-profile interview in setup-only mode requests confirmation before its first model call and before saving reusable memory. Neither interview scans accounts or conversation history.

Reusable preferences and approved `USER.md` live in `~/.verifold/agency` or an explicit `--agency-dir`. Files are created with private permissions and an ignore rule. Saved Markdown informs each new project’s reviewed research brief. Deleting the shared file prevents future imports but does not erase existing project snapshots or host/provider records.

Research attempts remain under the project's ignored `.verifold/` directory; the initial brief and project guide live in ignored `.verifold.md`. Project guide creation is exclusive, and initialization rejects conflicting files and direct scaffold symlinks. The named research folders preserve existing contents and are not automatically ignored; review their contents before publishing. They are not included in the published package. Processes running as the same user can still access local project data.

## Release checks

`make validate` checks formatting, lint, strict types, tests, builds, and a packed CLI installed in an isolated consumer. The package test enforces the distribution file boundary.

`npm run audit:security` checks dependency advisories and available registry signatures and attestations. It requires network access. It runs before publication.

GitHub publishing uses a designated workflow and short-lived OIDC credentials. Release checks reduce risk but do not prove that software or dependencies are free from vulnerabilities.

Chat-folder import requires consent before scanning or reading the selected path. It scans at most 200 entries and reads at most ten files, 256 KB per file and 512 KB total. Native JSONL imports keep recognized user text; they exclude model responses and tool results. Ordinary text and JSON exports may include private code or third-party material. Review the selected scope before allowing provider processing. No browser account or cloud chat API is accessed.

Harness-directed profile setup asks the harness to read only the selected local source and choose relevant history according to the task. It reports the coverage of its review. This scope is a prompt instruction, not a filesystem sandbox. The prompt excludes other history roots, cloud accounts, web search, edits, and credentials. The user reviews the full draft before reuse.

Existing-project investigation requires consent before file contents are read. It supplies selected top-level documentation and manifests to the harness. The request permits project file reads, web search, and native agents, and prohibits edits, installations, downloads, and experiments. The harness retains its normal configuration and permissions. The user reviews the draft before project-local adoption; it does not update personal memory.

Background harness sessions cannot display interactive approval prompts. Verifold reports tool activity and Claude permission denials without copying raw tool inputs or results into terminal diagnostics. Native session recovery remains with the harness. Verifold does not automatically grant tool permissions.
