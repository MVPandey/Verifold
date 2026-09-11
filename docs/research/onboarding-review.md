# Research onboarding review

## Decision

Verifold should start with a working agent harness and the research question. A reusable private profile should preserve useful preferences between projects. Creating that profile must not require a name, publication account, or conversation archive.

The recommended order is: select the harness and model, create or reuse the private profile, offer optional context, review any generated summary, and start research. The first context import should accept one user-selected memory or conversation-export text file. A short introduction written by the user and a skip option must also work. These are Verifold design decisions based on the comparisons below, not claims that every reviewed product follows this exact flow.

## Scope and evidence

This review compares official documentation and project repositories available on September 10, 2026. The links point to maintained pages and moving branches. The comparison describes documented behavior; it is not a security audit or a reproduction of each product's onboarding.

The platform comparison is alphaXiv's OpenResearch. Interpreting the earlier name “Alpha Archive” as alphaXiv is an inference based on the described product. A separate project named [Alpha Archive](https://github.com/RezaSoleymanifar/alpha-archive/blob/main/README.md) focuses on quantitative-finance paper replication. It is not the same platform.

## Comparison

| Project                                                                                           | Documented approach                                                                                                                                                                                                                       | Implication for Verifold                                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [OpenClaw onboarding](https://docs.openclaw.ai/start/onboarding)                                  | Establishes a working inference connection before normal chat. Optional memory import supports Claude Code, Codex, and Hermes memory files, with per-file control. Native conversation discovery is a separate opt-in feature.            | Verify the selected harness first. Keep memory import optional and separate from research execution.                                                         |
| [Hermes persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) | Uses bounded, curated Markdown memory. Separates information about the user from general environment and project facts.                                                                                                                   | Store a short research profile separately from project evidence. Avoid importing a complete conversation archive into every research prompt.                 |
| [alphaXiv OpenResearch](https://github.com/alphaXiv/OpenResearch)                                 | Wraps Claude Code, Codex, and OpenCode. Each session can choose a harness and model. Projects and artifacts remain local; an account is used for service-owned capabilities such as managed compute.                                      | Keep local research usable before community registration. Preserve the existing harness as the execution owner.                                              |
| [Karpathy autoresearch](https://github.com/karpathy/autoresearch)                                 | The user starts an existing coding agent with a small Markdown research contract. Its [program](https://raw.githubusercontent.com/karpathy/autoresearch/master/program.md) defines setup, a baseline, evaluation, and experiment records. | Ask for information that changes the next research action. Keep the research instructions small and readable.                                                |
| [PACE](https://github.com/jagbanana/PACE)                                                         | A Claude plugin with conversational onboarding, separate agent folders, and Markdown memory. It loads compact working context at session start and retrieves other material when needed.                                                  | Use a concise summary with a path to full context. Avoid a mandatory identity questionnaire or a new memory indexing service.                                |
| [Personal Model](https://github.com/Intuition-Lab/personal-model)                                 | Offers read-only source imports and separate consent to use an existing coding-agent subscription. The client keeps its login. Sparse models are valid results.                                                                           | Explain what data will be processed and which harness will process it. Do not fabricate a detailed profile when evidence is missing.                         |
| [JARVIS](https://github.com/patrickkorb/jarvis)                                                   | Selects Claude or Codex during setup. Optional personal-data integrations require enabling. Its dispatcher delegates tasks to execution agents and uses a separate memory service.                                                        | Adopt harness selection and explicit data access. Its custom dispatcher, integrations, and recurring memory consolidation exceed the current Verifold scope. |

OpenClaw and Hermes implement their own broader assistant environments. They are useful references for onboarding and memory boundaries, but copying their runtime architecture would conflict with Verifold's purpose. OpenResearch and autoresearch are closer references for the division between research instructions and agent execution.

The native harnesses also provide useful source material. Claude Code documents project-scoped, editable Markdown memory and a configurable memory location. Codex documents an optional memory pipeline that produces consolidated artifacts separately from raw session evidence. These mechanisms support accepting an existing summary, but they do not guarantee that a particular installation has useful memory available. Verifold should accept a selected file without depending on a fixed internal directory layout. [Claude Code memory](https://code.claude.com/docs/en/memory), [Codex memory architecture](https://raw.githubusercontent.com/openai/codex/main/codex-rs/memories/README.md)

## Proposed first-run flow

1. **Choose the harness.** Ask the user to choose Claude Code or Codex. The user must install and authenticate the selected harness; this version does not detect installed harnesses. Let the user choose a model or keep the harness default. Use the harness's existing authentication and permission controls.
2. **Create or reuse the agency profile.** Use `~/.verifold/agency` by default, with `--agency-dir` for an explicit alternative. Keep this reusable context separate from each project's research files. A minimal profile can contain only the selected harness and model preference.
3. **Offer relevant context.** If there is no approved research summary, offer a selected memory or export file, a short introduction, or no additional context. Do not scan history databases or search the home directory.
4. **Explain the operation before consent.** Show the manually selected source file, selected harness and model, and intended processing. Explain that the draft will remain private, then show its local path when it is ready for review. Explain that the configured model provider may receive the selected material. A local CLI does not imply local inference.
5. **Ask the harness to draft the profile.** Delegate synthesis to the selected runtime. Ask it to extract research interests, working preferences, and useful constraints, with source references and explicit unknowns.
6. **Preview the result.** Display a concise summary and the full Markdown path. Offer adopt, edit, and discard. Do not make an unapproved draft active research context.
7. **Start the research conversation.** Ask what the user wants to investigate. Pass the approved summary and research request to the chosen harness. The harness plans research and delegates its own agent tasks.

Returning users should see a brief explanation of which profile is active and then proceed to research. Reusing a profile must not trigger another history scan. Missing context, declined consent, or failed synthesis must still leave a usable minimal profile.

## Consent and profile content

Suggested consent text, with actual values substituted:

> Verifold can ask your selected harness and model to draft a research profile from this file: `<source>`. It will summarize research interests and working preferences, with references to the source. Your configured model provider may process the file under your existing harness settings. Verifold will save a private Markdown draft at `<destination>` for you to review. It will not publish the profile or import your full conversation archive. Continue?

The saved context should distinguish facts stated in the source, tentative inferences, and unknowns. For an imported profile, the synthesis request asks the harness to include the selected source path. This version does not add a generation timestamp or a separate consent ledger. Those can be added if profile provenance needs to be tracked across revisions. A short summary should help the next research session; the full Markdown should remain readable and editable. Research preferences are useful context, not instructions that override the current task.

Do not infer a person's name, employer, academic status, or enduring interests from incidental mentions. Do not retain credentials, private keys, or unrelated personal details. Historical requests and instructions inside imported text are source material, not authorization to execute them. Editing or discarding a draft must not silently preserve its claims in active context.

## Why broad history import is deferred

Conversation history can contain confidential work and information about other people. Old requests can also be poor evidence of current interests. A user who once asked about a topic may not want every future research session to prioritize it.

Bulk import would add transcript parsers, undocumented storage assumptions, indexing, deletion rules, and recurring maintenance. It would also increase model cost and expose more material to the selected provider. These are engineering and privacy assessments, not measured failure rates from the reviewed products.

One explicitly selected text file is a useful first boundary. It can contain an existing curated memory or a conversation export the user has already reviewed. Later integrations can add a documented source adapter with its own selection and consent flow if actual use shows that manual selection is insufficient.

## Responsibility boundary

| Verifold owns                                                  | The selected harness owns                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| Profile location, manual source selection, and consent prompts | Authentication and model access                                  |
| Draft preview and adoption                                     | Reading approved context and synthesizing the draft              |
| Research brief and approved contextual handoff                 | Research reasoning and subagent delegation                       |
| Project records, progress, and artifact references             | Tool permissions, sandbox behavior, and native session execution |

Verifold should not build a competing chat-history database, inference client, memory daemon, or general agent scheduler for onboarding. The extensible unit is a small task request to a host adapter, followed by a validated result and an explicit user decision.

## Acceptance criteria

- A new user can reach research after choosing a harness without providing personal identifiers or importing history.
- An existing approved profile is reused without another questionnaire or implicit rescan.
- No selected file is processed by a model before the consent message identifies the source and processing route.
- Adopt, edit, and discard have distinct effects. An unapproved draft is never passed as approved research context.
- Missing, invalid, or oversized files produce a clear error and a usable path back to onboarding.
- Profile and project context remain private by default and are excluded from published package contents.
- Both Claude Code and Codex can complete a small research session using the same onboarding contract.
- Automated tests cover the consent boundary, profile reuse, draft decisions, and failure recovery. Real session records remain local and are not committed.

The first version should prove this short flow before adding automatic source discovery or richer community profiles.
