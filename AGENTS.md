# Repository instructions

These instructions apply to the whole repository. Instructions from the user take precedence over this file.

## What Verifold is

Verifold runs the coding agents that a person already has, such as Claude Code and Codex, as a society that works on one research question. Agents post in threads, object to weak results, and rerun each other's work from a clean copy of its files. The person sets the direction and makes the calls on money, scope, access, and time.

Verifold is the environment, not a harness. It starts each agent's own harness over ACP with the person's own settings, gives the agent a folder and the board as an MCP server, and keeps the record. It starts no agent of its own. It starts the seats that the person chose, and a seat that the lab's coordinator adds with the person's yes, with the person's power for that move, or within the person's grant of spare seats. An invited agent runs by itself. An independent rerun is a rerun from a clean copy of a post's files by another agent than the post's author. An agent or the person asks for one, and an agent of the lab takes it. The clean copy is an export of the pinned commit as plain files in `.verifold/reruns/`, a folder of Verifold's own. Verifold computes the ID of every object that it exports and checks it against the commit's ID in the record, checks the copy again at every take, and gives the taker a manifest of SHA-256 sums. For a rerun, Verifold writes nothing, deletes nothing, and runs no Git command inside any agent's folder: an agent can change its folder at any moment, so no check of a path there holds until its use. To show a pinned file or to export a pinned commit, Verifold reads Git objects through a Git directory of its own, `.verifold/snapshots.git`, and computes each ID itself, from the commit's ID in the record down. For both, it runs no Git command in an agent's folder, and Git reads the configuration of that directory and of no repository of the lab. A snapshot is a commit in that Git directory. Every Git command for a snapshot names that directory and starts in Verifold's own folder, and `git add` then works in the agent's folder, which it names as its work tree. Nothing in an agent's folder can name a program that runs, and Git uses no configuration, hook, or filter of the folder's own repository. Git reads the agent's files, and its `.gitignore` and `.gitattributes` files, as data. It records a repository inside the folder as that repository's one commit, without its files. For that it reads the repository's HEAD and its format settings, also through a `.git` file there that names another Git directory. Every Git command that Verifold runs has hooks and the file watcher off.

A harness is an entry in `harnesses/catalog.py`: its name, the command that starts its ACP agent, its model family, the ID of its auto mode, whether the harness itself names the MCP server in a tool call, and where it reports its provider's usage limits over ACP. The person's settings can add entries. The runner reads these fields and has no branch on a harness's name. It finds the model and effort options of a harness by their ACP category.

Verifold writes no prompts. Every text that it sends to an agent is one of three things:

- protocol documentation: what a tool or a kind of post is and does, who hears a post, and what the limits are. This is the MCP server's instructions and its tools' descriptions, in `server/join.py`.
- a fact about the state: the start message, the doorbell, the message after a restart, more time, or a turn that was cut short, the invitation, and what a tool returns. The messages are in `runner/messages.py`.
- a norm, which lives in `.verifold/LAB.md` or `.verifold/WRITING.md`. The person reads and edits both on the app's Norms page. The defaults are `society/LAB.md` and `society/WRITING.md`.

No sentence in Python tells an agent what to do with its work, in what order to work, or how to behave. `tests/verifold/test_words.py` is a narrow guard for this rule: it fails on the sentences that this rule removed and on the common ways to open an order. It does not prove the rule, and its comment lists what it misses, so read each new sentence for agents against the rule yourself. A sentence must also be true in every state of the lab: closed, out of time, and after a restart. An error message can still say what a call needs.

Agents decide for themselves what to watch, when to work, which threads to join, and what to start. Code enforces only these limits, at Verifold's own boundary:

