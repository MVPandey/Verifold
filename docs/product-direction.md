# Verifold product direction

Proposal dated 2026-09-08, informed by the founder context and the three repository reviews. This supplements the established decisions rather than silently rewriting them.

## Product boundary

The new workflow is a useful personal entry point to the established run-centric hub. Keep execution harnesses replaceable: Verifold owns the contract, provenance, gates, independent confirmation, and publication surface. It should not need to win a harness benchmark to remain useful.

The initial scaffold follows the current Manrope type treatment, paper `#F8F7FA`, ink `#101014`, violet `#7C3AED`, and deep purple `#4C1D95`. A left workspace navigation supports a wide research desk; ideas lead into a two-column protocol review and then an evidence timeline. The memorable element is the research question itself, supported by the approved manifold mark. The marketing page remains separate.

## Intended workflow

1. **Profile.** Ask what the researcher publishes and explores, their intended outcomes, and optional Scholar/GitHub references. Let users explicitly choose local session exports and inspect the selected material before import. A link alone grants no account or filesystem access.
2. **Daily discovery.** A durable scheduled worker pulls allowed sources per interest, deduplicates by canonical identifiers/version, stores retrieval timestamps, and ranks relevance and source quality. Retry with a deadline and per-source limits; use an idempotency key for each profile/date/source. Show source coverage and stale feeds. External papers and code are untrusted input, never authority to change tools or permissions.
3. **Ideas.** Generate falsifiable claims with citations, prior-art uncertainty, likely effect, costs, and a disconfirming experiment. Diversity and feasibility matter alongside relevance. Say “proposed direction,” not “novel discovery.” Preserve rejected ideas to measure selection bias.
4. **Exploratory pilot.** Selection opens a plan with purpose (R&D/publication/project), baseline reproduction, budget, data rights, environment, and stop conditions. Once execution is integrated, report observed feasibility, variance, failures, and analysis artifacts. Pilot observations inform the next protocol; they are not confirmation evidence.
5. **Confirmatory contract.** Human approves the claim, comparator, practical effect threshold, metric direction, sample size/seeds, statistical test and uncertainty reporting, ablations, holdout policy, total spend, and scale gates. Version and hash the protocol before execution. Amendments create a linked run; do not overwrite it.
6. **Execution.** A model coordinator proposes a task graph and agent assignments; deterministic services enforce approvals, leases, budgets, deadlines, cancellation, retry limits, and allowed tools. Start with an Automative or AutoResearch adapter. Run untrusted code in isolated workers with no ability to alter evaluators, secrets, or acceptance criteria.
7. **Live hub.** Append observations, hypotheses, decisions, errors, metrics, and artifact hashes to a durable event store. Serve sequenced events to the UI with reconnect/replay support. Give agents bounded summaries and references, not every transcript. Git holds versioned code/protocol snapshots and exported reports; do not have concurrent agents rewrite one shared Markdown file as the only database.
8. **Verdict and verification.** Compute criteria outcomes from retained artifacts and a protected evaluator. Distinguish failed execution, criteria not met, inconclusive, criteria met, and independently rerun. Confirmation uses fresh data/seeds and a separately executed evaluator. Record failed attempts and denominator, not just the best candidate.
9. **Results and community.** Return purpose-specific artifacts: engineering measurements, reproducible project outputs, or a manuscript grounded in runs. Owners explicitly publish run pages. Add forks, rerun contributions, and discussion before votes/reputation. No automatic external venue submission or model-assigned authorship.

## Concepts to adopt

| Source                                                 | Adopt                                                                                                       | Strengthen or avoid                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [AutoResearch review](research/autoresearch-review.md) | Human-editable research program, small baseline-first attempts, compact keep/discard feedback, code lineage | Endless loops and mutable measurements; wall-clock billing differs from its five-minute training clock |
| [NVIDIA review](research/nvidia-harness-review.md)     | Evidence-linked memory, bounded context, stagnation-triggered supervision, typed events and task allocation | Game benchmark scores do not establish research validity; exact AVO runtime was not found publicly     |
| [Automative review](research/automative-review.md)     | Locked contracts, deterministic gates, full attempt ledger, budgets, versioned protocol memory              | Repeated holdout feedback, single-worktree assumptions, local integrity mistaken for isolation         |

