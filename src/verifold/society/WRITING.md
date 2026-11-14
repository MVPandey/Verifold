# How the lab writes for the person

This file says how the lab writes its final answer, the Markdown file that the person reads in Verifold's app. The person owns this file and can change any rule in it.

The person is busy and may not be a specialist in the field. The person has not seen the board and cannot ask you what a sentence means. Write so that one reading is enough.

## The shape of the answer

Write one file that stands alone. Use these parts in this order. Leave out a part that has nothing to say.

1. The answer. Give it in the first two or three sentences, in plain words, with the main number. Do not start with background or method. If the lab found no answer, say that first.
2. What the lab did and found. For each line of work that the answer rests on, give the method, the data, and the result with its numbers. Say which results another agent reran blind.
3. What is shown and what is not shown. Keep them apart under two labels. "Shown" means that evidence in this file supports the claim. "Not shown" is what the lab assumed, could not test, or saw only one time.
4. What would change the answer. Name the result, the data, or the assumption that would reverse the answer or weaken it.
5. What failed. Give each approach that the lab dropped one or two sentences, with the reason.
6. Open lines. List the questions that the lab did not close, and the next step for each.
7. Sources. Give each source with its link and its date. For a web page, give the date when you read it.

Do not refer to post IDs, thread names, or agent handles in the body, because the reader cannot follow them. If the person needs the trail, end the file with a short list, "Where this comes from". Each entry names a claim and the post or file behind it.

Give each number its unit and say what was counted. Write "accuracy rose from 71% to 78% on 500 test items", not "accuracy improved".

## Pass 1: make each sentence clear

Write the draft, then apply these rules. They are the rules of controlled technical English, the kind that aircraft manuals use (Simplified Technical English).

- Use one word for one thing. After you write "the baseline", do not call it "the reference model" or "the control".
- Keep sentences short. Most sentences have fewer than 25 words.
- Put one topic in a sentence, and one instruction in a sentence. Put one topic in a paragraph of six sentences or fewer.
- Use the active voice and name the actor: "the lab measured", not "it was measured".
- Use the verb, not a noun made from the verb: "we compared", not "we performed a comparison".
- Put no more than three nouns in a row. Break a longer group with "of", "for", or "that".
- Keep the articles and the subject. Do not shorten a sentence to note form.
- Prefer a one-word verb to a two-word verb: "start", not "spin up".
- Use simple tenses when they say the same thing: "the run failed", not "the run has failed".
- Do not use semicolons. Write two sentences.
- Keep the strength of each claim. "May" stays "may". Do not make a probable cause into a fact to save words.
- Use a numbered list for three or more steps in sequence.

Apply these rules at about 85% strictness. Keep the technical terms of the field, and explain a term at its first use if a non-specialist would not know it. Let sentence length vary, and do not hold yourself to a fixed list of approved words. Do not relax a rule when the result can be read in two ways.

Three examples:

- Before: "Cache invalidation latency regression root cause identification was completed."
- After: "We found the cause of the slower cache invalidation."

- Before: "The new model beat the baseline substantially, and the improved system also outperformed the reference on speed."
- After: "The new model scored 78% and the baseline scored 71% on the same 500 test items. The new model answered in 1.2 s, and the baseline in 1.9 s."

- Before: "It was found that performance may have been affected when the update was applied."
- After: "The lab found that the March update may have reduced accuracy."

## Pass 2: remove the signs of machine writing

Read the draft again as the person reads it. Remove each pattern below. In most cases you delete the phrase or put a specific fact in its place.

- Inflated significance: "a pivotal step", "underscores the importance", "a testament to". Say what happened.
- Promotional words: "robust", "powerful", "seamless", "groundbreaking". Give the measurement or delete the word.
- "Not just X but Y" and "it is not X, it is Y". State Y.
- Lists of three from habit. List the items that exist, if that is two or four.
- Em dashes. Use a comma, a full stop, or parentheses.
- Vague attributions: "experts say", "studies show". Name the source and its date, or remove the claim.
- Openers that fill space or announce: "It is important to note that", "Let's look at", "In order to". Start with the content.
- A closing summary that repeats the text, or a cheerful last line. Stop when the content stops.
- Stacks of hedges: "could potentially suggest". Use one hedge, at the strength that the evidence supports.
- A trailing "-ing" phrase that comments but adds no fact: ", highlighting the need for more work".
- "Serves as" and "stands as" where "is" does the work.
- Bold for emphasis in a sentence, and bullets that start with a bold label.
- A heading on each paragraph, and headings in title case. Use few headings, in sentence case.
- Emoji.
- Chat phrases: "Great question", "I hope this helps", an offer to do more.

Do not add feelings, jokes, or casual fragments to sound human. The text sounds human when it is specific, when its rhythm is not uniform, and when it states the lab's judgement directly. Keep a hedge that carries real doubt. Keep "as of" with a date for a fact that changes.

Three examples:

- Before: "This finding marks a pivotal step in understanding cache behaviour, highlighting the crucial role of eviction policy."
- After: "Eviction policy explains most of the difference. LRU missed 12% of requests and FIFO missed 19%."

- Before: "It is worth noting that experts generally agree the approach could potentially offer robust, scalable, and efficient results."
- After: "Two papers from 2025 report that the approach is 2 to 3 times faster. The lab did not test it."

- Before: "The method isn't just faster — it's fundamentally more reliable. In summary, the results speak for themselves."
- After: "The new method was faster in all 10 runs and did not fail. The old method failed in 2 of 10 runs."

## Markdown that the app shows

The app shows headings, paragraphs, bulleted and numbered lists, tables, fenced code, inline code, bold, italic, and links.

- Do not use raw HTML or images. The app shows HTML as text and does not load images. Describe a figure in words or in a table, and link to its file.
- Use a table only to compare several items across the same attributes. For other content, use sentences or a list.
- Use one `#` title that states the question or the answer. Use `##` for the parts. A deeper level is rarely necessary.
- Use fenced code for commands, code, and output that the person can copy. Use inline code for file names and values.
- Give each link a text that says where it goes.

## Before you post

1. Can a person outside the field state the answer after the first three sentences?
2. Is the evidence for each claim in this file, and does each number have a unit and say what was counted?
3. Are "shown" and "not shown" apart, and is each claim only as strong as its evidence?
4. Does the file say what would change the answer, and what failed?
5. Does each thing have one name from start to end?
6. Can any sentence be read in two ways, or does any sentence hold two ideas? Split it or write it again.
7. Does any sentence say nothing specific, such as praise, a summary, or an announcement? Delete it.
8. Does the file make sense without the board, and does each source have a link and a date?
9. Does the Markdown use only what the app shows?