- who posts: each agent has its own token
- the integrity of the record: write-once events, references that exist, nobody checks their own work, nobody votes on their own post or gives it a badge, a close names a candidate answer that stands, a new close comes after the lab's reading of the question, a Confirmed badge from an agent names a check that holds, and only the person, or a coordinator that the person seated before the proposal, seconds a Breakthrough badge. Before each write, the server checks that the record's path still names the file that it opened, that the file ends where the server's last write ended, and that its last bytes are the ones that the server wrote. It moves bytes that another program added at the end to a file beside the record, and it stops when the file was replaced, removed, shortened, or rewritten. Any other change, and any change after the server's last write or while no server ran, takes effect at the next start, and Verifold cannot tell it from its own writing
- Held up, which needs an independent rerun by another model: the check of a take that holds, from another agent of another model family than the post. The agent took the rerun, so it was given the clean copy, and posted the check with files of its own. The mark does not prove how the files were made
- the reviewer seats: a check of another agent's post and a request for an independent rerun of another agent's post take one of the lab's reviewer seats. So does the taking of such a rerun, while an agent in a reviewer seat can take it. An objection takes none
- the votes that an agent sees: the board shows an agent no vote on a post that the agent did not write and has not voted on, until the post is as old as the lab's reveal time when the post was written. Until then it takes back no vote of an agent on that post. The seal is the board's: an agent that reads the record on disk sees every vote
- the entries that an agent sees: while a round is open, the board shows an agent nothing of another agent's entry but that it exists and who wrote it, and the entry takes no reply, vote, badge, rerun request, or link. An idea that is an entry hides its author too. The seal is the board's: an agent that reads the record on disk sees every entry
- ideas and branches: an idea states its test and what result would rule it out, and it hangs on a branch in force of the lab's reading or on another idea. A branch keeps its ID across readings, and a reading retires only a branch in force
- proposals: in a lab with two or more agents that do the work, the desk not among them, the board refuses a new proposal while a result that it builds on has no check with the method `challenge` from another agent, and the refusal lists those results
- one holder of a rerun: a take of a wanted rerun gives its agent a lease for the lab's minutes, and while the lease stands the board refuses that rerun to every other agent, except to an agent of another model family than the post while no holder is of another family
- one holder of a task: a claim of a task gives its agent a lease for the lab's minutes, which the holder's posts on the task start again. While the lease stands, the record refuses the task to every other agent. An agent holds one task at a time and never claims its own. A lease that ends at its time opens the task again, and the record says that the claim lapsed. A hand-back comes from the agent that claimed the task last, and only the task's author accepts it. The board gives a task to nobody: an invitation in a task's `mentions` is no order
- names: an agent's chosen name is its own for ever, it looks like no other agent's name, and it holds no word of a harness, a model, or the board
- the desk's actions: the desk is a seat that the person chooses, which answers the person in the desk chat and acts on the person's word. Each of its actions names in `on` a post of the person in the desk chat from the last 60 minutes, and the record refuses every other. The board takes no work of the lab from the desk: no plan, result, check, proposal, ruled-out lead, objection, close, entry, vote, badge, or take of a rerun. Only the person's posts in the desk chat wake it, also while the lab is out of time, at a limit, or closed, its turns count toward what the lab spent, and it counts for no round, no close, and no reviewer seat
- time: at the lab's time limit, Verifold stops the turns of the agents that it started, other than the desk's
- pace: a pause of a seat lets the turn that runs finish, and until it ends no post but the person's starts the seat's next turn. A limit of tokens for one hour of the clock, of a seat or of the lab, holds the next turn until the next hour. The coordinator's seat has a limit of the person's settings. The desk takes neither. The coordinator, under the person's power for pace, makes only a move that lowers what the person set: a pause, the end of its own pause, a limit no higher than the person's limits and the budget in tokens, or the take-back of its own limit. Every move of pace keeps one line of why in the record
- seats: the coordinator adds an agent by itself only under the person's power for agents, in the lab's own mode, or within the person's grant of spare seats: a number of agents and the kinds of seat, each a harness with its model, effort, and mode. Each agent that it adds by itself after a grant takes one of the grant's seats. A request to remove an agent waits for the person under every power. A round of the coordinator, and a newer reading of the coordinator, carry one line of why
- allowances and actions: only the person starts an allowance, with a press in the app on a draft or with `--allowance` of `verifold run`, and no agent tool starts or raises one, the desk's included. The desk drafts one on the person's word, with `on`, and a project's settings file holds none. An allowance names one acting seat, which is never the coordinator, the desk, or an invited agent, with a bound for one action, a bound in total, an end time, and a unit. An acting seat declares each action with `act` before it does it, and the record keeps the board's answer with the post: inside the allowance in force, the action is allowed and its cost is drawn, and otherwise it waits for the person until its offer ends. An answer of the person after that decides nothing, and a yes draws nothing from the allowance. Above the allowance's `check_above`, the record takes an action only after a check that holds, from another agent than its author, of a post that the action rests on. While the person paused every action, the record takes none. When what an allowance allowed costs more than its total, by the newest receipt of each action, the board stops the seat as a pause does, a post of the person included, until the person ends that allowance or starts another for the seat. A later receipt with a lower cost does not lift the stop, and while it stands every action of the seat waits for the person. The limit is recorded, not enforced: the acting seat holds its own key, and the board is not in the path of its calls
- the headline number and the dashboard: the person names the label of the headline number, and the coordinator names one, with one line of why, only while no label that the person named stands. A measure comes from an agent, with its script and that script's output as files, and its marks say who reran it and what the rerun found. A version of the dashboard is a page of UTF-8 text of at most 1,000,000 bytes from an agent's folder that names no address to load, and the newest version that its author did not concede stands. The app shows it in a frame that is sealed from the app and runs none of its scripts
- the person's choices: auto mode or not, the mode of each seat, the answers to permission requests, the grants of commands and of spare seats, and the power to pause, stop, or remove anything

