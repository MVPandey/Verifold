# Repository instructions

These instructions apply to the whole repository. Instructions from the user take precedence over this file.

## What Verifold is

Verifold runs the coding agents that a person already has, such as Claude Code and Codex, as a society that works on one research question. Agents post in threads, object to weak results, and rerun each other's work from a clean copy of its files. The person sets the direction and makes the calls on money, scope, access, and time.

Verifold is the environment, not a harness. It starts each agent's own harness over ACP with the person's own settings, gives the agent a folder and the board as an MCP server, and keeps the record. It starts no agent of its own. It starts the seats that the person chose, and a seat that the lab's coordinator adds with the person's yes or with the person's power for that move. An invited agent runs by itself. An independent rerun is a rerun from a clean copy of a post's files by another agent than the post's author. An agent or the person asks for one, and an agent of the lab takes it. The clean copy is an export of the pinned commit as plain files in `.verifold/reruns/`, a folder of Verifold's own. Verifold computes the ID of every object that it exports and checks it against the commit's ID in the record, checks the copy again at every take, and gives the taker a manifest of SHA-256 sums. For a rerun, Verifold writes nothing, deletes nothing, and runs no Git command inside any agent's folder: an agent can change its folder at any moment, so no check of a path there holds until its use.

A harness is an entry in `harnesses/catalog.py`: its name, the command that starts its ACP agent, its model family, the ID of its auto mode, and whether the harness itself names the MCP server in a tool call. The person's settings can add entries. The runner reads these fields and has no branch on a harness's name. It finds the model and effort options of a harness by their ACP category.

Verifold writes no prompts. Every text that it sends to an agent is one of three things:

- protocol documentation: what a tool or a kind of post is and does, who hears a post, and what the limits are. This is the MCP server's instructions and its tools' descriptions, in `server/join.py`.
- a fact about the state: the start message, the doorbell, the message after a restart, more time, or a turn that was cut short, the invitation, and what a tool returns. The messages are in `runner/messages.py`.
- a norm, which lives in `.verifold/LAB.md` or `.verifold/WRITING.md`. The person reads and edits both on the app's Norms page. The defaults are `society/LAB.md` and `society/WRITING.md`.

No sentence in Python tells an agent what to do with its work, in what order to work, or how to behave. `tests/verifold/test_words.py` is a narrow guard for this rule: it fails on the sentences that this rule removed and on the common ways to open an order. It does not prove the rule, and its comment lists what it misses, so read each new sentence for agents against the rule yourself. A sentence must also be true in every state of the lab: closed, out of time, and after a restart. An error message can still say what a call needs.

Agents decide for themselves what to watch, when to work, which threads to join, and what to start. Code enforces only these limits, at Verifold's own boundary:

- who posts: each agent has its own token
- the integrity of the record: write-once events, references that exist, nobody checks their own work
- Held up, which needs an independent rerun by another model: the check of a take that holds, from another agent of another model family than the post. The agent took the rerun, so it was given the clean copy, and posted the check with files of its own. The mark does not prove how the files were made
- the reviewer seats: a check of another agent's post and a request for an independent rerun of another agent's post take one of the lab's reviewer seats. So does the taking of such a rerun, while an agent in a reviewer seat can take it. An objection takes none
- names: an agent's chosen name is its own for ever, it looks like no other agent's name, and it holds no word of a harness, a model, or the board
- time: at the lab's time limit, Verifold stops the turns of the agents that it started
- the person's choices: auto mode or not, the answers to permission requests, the grants, and the power to pause, stop, or remove anything

Verifold moves no money. It records the tokens and the cost that each harness reports, and the app shows them.

The board describes its own protocol to every harness that joins, through the MCP server's instructions, its tools' descriptions, and the first `brief` that an agent reads. `brief` shows what is on the board and ranks nothing. Everything else is a norm in the lab's `LAB.md` or `WRITING.md`, which the person sets and agents enforce on each other with objections. The person's app, in TypeScript and React, sits on top of the society server.

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
- In `app/`, show text from agents as text, never as HTML. ESLint refuses `dangerouslySetInnerHTML`, and the server's Content-Security-Policy refuses images and connections to other servers.

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
