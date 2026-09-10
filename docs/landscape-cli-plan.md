# Landscape CLI plan

Design status: implementation in progress, 2026-09-10.

The implementation now has two host stages: planning, then research with directions. Live harness compatibility checks remain pending.

This revision separates initial research from later literature collection. Initial research requires source links. PDF downloads are optional after idea selection.

## Product boundary

Verifold manages research projects through installed agent harnesses. The selected harness owns models, credentials, tools, permissions, and agent delegation.

Verifold stores the research question, constraints, decisions, phase, and artifact references. Its adapter starts or resumes a harness session.

The first milestone ends with research directions and user feedback. The user must select a direction explicitly. Selection does not start experiments.

| Responsibility                                            | Owner                               |
| --------------------------------------------------------- | ----------------------------------- |
| Questionnaire, local project state, and human checkpoints | Verifold                            |
| Start, resume, and cancel a harness process               | Verifold adapter                    |
| Search, reading, tool use, and native subagents           | Selected harness                    |
| Search plan, personas, research directions, and revisions | Selected harness with user feedback |
| Check returned structure and required references          | Verifold                            |
| Select an idea and authorize later work                   | User                                |

Research remains private by default. Autonomous research does not authorize publication, experiments, or changes to host permissions.

## Lessons from OpenResearch

