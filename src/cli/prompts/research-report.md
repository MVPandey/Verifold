Investigate the approved research scope using the selected harness's web tools and relevant project evidence. Use the latest feedback to refine the investigation. Delegate persona tasks to native subagents when available and useful. If delegation is unavailable, disclose it and distinguish your own sequential analyses from independent review.

Search for the strongest relevant evidence, including results that weaken the proposed direction. Prefer primary papers, official documentation, datasets, and repositories. Read enough of each source to support the claim you attribute to it. Check dates, versions, evaluation settings, baselines, and limitations before comparing results. Do not treat a search snippet or absence of search results as proof of novelty.

Synthesize findings and disagreements into promising computational research directions. For each direction, explain the question, existing evidence, unresolved gap, competing explanation, feasibility, and a first test that could change the decision. Separate a novel contribution from a replication, diagnostic, or extension. Avoid cosmetic variants of the same idea and forced consensus between workers.

Make proposed gates specific to the research question. Describe the observable result, comparison, or evidence needed to proceed, revise, or stop. Label thresholds and resource estimates as proposals unless the user already fixed them. Do not invent measurements or imply that proposed tests have run.

No PDFs or official citation exports are required at this stage. Reference primary web sources. Propose ideas without selecting one or authorizing an experiment.

Return this JSON object:
{"summary":"findings, disagreements, and limitations","delegation":"native agents that actually ran and their work, or why delegation was unavailable","sources":[{"title":"primary method source","url":"https://example.org/method"},{"title":"primary comparison source","url":"https://example.org/comparison"}],"candidates":[{"id":"lowercase-slug","title":"research direction","recommendation":"evidence, prior-art uncertainty, feasibility, alternatives, and first test","gates":["proposed verification criterion"],"sources":["https://example.org/method","https://example.org/comparison"]}]}

The example URLs and descriptive values illustrate the structure only. Replace them with retrieved sources and your actual findings.

The current parser requires 2 to 50 sources and 1 to 20 candidates. Each candidate needs 1 to 20 gates and 1 to 30 source URLs drawn from the report's sources. IDs must be unique, with 1 to 80 lowercase ASCII letters, digits, or hyphens. Do not use periods, underscores, or spaces in IDs.

Keep summary and delegation within 12000 characters each. Keep candidate titles, recommendations, and individual gates within 4000 characters each. Source titles allow 500 characters and URLs allow 2000. Use HTTP or HTTPS URLs without embedded credentials.

These are validation bounds, not targets for quantity. If access fails or evidence is insufficient, explain that honestly in summary and return only actual sources and supportable directions. An incomplete response may fail validation, but fabricating evidence to pass would defeat the research task.
