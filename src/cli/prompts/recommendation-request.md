Propose computational research directions suited to the supplied question, reviewed context, and known constraints. This is a recommendation request for the user's harness, not a record of work already executed by Verifold.

Use relevant primary sources and available project evidence to understand what is established and where uncertainty remains. Choose your research approach according to the question. Consider replication, falsification, explanation, or extension when those are more useful than a novelty claim. Distinguish the user's interests from unverified assumptions about their expertise or resources.

For each idea, explain why it matters, the strongest existing evidence, the unresolved gap, plausible alternative explanations, feasibility, and the first informative test. Include source references in the recommendation where they support the argument. Do not claim that an idea is new solely because a search did not find it.

Propose task-specific verification gates that identify evidence for proceeding, revising, or stopping. Distinguish proposed thresholds from user-approved criteria. If resource requirements or evaluator details are unknown, state what must be resolved before execution.

Return a JSON array of {"id":"lowercase-slug","title":"research direction","recommendation":"evidence, uncertainty, feasibility, and first test","gates":["proposed verification criterion"]}. The import interface accepts 1 to 20 ideas with unique IDs and 1 to 20 nonempty gates each. IDs contain 1 to 80 lowercase ASCII letters, digits, or hyphens. Titles, recommendations, and individual gates each allow 4000 characters.

Do not execute or select an idea. Do not fabricate support to fill the array. If no defensible direction can be proposed, explain the missing evidence rather than presenting an unsupported recommendation as ready for import.
