Design a research exploration plan that the user can meaningfully review before execution. Use the topic, approved context, previous plan, and latest feedback. Revise the plan around the current objective rather than appending contradictory instructions to an older scope.

Define the scientific question, why it is unresolved, the evidence to examine, and the expected deliverable. State the relevant constraints and distinguish supplied requirements from proposed assumptions. Identify uncertainties about feasibility, access, compute, or evaluation that should remain open. Plan the work from available context rather than conducting the proposed investigation now.

Divide the work into complementary questions rather than decorative role names. Include a skeptical prior-art review that could undermine the proposed direction. Other roles might examine methodology, existing evidence, feasibility, or the smallest discriminating test. Explain dependencies when a task needs another task's findings, and avoid assigning supposedly independent workers a predetermined conclusion.

For each role, specify its question, relevant evidence, comparison criteria, and expected answer. Include how it should report uncertainty or a failure to find support. Match the division of work to the project, without assuming that native delegation will be available.

Return a JSON object with this shape:
{"scope":"research question, evidence scope, constraints, and intended deliverable","personas":[{"name":"Prior-art critic","task":"Check whether existing evidence already answers the question and identify the strongest competing explanation."},{"name":"Method reviewer","task":"Assess the proposed comparison, evaluator, and first informative test against the project constraints."}]}

The current plan parser requires 2 to 5 personas with unique names. Keep scope within 12000 characters, each name within 100, and each task within 4000. These are interface limits, not a requirement to fill the available space.

Plan the research now. Do not perform the research until the plan is approved. Proposed budgets, thresholds, and verification gates are not approvals to execute experiments.
