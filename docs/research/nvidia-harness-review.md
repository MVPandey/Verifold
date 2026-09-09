# ARC harness review for Verifold: arc-code and NVIDIA context

Reviewed 2026-09-08. Read against `verifold-context.md` and `verifold-research.md`. Recommendations below are design proposals, not claims that these systems already solve autonomous science.

## September 9 clarification: Opus 5 and approximately 99%

The strongest match for the clarified description is **[jerber/arc-code](https://github.com/jerber/arc-code)**: the author reports **96.2% in one pass, 24/25 public games won**, then **99.3 pass@2 and 25/25 wins after retrying the missed game**. It uses stock Claude Code with Opus 5 at the configured `high` effort. This is a community repository, not NVIDIA's AVO. Its distinguishing claim is that the host writes task-specific machinery during execution; the harness supplies no solver and uses no subagents. The original NVIDIA comparison remains below as background. [Repository report](https://github.com/jerber/arc-code).

This identification is a best match to the clarified model and score, not confirmation from a user-provided link. Do not describe the result as 99.3 on a first attempt or as a private-set score. The repository says the full post-broker record is pending. Its reproduction guide identifies uncertainty in reconstructed unfinished-game scores, says launch effort is configuration rather than an independently recorded trace fact, and explicitly limits demonstrated transfer to models rather than new task domains. [Reproduction limits](https://raw.githubusercontent.com/jerber/arc-code/main/docs/REPRODUCE.md).

### Actual source mechanisms

| Inspected source                                                                        | Mechanism                                                                                                                                                                  | Verifold lesson                                                                                                                       |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [`PROMPT.md`](https://raw.githubusercontent.com/jerber/arc-code/main/PROMPT.md)         | Read recorded observations using code; retain findings and helpers in files; test a hypothesis briefly before batching; compare predictions with outcomes                  | Give the existing coding host an experimental method and durable evidence, then let it write the needed analysis tools                |
| [`act.py`](https://raw.githubusercontent.com/jerber/arc-code/main/act.py)               | Validate action syntax and budget; record action, plan, and observation; save state through temporary-file replacement; stop a batch after score or terminal-state changes | Put experiment side effects and bookkeeping behind a narrow deterministic command; invalidate queued work when its assumptions change |
| [`run.py`](https://raw.githubusercontent.com/jerber/arc-code/main/run.py)               | Independent workspaces, bounded concurrent sessions, streamed records, incremental database mirroring, recovery from notes and logs                                        | Separate host process lifecycle from experiment lifecycle; retain evidence before a worker exits                                      |
| [`rig/agents.py`](https://raw.githubusercontent.com/jerber/arc-code/main/rig/agents.py) | Host-specific launch arguments and event normalization behind a common protocol                                                                                            | Adapt the user's installed host instead of implementing another model conversation loop                                               |
| [`rig/broker.py`](https://raw.githubusercontent.com/jerber/arc-code/main/rig/broker.py) | Keep game credentials and canonical action recording outside the agent; serialize per-game access; retry failed finalization                                               | Separate writable research workspaces from authoritative evaluation and evidence                                                      |

The broker exists because an agent previously made a direct credentialed action that bypassed local recording. Its guarantee concerns the canonical record, not obedience to the provided client. That distinction is useful for Verifold: a local Markdown instruction or hook cannot alone establish evaluator isolation. [Broker rationale](https://raw.githubusercontent.com/jerber/arc-code/main/rig/broker.py).

### Recommended CLI meta-harness boundary

These are Verifold proposals informed by this review and the [Automative review](./automative-review.md):

1. **Verifold owns the research contract and hub protocol.** It records purpose, hypothesis, evidence inputs, preregistration, budget, lineage, artifact references, and verdict provenance. It exposes small CLI commands to prepare, inspect, record, evaluate, resume, and export a run.
2. **The user's existing coding host owns reasoning and tools.** It receives a task brief, approved workspace, current evidence, and acceptance plan. It writes scripts, chooses analyses, and delegates only when useful. Host adapters normalize capabilities and events; they must report unavailable usage data honestly. Host login reuse is an adapter-specific capability to verify, not a promise established by arc-code's key-based cloud setup.
3. **Automative owns its supported optimization loop.** Its immutable specification, protected evaluator, budget policy, ledger, and keep/discard decision become an execution adapter. Preserve its verdict separately from Verifold's scientific conclusion. General studies may need multiple linked Automative runs or another executor for baselines and ablations.
4. **Evidence survives the host.** Start with a local append-only ledger, artifact hashes, and generated Markdown summaries; synchronize through a versioned protocol. Git is a useful readable export. Multiple agents should not race to rewrite one shared evidence file.
5. **Supervision resolves uncertainty through experiments.** Before reporting that a direction is exhausted, surface untested assumptions, contradictory evidence, and the cheapest discriminating test. Permit stopping with `inconclusive`; never require spending the whole budget simply because the benchmark prompt did.

Do not copy the research prototype verbatim. For example, `act.py` retries timed-out mutating HTTP requests, which can be ambiguous if an action succeeded before its response was lost. Verifold needs operation IDs and reconciliation before retrying paid work. Also, `run.py` reads stdout before draining stderr, so a sufficiently full stderr pipe could stall a child; consume both streams concurrently, with cancellation and limits. Those are code-review inferences from the linked files, not reproduced failures.

The implementation acceptance bar should test crash recovery without duplicate launches, immutable criteria, recorded failed attempts, stale-plan rejection, bounded subprocess cancellation, and exports that reproduce the displayed verdict. A larger agent team is not an acceptance criterion.

## Resolve the benchmark attribution first

The requested “NVIDIA harness that scored 99% on ARC-AGI3” appears to combine distinct results:

| System                       | Primary-source result                                                           | What was reviewed                                                 |
| ---------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| NVIDIA AVO                   | 100.00 RHAE on ARC-AGI-3 **public**: 25 environments, 183 levels, Claude Opus 5 | Official announcement and original AVO paper                      |
| NVIDIA NOOA                  | 85.1% mean RHAE with GPT-5.6 Sol; 50.2% with GPT-5.5                            | Official announcement, repository README, and `src/nooa/agent.py` |
| Schema / Impossible Research | Self-reported 98.98%, described as approximately 99%, on ARC-AGI-3 **public**   | Authors' indexed project-page content; direct page fetch failed   |

Sources: [NVIDIA AVO announcement, August 21](https://developer.nvidia.com/blog/nvidia-avo-reaches-100-on-arc-agi-3-demonstrating-a-frontier-level-general-purpose-architecture-for-long-horizon-autonomous-agents/), [NVIDIA NOOA announcement, July 27](https://developer.nvidia.com/blog/six-agent-harness-capabilities-for-higher-model-performance/), [Schema project page](https://schema-harness.github.io/).

RHAE combines completion and action efficiency relative to human baselines. It is not a percentage of independently validated scientific claims. The benchmark documentation distinguishes partial completion from completing all levels efficiently. [Official scoring methodology](https://docs.arcprize.org/methodology).

NVIDIA explicitly limits AVO's result to the public set and warns that its model-baseline and VISTA comparisons are not controlled ablations. AVO used a text-grid interface and its own memory, supervision, and execution loop. This is evidence to investigate harness design; it does not establish how much memory alone helps, private-set generalization, or research novelty. [AVO evaluation discussion](https://developer.nvidia.com/blog/nvidia-avo-reaches-100-on-arc-agi-3-demonstrating-a-frontier-level-general-purpose-architecture-for-long-horizon-autonomous-agents/).

I did not find an official public repository for the exact AVO agent evaluated in that announcement. The paper describes an internally developed coding agent. Search surfaced third-party reproductions, which should not be presented as NVIDIA's implementation. The official inspectable NVIDIA repository is [NVIDIA-NeMo/labs-OO-Agents](https://github.com/NVIDIA-NeMo/labs-OO-Agents), a separate framework. [AVO paper, section 4.1](https://arxiv.org/pdf/2603.24517).

## Mechanisms worth adopting

AVO gives its agent previous implementations and scores, domain references, and an executable evaluator. Its kernel experiment uses correctness as a prerequisite for performance, commits candidates that match or improve the best result, and invokes supervision when exploration stalls. Unsuccessful intermediate attempts stay outside the committed solution lineage. The study implements a single lineage; population branching is future work. [AVO paper, sections 3–4](https://arxiv.org/pdf/2603.24517).

NOOA exposes typed calls, explicit state, code execution, programmable orchestration, and context/event APIs. Its memory records can express support, contradiction, and derivation relationships. Its world-modeling skill compares predictions with observed transitions and revises on mismatch. These are useful mechanisms to test independently of adopting its Python framework. [NOOA technical discussion](https://developer.nvidia.com/blog/six-agent-harness-capabilities-for-higher-model-performance/).

The inspected source separates runtime, event manager, context manager, and storage; default storage is in memory. It renders bounded state previews while preserving full values, protects framework context blocks, and supports explicit model selection with inheritance. Durable persistence is therefore something an adapter must configure and verify, not assume from the framework's name. The constructor also attempts tracing initialization; any integration must respect Verifold's explicit telemetry choices. [Inspected `agent.py`](https://raw.githubusercontent.com/NVIDIA-NeMo/labs-OO-Agents/main/src/nooa/agent.py).

### Proposed translation into Verifold

| Concept                       | Verifold implementation proposal                                                                                        | Acceptance check                                                                               |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Ground reasoning in execution | Every finding references a dataset version, code commit, evaluator output, or cited source                              | A claim without evidence cannot become a successful verdict                                    |
| Preserve search history       | Store every attempt, including failures and abandoned directions; distinguish attempts from promoted candidate versions | Restart reproduces current state without losing negative evidence                              |
| Typed durable memory          | Separate observations, hypotheses, decisions, and claims; attach evidence IDs and supersession links                    | Contradictory observations remain visible after summaries change                               |
| Conditional supervision       | Trigger review after repeated failures, no new evidence, budget milestones, or evaluator anomalies                      | Supervisor can redirect the plan but cannot mutate locked criteria                             |
| Bounded context               | Pass artifact references and summaries; fetch logs, tables, and checkpoints on demand                                   | Large artifact ingestion does not inflate every model turn                                     |
| Adaptive orchestration        | Let a coordinator propose tasks, dependencies, and models within an enforced budget                                     | Duplicate tasks, competing writes, and over-budget launches are rejected by deterministic code |
| Hypothesis correction         | Record expected outcome before an experiment; compare observed outcome and explain the update                           | A failed prediction remains attached to the hypothesis history                                 |
| Independent verification      | Separate exploratory evaluator feedback from confirmatory evaluation                                                    | The search agent cannot use protected holdouts as an optimization oracle                       |

These are Verifold design inferences. The experiment runtime may remain Python or another harness while the platform, contracts, and UI remain TypeScript. The stable seam is a versioned run manifest and event protocol. This respects the existing decision that the verification hub is the product and execution engines are replaceable.

## Necessary differences from an optimization harness

Do not adopt success-only history as the scientific record. Store unsuccessful attempts even if only improvements become reusable candidate versions. Otherwise the hub encourages selective reporting and conceals how extensively a metric was searched.

A pilot should be explicitly exploratory. It may establish feasibility, estimate effect size and variance, identify confounders, and propose a confirmatory design. Freeze acceptance criteria after the pilot and before confirmatory compute. An amendment creates a new linked run. A promising pilot is not a verified result.

Do not translate a game score into a “novelty confidence” badge. Ideas should distinguish proposed novelty, retrieved prior-art evidence, feasibility, and uncertainty. Confirmatory work must include fresh seeds, suitable baselines, ablations, a protected evaluation split, and a policy for repeated comparisons. The appropriate statistical procedure depends on the research question.

Keep research purpose visible: engineering R&D may target cost or latency under correctness constraints; publication needs a defensible scientific claim and limits; a project may target usable artifacts. A universal scalar score would obscure these differences.

For the UI, surface a run timeline with evidence, pending gates, spend, agent responsibilities, and the current claim. Use “Exploratory,” “Criteria met,” “Inconclusive,” and “Independently rerun” as distinct states. Show the evidence behind a state instead of implying that a model's narrative establishes it.

## Questions for Manav

1. The clarified Opus 5 / approximately 99% description now most closely matches arc-code; a direct link remains useful only if a different repository was intended.
2. Is the first autonomous execution scope still ML and computational experiments, while the profile accepts broader scientific interests?
3. After idea selection, may Verifold spend a small fixed pilot budget automatically, or should selection first open a proposed pilot for approval?
4. Which research purpose should the initial product optimize for: independent ML publication, industry R&D, or reproducible engineering projects?
5. What can a supervisor change autonomously: task allocation only, methods within the protocol, or a new exploratory branch requiring a fresh preregistration?
6. Which existing coding sessions and runtimes should the first adapter support, and should imported session material be selected explicitly before it enters shared memory?

## Review limits

This review does not reproduce any ARC score, install NOOA or arc-code, audit either entire repository, or verify an unavailable AVO runtime. The September 9 follow-up inspected arc-code's prompt, actuator, launcher, host adapters, broker, and reproduction notes. Source links to `main` are moving references and must be pinned to a commit before implementation. Broader scientific success remains a hypothesis to test with Verifold's own preregistered pilot cohort.