The likely reference is [alphaXiv OpenResearch](https://github.com/alphaXiv/OpenResearch), also available at [openresearch.sh](https://openresearch.sh/).

Adopt its use of installed harnesses, local records, and explicit links between work and evidence.

Its [literature skill](https://raw.githubusercontent.com/alphaXiv/OpenResearch/main/agent-skills/orx-lit-review/SKILL.md) distinguishes discovery from paper reading. It also addresses duplicate results and failed searches.

Its [delegation skill](https://raw.githubusercontent.com/alphaXiv/OpenResearch/main/agent-skills/orx-agent-delegation/SKILL.md) requires complete task briefs and clear completion criteria.

Verifold's requested workflow uses research subagents. OpenResearch's restriction against delegated retrieval does not apply to this design.

Experiment trees, remote compute, publication, and platform UI work remain outside this milestone.

## Initial research flow

1. Run `verifold init` in the project directory.
2. Enter profile details, a research question or field, constraints, and the intended outcome.
3. Select Claude Code or Codex and a research autonomy mode.
4. The coordinator proposes a search plan and research personas.
5. In guided mode, the user reviews the plan and personas before research starts.
6. The harness delegates research tasks and returns findings with source links.
7. The coordinator proposes plausible research directions from those findings.
8. The user can give feedback and request a revision through the same coordinator session.
9. The user selects a direction explicitly when ready.

A broad field is a valid starting point. The coordinator can help narrow the question during planning.

### Minimal service stages

| Stage      | Input                                                 | Required result                                | Next action                          |
| ---------- | ----------------------------------------------------- | ---------------------------------------------- | ------------------------------------ |
| Plan       | Question, constraints, autonomy, and user preferences | Search plan and proposed personas              | Review in guided mode                |
| Research   | Accepted plan and persona briefs                      | Findings, source links, and delegation report  | Prepare directions                   |
| Directions | Research findings                                     | Proposed directions with supporting references | Await user feedback or selection     |
| Revise     | User feedback and saved session reference             | Revised plan or directions                     | Return to the appropriate checkpoint |

These stages define service boundaries. They do not require a separate class, queue, or host process for each stage.

Keep one coordinator session when the host supports resume. Create independent host sessions only when the workflow requires them.

### Personas and delegation

The coordinator chooses personas from the topic and constraints. The user can add, remove, or revise personas during planning.

Each task brief states its question, scope, expected sources, output location, and completion criteria.

The host uses its own subagent features. Verifold must distinguish native subagents from independent host processes and from a single-agent analysis.

A prompt that requests delegation does not prove that delegation occurred. Report the available host evidence and any limitation.

### Autonomy and feedback

Start with two modes:

- **Guided:** pause after planning. Accept free-text feedback on the search plan and personas. Stop again when directions are available.
- **Autonomous research:** let the coordinator proceed from planning through research and directions within the user's scope. Stop before selection.

Feedback resumes the saved coordinator when possible. If resume is unavailable, an explicit restart can use the saved question, plan, findings, and feedback.

Noninteractive use requires explicit inputs. A required checkpoint remains pending when no answer is available.

Cancellation and deadlines apply to host requests. Model spending limits remain host capabilities. Do not promise limits that the host cannot enforce.

## Initial evidence and direction contracts

Initial research requires a source list and a research report. It does not require a local PDF library.

Current source records contain a title and HTTPS URL. Each direction references URLs from the returned source list.

Structured reading status and DOI fields are possible later additions. A source link alone does not establish full-paper review.

Each direction includes:

- The research question and proposed contribution.
- Supporting source URLs.
- Prior-art uncertainty and relevant disagreements.
- Computational requirements and feasibility limits.
- A proposed first test and possible acceptance criteria.

The coordinator must distinguish evidence from inference. It must report failed searches and missing source access without inventing replacements.

Verifold checks required fields, reference links, and direction-to-source mappings. These checks do not establish scientific validity or source authenticity.

Do not label model-written bibliography entries as official citation exports.

## Optional literature collection after selection

Literature collection is a separate action after explicit idea selection. It is optional and does not block initial research directions.

The intended result is a collection of relevant PDFs and a Markdown memory file. The memory file maps papers to local files and source links.

The current `literature` command prints an explicit host task. The `--memory` option also requests Markdown memory and local file mappings.

Neither form starts the host or creates the requested artifacts. A generated task brief is not a completed download or a verified collection.

When implemented, the collection should record:

- The selected idea and the reason each paper is relevant.
- Each local PDF path and retrieval URL.
- Source-issued citation exports, when requested and available.
- The source and format of each citation export.
- A Markdown index that maps source records to local artifacts.
- Missing downloads, unavailable exports, and other unresolved gaps.

Preserve official citation exports separately from agent prose. Do not replace unavailable exports with generated BibTeX and call the result official.

A file hash detects later changes. It does not prove where the file came from or whether it supports a claim.

Independent network verification is a separate capability. Do not claim it from a model-written retrieval record.

### Next implementation slice

Offer three choices after selection: retain no papers, retain PDFs, or retain PDFs with Markdown context. Keep the choice separate from experiment approval.

The host receives the selected idea, source links, and a private output directory. It chooses relevant papers and performs retrieval through its tools.

For each Markdown synthesis, require a local PDF link, an official source link, and the PDF hash. Include methods, findings, limitations, and page or section references.

Label each synthesis as agent-written context. Record whether the host read the full paper or only part of it. Preserve the original PDF for later inspection.

Verifold should validate artifact paths and mappings before accepting the collection. Missing PDFs, failed extraction, and unavailable citations remain explicit incomplete results.

If independent citation provenance is required, use a narrow source-response capture command. The host chooses the source. The command preserves its response unchanged.

Acceptance requires an actual retrieved paper, its official citation export, a derived Markdown synthesis, and working mappings between them. Request-generation tests are insufficient.

A custom search engine, general PDF downloader, and citation-provider framework are unnecessary for the initial milestone.

## Harness adapter

Use a narrow run operation with an optional session reference.

Inputs include the selected host, project directory, prompt, cancellation signal, and deadline. Outputs include final text and a session reference when available.

Keep host arguments and response parsing inside the adapter. Preserve the user's installed host configuration and permission policy.

Distinguish these outcomes:

- The executable is unavailable.
- The process fails or the host reports failure.
- The request is cancelled or exceeds its deadline.
- The host response has an invalid format.
- The response lacks required research artifacts.

Report a permission checkpoint only when the host identifies one. Do not bypass permissions or retry a blocked action automatically.

Bound and drain process output. Treat stderr as diagnostic output, not proof of failure.

Do not add model-provider clients, context compression, token accounting, or a generic plugin registry.

## State and recovery

State remains under the private `.verifold/` directory. Each `.verifold/runs/<attempt-id>/` directory stores its brief, response, report, or failure details.

Store the question, constraints, autonomy, phase, host session reference, plans, findings, directions, and user feedback.

Keep one authoritative record for each fact. Do not duplicate the host's complete transcript.

Verifold owns project state writes. Hosts return results or write designated artifacts. Concurrent tasks must not overwrite the same output file.

Use the existing state lock and atomic replacement pattern. Save validated results before advancing a phase.

A successful process exit does not establish valid research output. Validate the output before marking the phase complete.

Normal failures preserve the checkpoint. SIGKILL can leave `.verifold/research.lock`.

Inspect the project before removing a stale lock. Confirm that no research process remains active. Resume the saved phase explicitly.

## CLI surface

The following commands describe the target interface. Final flags must match the implemented command help.

- `verifold init`: initialize the private project and start planning.
- `verifold research`: continue research or submit feedback at the current checkpoint.
- `verifold status`: show the phase and pending action.
- `verifold select`: record an explicit direction choice.
- `verifold literature [--memory]`: print an optional collection request for a selected idea.

The literature command prepares a host task. It does not execute the task.

`init --setup-only` preserves profile-only setup. Noninteractive research initialization requires `--profile`, `--host claude|codex`, `--topic`, and `--autonomy autonomous`.

Use the violet theme and an ASCII logo on interactive stderr. Keep structured stdout free of decoration.

Respect `NO_COLOR`. Do not emit ANSI color in noninteractive output.

Retain existing request-file commands unless a documented replacement exists.

## Implementation and acceptance

Use small commits. Each commit must pass `make validate` through the configured hooks.

1. Add the host adapter and test process behavior.
2. Add stage contracts, state transitions, and feedback handling.
3. Connect the questionnaire, research commands, and terminal theme.
4. Test installed-package behavior and both local harnesses.
5. Review correctness and apply the Ponytail complexity review.

Use [Ponytail's review skill](https://raw.githubusercontent.com/DietrichGebert/ponytail/main/.openclaw/skills/ponytail-review/SKILL.md) to identify redundant code and speculative abstractions. Preserve validation and error handling.

Changed instructions and comments use simplified technical English.

### Required checks

Formatting, linting, strict type checking, tests, builds, and the packed CLI consumer check must pass.

Test Claude Code and Codex separately in temporary projects. Record host versions and the stages that actually completed.

Each live flow must demonstrate:

- Initialization and a plan with personas.
- A guided checkpoint and a user feedback revision.
- Research findings with source links.
- Proposed directions that reference those sources.
- An explicit selection boundary without automatic experimentation.

Check delegation evidence when the host exposes it. Report any unsupported capability.

Use deterministic tests for malformed results, process failures, deadlines, cancellation, and interrupted state. Routine validation must not depend on live model access.

PDF downloads and official citation capture are not acceptance gates for initial research. Test them separately when the optional collection workflow executes them.

## Delivery status

Planning, guided approval, research with source links, and direction feedback are implemented. The adapter retains host session references for continuation.

Delegation remains host-reported. PDF retrieval, official citation capture, and memory creation remain instructions in an optional request. Live compatibility checks are pending.

The implementation report must identify completed stages, tested hosts, and remaining limits. It must not describe a prepared host task as executed work.
