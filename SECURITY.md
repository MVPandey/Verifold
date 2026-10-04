# Security

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/MVPandey/Verifold/security/advisories/new) for a suspected security issue. Do not put credentials or private research in a public issue.

Include the package version, operating system, reproduction steps, and expected impact. Use a disposable project for reproduction.

## Trust boundary

Verifold starts the selected `claude` or `codex` executable from the user's PATH. Use a trusted installation and a project that you trust.

The selected harness owns models, tool permissions, configured extensions, and its session data. Its normal startup can load project or user configuration. Verifold does not sandbox the harness or override its permission policy.

Workers that the project owner starts, including task sessions and their terminals, load no MCP server from the user's configuration. Claude Code workers start with `--strict-mcp-config`, which also removes plugin MCP servers and claude.ai connectors. Plugin skills and hooks still load. Codex workers start each thread with plugins, connected apps, and each configured MCP server turned off. If Codex does not report its configuration, the worker stops. Research, setup, and harness use outside Verifold keep the user's configuration. A new conversation that the person starts inside a Codex terminal is outside this rule.

Task workers reach Verifold's own tools only through the harness process that Verifold started, so the pipe identifies the sending task and attempt. No credential for these tools is on disk. Verifold checks each call before it records anything: an attempt that is no longer running changes nothing, a worker can message only linked tasks, the coordinator, or the person, and it can object only to a file version that its task received. Messages reach a worker as information in its next turn. They cannot change its writable paths, permissions, or limits.

The coordinator acts only through Verifold tools. Claude Code runs it with no built-in tools, and Codex with a read-only sandbox and no approvals. Each tool calls the task operation that the person uses, with the same checks, and none can widen a task's paths beyond the project, change a harness permission, or raise a limit. It can create at most 12 tasks, and its wakeups are limited to 12 an hour. Its reasons and summaries are model text, labeled as its reading.

Model providers and research tools can receive project prompts according to the harness configuration. Local project storage does not imply offline execution.

Source links and model reports are untrusted data. Valid JSON and a successful subprocess do not establish scientific correctness or source authenticity.

## Package contents

The npm package contains compiled CLI code and its license and usage documents. Its one runtime dependency is `marked`, which renders harness Markdown for the desk. The optional dependency `@lydell/node-pty` runs worker terminals. It ships prebuilt binaries and has no install script, and without it terminals are unavailable. The desk page loads bundled copies of DOMPurify and xterm.js. The package has no install lifecycle scripts.

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

Background harness sessions cannot display interactive approval prompts. Verifold reports tool activity and Claude permission denials without copying raw tool inputs or results into terminal diagnostics. The desk transcript is different: Verifold saves full harness messages, tool inputs, and tool results in private files under `.verifold/`, and serves them only to the authenticated desk page. Each field is limited to 64 KB and each transcript to 16 MB. Terminal control characters and text direction overrides are removed.

Task sessions run in Strict mode in a task folder. Their shell commands cannot reach the network unless the task names domains, with a reason. Claude Code's sandbox allows exactly those domains. Codex cannot limit its network to domains, so a Codex task with domains can reach any host, and any worker with network access could send project data out. Claude Code's sandbox and permission rules, or Codex's `workspace-write` sandbox, limit writes to that folder. These limits come from the harness. Verifold configures them but does not enforce them itself, and it does not call a prompt or a folder a sandbox. Reads are not limited, temporary folders stay writable, and a Claude Code sandbox setting in managed settings can change the result. Accept copies only regular files inside the writable paths, and only when the target in the project still matches its start content. Verifold commits task versions under its own name, without hooks or signing. In a Git repository, these commits are on `verifold/*` branches. Native session recovery remains with the harness. Verifold does not automatically grant tool permissions.

Worker terminals run the harness's own TUI in a PTY that the project owner starts. Terminal output is private and untrusted. xterm.js renders it as terminal text, never as HTML. One browser view holds input at a time; another view must take it explicitly, and the owner refuses input from any other view. Only the terminal page allows inline styles, which xterm.js needs, and only the desk itself can frame it. Scripts stay limited to the desk's own files. Codex workers listen on a Unix socket in a private temporary folder, which other accounts cannot open; processes under the same account can. A watchdog stops Codex when its owner process ends. Verifold removes the session variables of a parent Claude Code from harness environments.
