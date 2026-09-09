# AutoResearch review for Verifold

Reviewed 2026-09-08 against the public `karpathy/autoresearch` master files and Verifold's founder context and research documents. Source links point to a moving branch; this is a code-reading review, not a reproduced experiment. GitHub's commit API was unavailable through the browsing tool, so an exact revision is not asserted.

## What the repository actually provides

AutoResearch is a compact single-GPU LLM optimization setup. It delegates execution to an existing coding agent rather than implementing a general multi-agent runtime. The division is clear: humans author research instructions in `program.md`, agents edit `train.py`, and `prepare.py` supplies fixed preparation and evaluation. Training has a five-minute budget; the README explicitly notes that results from different hardware are not directly comparable. Its dependencies and GPU requirements make this an execution adapter candidate, not the TypeScript platform architecture. [README](https://raw.githubusercontent.com/karpathy/autoresearch/master/README.md)

The program establishes a baseline, commits an experimental change, runs training, reads metrics, and retains or resets the candidate. It records successful, discarded, and crashed attempts in an untracked TSV; failed runs use zero-valued placeholder metrics. It instructs the agent to continue until interrupted and to kill runs exceeding ten minutes. These are instructions, not an enforced job scheduler. [Program](https://raw.githubusercontent.com/karpathy/autoresearch/master/program.md)

The implementation sets CPU/CUDA seeds to 42. Its training-time accumulator excludes the initial eleven steps; final evaluation and startup also fall outside that accumulator. The output separately exposes training time and total elapsed time. Evaluation is called by the editable training program, so importing a protected evaluator does not itself establish a secure measurement boundary. [Training code](https://raw.githubusercontent.com/karpathy/autoresearch/master/train.py)

Preparation pins a validation shard and excludes it from training and tokenizer preparation. The bits-per-byte evaluator uses fixed sequence length, but receives the model and batch size from the caller; its loss values come from that model's forward method. This is useful evaluation code, but independent verification needs a stronger trust boundary than an agent obeying a read-only-file instruction. [Preparation and evaluator](https://raw.githubusercontent.com/karpathy/autoresearch/master/prepare.py)

## Concepts to adopt

The following are Verifold design recommendations inferred from this review, rather than capabilities claimed by AutoResearch.

| Concept                     | Verifold application                                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Small research contract     | Compile a selected idea into a versioned brief: hypothesis, objective, allowed edits, baseline, metric, budget, datasets, and stop rules. Human approval locks it before a confirmatory run. |
| Baseline before search      | A pilot first verifies that the baseline and data pipeline work, estimates runtime and variance, and records feasibility failures before allocating a full campaign.                         |
| Cheap iterative attempts    | Make a campaign a collection of bounded attempts, each with its own code digest, inputs, metrics, logs, cost, and parent.                                                                    |
| Explicit research policy    | Store the human-approved instructions and model/harness configuration alongside the run. A policy amendment creates a version with provenance.                                               |
| Narrow modification surface | Give executors isolated worktrees and explicit writable paths. Keep evaluator, acceptance criteria, credentials, and scheduling controls outside their authority.                            |
| Compact persistent feedback | Stream structured lifecycle events to the hub. Agents read summarized findings with links to full evidence, rather than repeatedly ingesting entire logs.                                    |
| Simplicity as a tradeoff    | Permit a predeclared noninferiority or efficiency goal when simpler, cheaper code is scientifically useful. Do not silently reinterpret a failed improvement threshold as success.           |

## Concepts to replace or add

- **Campaign budgets:** enforce money, GPU time, model tokens, concurrent jobs, retry limits, and cancellation in the control plane. An instruction to run indefinitely is unsuitable as the platform's spending policy.
- **Durable failed-attempt evidence:** preserve every attempt before branch movement or cleanup. Use full commit IDs and content-addressed artifacts; do not depend on an untracked local log or dangling Git objects.
- **Separate execution status and scientific verdict:** `crashed`, `cancelled`, and `timed_out` are operational outcomes. `met`, `not_met`, and `inconclusive` describe evaluated evidence. A crash must have a missing metric with a reason, never a numerical zero that could win a lower-is-better leaderboard.
- **Exploration versus confirmation:** iterative optimization may adapt to visible validation data. Selection should yield a candidate for a separate locked confirmation stage with fresh seeds and an appropriate untouched holdout. A local improvement is not a verified claim.
- **Server-owned measurements:** keep evaluator identity and input hashes in the manifest, independently capture outputs, and recompute critical measurements outside agent-controlled reporting code. Pinning an evaluator file is necessary but insufficient when the candidate controls how evaluation is invoked.
- **Hardware-aware comparisons:** compare fixed-time results within a declared hardware/environment class. Charge total execution cost, including setup, failed jobs, evaluation, and model orchestration. Do not equate training time with billed duration.
- **Information from negative results:** preserve failed hypotheses and conditions in searchable memory. A confirmed null result can answer an R&D question even when it does not improve a benchmark.

## Fit to the proposed workflow

Use onboarding interests and consented Scholar/GitHub/session context to personalize a cited discovery feed. Each proposed direction should expose its evidence, unresolved question, expected cost, and a falsifiable pilot. Track scientific novelty as an assessment with supporting prior art, not an automatically established property.

Selecting an idea creates a pilot brief. Pilot evidence informs a separate approved run contract and experiment plan. An interchangeable harness executes that contract; Verifold owns budget enforcement, immutable records, provenance, progress, and verification. A final report links each claim to an attempt or external source. Community discovery can organize these records without making popularity the compute gate.

This preserves the existing context's strongest theme: the reusable, independently checkable run is the product. The TypeScript UI should make evidence and next decisions visible, while an AutoResearch adapter supplies one execution path.

## Questions for Manav

1. Should the first supported research template be small-model training/optimization, or a second ML template closer to your own interests such as mechanistic interpretability? This determines the first evaluator and adapter.
2. What may a selected idea spend automatically on a pilot, and what requires approval for the full campaign or escalation?
3. Should pilots be explicitly exploratory, with separate locked acceptance criteria and fresh evaluation data for confirmation? This prevents pilot-informed criteria from masquerading as pre-registration.
4. What evidence should unlock the first verification badge: a reproducible rerun, independent fresh-seed confirmation, or cross-hardware replication? These should probably be distinct labels.
5. Is the initial value proposition an R&D decision, a publication-quality claim, or a working project? The same numerical improvement does not satisfy all three purposes.
6. Should users connect a harness they already run locally first, or should Verifold manage the first worker? This changes integration scope, cost, and failure recovery responsibilities.