The “NVIDIA 99%” premise needs a link: the sourced review distinguishes AVO's 100 public-set RHAE, NOOA's 85.1%, and Schema's roughly 99%. These are distinct systems and evaluations. See the review for primary sources and limitations.

## Service boundaries to implement after decisions

A TypeScript API owns authentication, project authorization, validated requests, and commands. Domain services own workflow transitions. PostgreSQL (proposal, not selected) owns manifests, append-only events, optimistic version checks, worker leases, and an outbox. Object storage owns immutable logs/datasets/artifacts by hash. A durable scheduler owns daily ingestion and run jobs. Execution adapters translate versioned commands/events to external harnesses and compute providers. Provider credentials remain server-side; the client cannot authorize spend by editing state.

Minimum production checks: tenant isolation, cancellation propagation, duplicate event delivery, lease recovery, budget reservations under concurrent launches, evaluator isolation, artifact tampering, source outage recovery, and clean restart from durable state. These are future integration checks, not claimed implemented by the current browser tests.

## Questions for Manav

1. **First user and outcome:** build first for you doing small-model/agent research, independent researchers seeking publications, or industry R&D teams? Recommendation: your own computational ML workflow first, while accepting broader profile interests.
2. **Pilot authorization and economics:** does selecting an idea authorize a capped pilot, or only open its plan? What are the dollar/time ceilings for a pilot, full run, and daily discovery? Recommendation: plan-first initially, then opt-in automatic pilots within a monthly cap.
3. **Execution home:** should the first real run use your local Automative setup, a user-selected coding agent, or managed GPU workers? Recommendation: Automative locally plus a stable generic event contract; add AutoResearch import next.
4. **Verification bar:** what claim earns the “independently rerun” designation—fresh seeds on the same machine, another worker/account, or different hardware? Recommendation: show each dimension separately; do not collapse them into one badge prematurely.
5. **Context and visibility:** which session formats should import first, and should all projects default private until explicitly published? Recommendation: user-selected exports and private-by-default research.
6. **Harness identity:** did you mean NVIDIA AVO, NVIDIA NOOA, or Schema for the ARC-AGI-3 result? The reviews cover AVO/NOOA and identify the Schema score, but do not pretend the unavailable AVO source was inspected.

These answers govern implementation scope and integrations. The scaffold intentionally leaves their dependent services unconnected.

## Accepted corrections — 2026-09-09

This section supersedes the browser-first workflow and the open questions above.

The CLI is the product entry point and owns the questionnaire, profile, host integration, and any website connection. The website is a read-only projection, not a required onboarding step. Initial scope includes math, CS/ML, security, and any research whose complete experiment process is computational. Use Automative beneath the user's existing AI harness; do not replace host model routing, permissions, or session ownership.

The host generates a list of promising ideas with recommendations. Verifold prompts the human to choose. Choosing an idea opens pilot planning, not automatic execution. Agents recommend task-specific gates: proof-kernel acceptance for formal math; correctness, performance, and regression checks for systems work; explicitly authorized environments and reproducible security tests; appropriate seeds/statistical designs for stochastic ML. The pilot's budget and execution authorization remain distinct from idea selection.

Research defaults private regardless of the software repository's public visibility. The current implementation creates only local state and a local HTML snapshot. Remote profile creation/synchronization should later be owned by an authenticated CLI adapter, with explicit sharing actions.

Implemented commands: `init`, `recommend`, `ideas --from`, `select`, `handoff`, `view`, `status`. The host integration currently uses explicit subprocess JSON requests/files, not a claimed native host plugin. The Automative handoff is a planning request, not an executed or validated experiment specification. This keeps the implemented boundary honest while the full runtime adapter is developed.
