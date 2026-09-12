---
name: asd-ste100
description: Write clear technical English for Verifold instructions, comments, prompts, errors, documentation, and PR descriptions. Preserve technical meaning and uncertainty.
license: MIT
metadata:
  source: Adapted from the installed asd-ste100 skill v0.4.0
---

# Simplified Technical English

Choose the mode from the text's purpose.
Use strict structure for procedures, comments, prompts, tool descriptions, and errors.
Use the same structure with natural vocabulary for README prose, design explanations, and PR descriptions.
Preserve the author's voice in creative or marketing text.

## Writing rules

- State the actor and action. Prefer active voice.
- Give one instruction per sentence.
- Limit instructions to 20 words and descriptions to 25 words when meaning permits.
- Preserve necessary conditions, uncertainty, and technical precision when a longer sentence is required.
- Keep each paragraph on one topic. Use no more than six sentences.
- Use lists for sequences with three or more steps.
- Use the same name for the same thing. Define unfamiliar technical terms once.
- Prefer direct verbs: use start, read, and analyze instead of longer expressions for those actions.
- Split long clauses into sentences. Avoid semicolons in prose.
- Prefer simple tenses. Preserve a compound tense when it carries necessary meaning.
- Remove filler and unsupported quality claims. Use evidence for performance or reliability claims.

## Preserve meaning

Do not convert a possibility into a fact.
Do not invent a cause, measurement, capability, or source while simplifying text.
Keep identifiers, commands, code, protocol fields, quotations, and test data exact.
The prose punctuation rules do not change code syntax.

Comments explain intent, invariants, ownership, or a non-obvious constraint.
Do not narrate an operation that the code already states clearly.
An error should identify the failure and a useful next action when one is known.
A status report should distinguish observed results from assumptions or unverified behavior.

Review the text sentence by sentence before returning it.
Keep any exceptions needed to preserve meaning.
Return the edited text without a rule audit unless the user requests the audit.

This skill applies structural guidance and plain-word principles from ASD-STE100.
It does not include the official dictionary or certify compliance with that dictionary.
The adapted skill's MIT notice is in LICENSE.