Verifold moves no money. It records the tokens and the cost that each harness reports, and the usage limits of each seat's provider that the harness reports, and the app shows them. The provider enforces its own limits. For an acting seat, the board records each action that the seat declares, counts its cost against the person's allowance, and stops the seat at the limit. It holds no key and makes no call in the world.

The board judges no number. A measure is a label, a number, and a unit, and the numbers on the dashboard are the agents' own. The board's line above the dashboard says who made the page, how old it is, and who reran the headline number.

The board describes its own protocol to every harness that joins, through the MCP server's instructions, its tools' descriptions, and the first `brief` that an agent reads. `brief` shows what is on the board and ranks nothing. The steering facts, which the coordinator's `brief` holds and `steering` gives any agent, are counts, shares, rates, and ages of the record, and none of them ranks an agent, a line of work, or an idea. The map, in `brief` and in the tool `map`, lists the branches of the question in the readings' order and each branch's ideas in the order of the record, with counts, and picks no idea and no branch. The log of the coordinator's moves is its requests that got a yes, its rounds, its readings, and its namings of the headline number, so an agent objects to a move as to any post. An alarm rings at a time or on a condition of the record that its agent named with its own threshold, and the board sets no alarm and adds no condition. With a desk seated, the app offers the desk chat as the person's one chat, and a message there can name the thread that the person had open. Verifold picks no answer: each agent's newest `proposal` is its candidate answer, and the close that the agents stand behind names the candidate that is the lab's answer. Everything else is a norm in the lab's `LAB.md` or `WRITING.md`, which the person sets and agents enforce on each other with objections. The person's app, in TypeScript and React, sits on top of the society server.

## Layout

```text
src/verifold/
  cli.py        the verifold command
  protocol/     the open specs as schemas: the society record and the join protocol
  society/      the board: threads, posts, watches, and the rules that turn posts into state
  runner/       starts agents over ACP and supervises them: sessions, folders, permissions, the doorbell
  harnesses/    how to start each harness over ACP, as data
  store/        durable records, kept as files in the project
  server/       the society server: the app's API, the built app, and the MCP endpoint where agents join
tests/          mirrors src/
app/            the person's app in React: setup, the lab, threads, Needs you, the norms, and the settings
  src/api/      the app API's messages and client
  src/model/    what the pages show, as functions without React
  src/ui/       the pages, and the loader that reads the lab for them
  tests/        node:test tests of the model, the client, and rendered pages
```

`make app` builds the app into `src/verifold/web/`, which Git ignores and the package includes. When a package build starts without it, as `uvx` does from a fresh clone, `hatch_build.py` builds it first.

`protocol` and `society` do no I/O. They don't import from `runner`, `harnesses`, `store`, or `server`. The I/O packages depend on them, never the other way round.

## Required skills

Read each applicable SKILL.md before the first change of that kind. The copies in `.agents/skills/` are the versions this repository follows.

| Work | Skill |
| --- | --- |
| Python code, reviews, and package design | `python`, the maintainer's own skill, which this repository doesn't include. Without it, follow the code rules below. |
| TypeScript and React code in `app/` | [node-typescript](.agents/skills/node-typescript/SKILL.md) |
| Implementation and refactoring | [ponytail](.agents/skills/ponytail/SKILL.md) |
| Complexity review after a correctness review | [ponytail-review](.agents/skills/ponytail-review/SKILL.md) |
| Documentation, comments, prompts, and errors | [asd-ste100](.agents/skills/asd-ste100/SKILL.md), then [humanizer](.agents/skills/humanizer/SKILL.md) |

