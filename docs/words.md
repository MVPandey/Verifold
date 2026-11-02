# Words in the desk

Verifold's screens, terminal lines, and errors follow two skills: humanizer, and asd-ste100 at about 85%. In practice that means active voice, short sentences, plain words, and no semicolons. Contractions are fine now and then. A slightly longer sentence is fine when it reads better. Leave out slogans, and write no label that only a model would write.

## One word for each thing

| Thing                                              | Word         | Not                   |
| -------------------------------------------------- | ------------ | --------------------- |
| A unit of work that one agent does                 | task         | assignment            |
| The Claude Code or Codex process that does a task  | agent        | worker (in the desk)  |
| An agent that the person drives without a task     | session      | chat                  |
| What an agent does in a lab, as a short label      | job          | role, title           |
| Directions that work together, as a short label    | team         | group, squad          |
| The agent that plans and reviews tasks             | coordinator  | lead, manager         |
| The saved result of one turn of an agent           | version      | output, snapshot      |
| A GPU machine on RunPod                            | pod          | lease (in the desk)   |
| Something that waits for the person                | Needs you    | inbox, alerts         |
| The coordinator's request to the person            | question     | blocker (in the desk) |
| One conversation on the lab's board, with a title  | thread       | topic, channel        |
| What an agent reports that it did, with proof      | result       | claim, finding        |
| A recount or an audit of another agent's post      | check        | review                |
| A question for one agent or the person             | ask          | question (agents)     |
| A reply that closes an ask or an objection         | answer       | reply                 |
| A choice that becomes a decision with no objection | proposal     | suggestion            |
| What an agent says it does now, why, and what next | status line  | update                |
| A reaction to a post, with no post and no wake     | agree        | like, +1              |
| One web read in a harness's record                 | lookup       | search (as a count)   |
| The papers that the lab read, as one shared list   | reading map  | bibliography          |
| The lab's short ideas, from papers and lab work    | idea map     | concept list          |
| A random mix of ideas, judged by another harness   | long shot    | moonshot              |
| A subagent of an agent's harness                   | helper       | child, worker         |
| The lab's session that keeps the record            | Coordinator  | scribe, lead          |
| What a person reads of the lab, from posts         | brief        | summary, digest       |
| A brief's line for a reader outside the field      | plain line   | rewrite, TL;DR        |
| The cited posts, unchanged, under a plain line     | quote        | source, technical     |
| How strong the record behind a line is             | label        | confidence, score     |
| A second session that tests a plain line           | line check   | fact check, review    |
| How one thread went, in plain lines                | story        | recap, timeline       |
| The line under the box: who reads this and when    | reach line   | audience, recipients  |
| The levels of the box                              | level        | scope, audience       |
| What a person does to end a decision               | overturn     | revoke, cancel        |
| What brings an ended direction's agent back        | Reopen       | restart, revive       |
| What an agent found on earlier work                | prior work   | related work          |
| An agent in trouble, past 6 agents                 | needs a look | alerts, issues        |
| The app's plain view of a lab                      | Simple       | basic, easy mode      |
| The app's view with the agents' own words          | Technical    | raw, expert mode      |

## Agent names

In a lab, call an agent by its role and number: Agent 3, Checker 1. Add its job where the person looks for who it is: Agent 3 · Controls. In a sentence, the short name reads better: "Agent 3 reads your message." The harness is a small label, Claude Code or Codex, beside the name. A lab from before these names keeps handles such as `claude-2`, and the screens show them as they are.

## Post kinds

A lab uses Result, Check, Ask, Answer, Objection, Proposal, and Ruled out. A post shows Disputed while an objection stands. A lab from before threads keeps Claim, Evidence, and Question, and the screens show them as they are. The person's own post reads as Message.

## Long shots

Long shot is the plain word. Alien is the technical word, from the paper that gave Verifold the idea. Technical text and the wire can say alien. Simple text says long shot, because readers who tested the word alone did not understand it. Do not call a long shot an alien idea in Simple text.

"No search yet" is the mark on a post. It says what the record shows, so never write that an agent did not search: the agent can use a tool that Verifold does not count.

## How they work together

Say what the record shows, in counts of what changed: objections, accepted changes, and who needs whom. Never count messages. Write "Agent 3 needs Agent 2", not "Agent 3 is blocked". Verifold writes these lines. Do not say that an agent reports them.

## The reach line

Name who reads and when: "Agent 3 reads this after its current step." Name who does not and why: "Agent 1 is closed, so it won't." Say Ask the Coordinator for a question to the Coordinator, and say that no agent wakes for it. An answer says "No agent was disturbed".

## The brief

In a lab, Coordinator with a capital names the session that keeps the record. It assigns no work, so never write that it decides, leads, or tells an agent what to do. The lowercase coordinator is the older team's agent that plans tasks.

Words for evidence come from the record. Never write "a rerun overturned it" when no rerun ran: a code check is a code check. Keep the words of the posts for certainty, such as "may", "exploratory", and "no verdict yet". Say the part that passed along with the part that failed. Give each number its scope: whose set, and which run.

## Simple and Technical

Both views hold the same facts. Technical shows the agents' own words and posts unchanged. Simple can leave out detail, and it adds none. Text that Verifold writes shows no ID in Simple. Technical links each ID to its record.

Say "about" for a time that ignores a queue, such as the latest useful answer. A number that reads as exact promises more than the record holds.

## Task states

Use these words in the rail, the map, the task page, and Work: Not started, Starting, Working, In review, Done, Cancelled. A draft is a Draft.

## Text that a model wrote

Say who wrote it: "The agent says", "The coordinator says", "Proposed by the coordinator". Do not add a separate tag such as "Its reading".

## Errors

Say what happened, then what to do. For example: "task-10 is not running now, so there is nothing to stop." Do not end on the error alone.

## Fine print

Keep a note only when the person needs it to act or to stay safe, such as what a pod can reach or what a cancel keeps. Cut a note that only describes how Verifold works inside.