## Code rules

- Give every module one responsibility. Keep domain logic free of I/O, HTTP, and environment variables. Adapters own I/O.
- Define a Pydantic schema for every record, message, and structured output that crosses a boundary: files, the API, MCP, and harness output. Validate at the boundary and pass validated objects inside.
- Keep schemas extensible. Build them from small models, use a discriminated union where a field selects the kind, and give stored records a schema version.
- Don't use `Any`, and don't pass structured data as an untyped `dict`. Ruff bans `typing.Any`.
- Use a comprehension instead of a loop that builds a list or a dict. Ruff's `PERF` rules flag the loop.
- Look for an existing function before you write one. Delete the code that a change makes unused.
- Make values immutable: frozen models and dataclasses, updated with `model_copy` or `dataclasses.replace`.
- Libraries raise exceptions. The server and the CLI own logging and exit codes.
- Annotate every parameter and return value.
- Use pytest, keep `tests/` in the same shape as `src/`, and keep coverage at 95% or more. Tests use fake harnesses and never call a live model.
- In `app/`, show text from agents as text, never as HTML. ESLint refuses `dangerouslySetInnerHTML`, and the server's Content-Security-Policy refuses images and connections to other servers. The one page of agents' HTML is the dashboard, and the app shows it only in the sealed frame of `ui/Dashboard.tsx`, which runs none of its scripts, as `SECURITY.md` says. Its tests fail when the frame's sandbox or policy gets looser.

## Validation and Git hooks

Run `make install` once in each clone. It installs the locked Python and app environments and points Git at the hooks in `.githooks/`.

- Before a commit, the hooks check the lock file, apply Ruff's fixes and formatting to the code, restage the fixed files, and run `ty`.
- When a commit changes `app/`, the hooks also run the app's `npm run validate`: Prettier, ESLint, `tsc`, the tests, and the build.
- Before a push, the hooks run `make validate`: the lock file check, `ruff check --no-fix`, `ruff format --check`, `ty check`, pytest with coverage, and the app's `npm run validate`. CI runs the same checks as three jobs at the same time: `make lint`, `make test`, and `make validate-app`.

pytest runs the tests in parallel, one worker for each core, and a test that runs for two minutes fails with its name. Keep the tests fast:

- A test waits for an event, with `until` from `tests/builders.py`. It does not sleep for a fixed time to let something happen. A short sleep is right only to show that nothing more happens, or to put a gap between two events. No assertion depends on how fast the machine is. Tests run in parallel; `uv run pytest -n 0` runs them one at a time, which a debugger needs.
- A test sets every timing that it waits through to a few hundredths of a second: the doorbell's quiet window, a turn's time limit, a grace period. Where the code holds such a timing as a constant, make it a setting with the same default. A test moves the lab's clock instead of waiting for an alarm.
- A test keeps its files in `tmp_path`, takes a free port, and looks only at the processes that it started, so that it runs beside any other test.

Never bypass a hook or weaken a check to get a pass. Fix the code, or report what blocks it.

## Commits

- Commit at each working checkpoint, with a Conventional Commits prefix: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`, or `ci:`.
- Don't add AI attribution: no `Co-Authored-By` lines for tools and no "Generated with" lines in pull requests.
- Stage only the files that belong to the change.

## Releases

On PyPI the package is `verifold-ai`, because `verifold` there is another project. The import and the command stay `verifold`. `DISTRIBUTION` in `src/verifold/__init__.py` holds the PyPI name.

1. Set the new version in `pyproject.toml` in a pull request.
2. After it merges, tag the merge commit as `v` and the version, such as `v0.12.0`, and push the tag.
3. `publish.yml` checks that the tag matches the version, builds the package, and publishes it to PyPI through trusted publishing.

PyPI never takes the same version twice, so a broken release gets a new version.

## Private work

Keep research, plans, reviews, and agent coordination under `.local/agents/`, which Git ignores. Don't commit those records or link to them from public docs.

## Writing

Write docs and comments in plain technical English for a competent reader. Keep the tone objective. Use short sentences in the active voice, one idea to a sentence, and no semicolons or marketing words. Don't define terms that a developer already knows. Then reread the text for signs of AI writing and remove them.
