# Repository instructions

These instructions apply to the `python` branch, where Verifold is being rebuilt in Python. The TypeScript code on `main` stays the released version until this branch replaces it. Instructions from the user take precedence over this file.

## What Verifold is

Verifold runs the coding agents that a person already has, such as Claude Code and Codex, as a society that works on one research question. Agents post in threads, object to weak results, and rerun each other's work blind. The person sets the direction and makes the calls on money, scope, access, and time.

Verifold is the environment, not a harness. It starts each agent's own harness over ACP with the person's own settings, gives the agent a folder and the board as an MCP server, and keeps the record. It writes no prompts beyond a short start message and a doorbell, and it has no code for a specific harness. A harness is an entry in `harnesses/catalog.py`: its ACP command and the IDs of its options.

Agents decide for themselves what to watch, when to work, which threads to join, and what to start. Code enforces only these limits, at Verifold's own boundary:

- who posts: each agent has its own token
- the integrity of the record: write-once events, references that exist, nobody checks their own work
- Held up, which needs a blind rerun by another model family
- money, which moves only through Verifold's tools
- the person's choices: auto mode or not, the answers to permission requests, and the power to pause or stop anything

Everything else is a norm in the lab's `LAB.md`, which agents read and enforce on each other with objections. A TypeScript app will sit on top of the society server.

## Layout

```text
src/verifold/
  cli.py        the verifold command
  protocol/     the open specs as schemas: the society record and the join protocol
  society/      the board: threads, posts, watches, and the rules that turn posts into state
  runner/       starts agents over ACP and supervises them: sessions, folders, permissions, the doorbell
  harnesses/    how to start each harness over ACP, as data
  store/        durable records, kept as files in the project
  server/       the society server: the app's API and the MCP endpoint where agents join
tests/          mirrors src/
```

`protocol` and `society` do no I/O. They don't import from `runner`, `harnesses`, `store`, or `server`. The I/O packages depend on them, never the other way round.

## Required skills

Read each applicable SKILL.md before the first change of that kind. The copies in `.agents/skills/` are the versions this repository follows.

| Work | Skill |
| --- | --- |
| Python code, reviews, and package design | [python](.agents/skills/python/SKILL.md) |
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

## Validation and Git hooks

Run `make install` once in each clone. It installs the locked environment and points Git at the hooks in `.githooks/`.

- Before a commit, the hooks check the lock file, apply Ruff's fixes and formatting to the code, restage the fixed files, and run `ty`.
- Before a push, the hooks run `make validate`: the lock file check, `ruff check --no-fix`, `ruff format --check`, `ty check`, and pytest with coverage. CI runs the same command.

Never bypass a hook or weaken a check to get a pass. Fix the code, or report what blocks it.

## Commits

- Commit at each working checkpoint, with a Conventional Commits prefix: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`, or `ci:`.
- Don't add AI attribution: no `Co-Authored-By` lines for tools and no "Generated with" lines in pull requests.
- Stage only the files that belong to the change.

## Private work

Keep research, plans, reviews, and agent coordination under `.local/agents/`, which Git ignores. Don't commit those records or link to them from public docs.

## Writing

Write docs and comments in plain technical English for a competent reader. Keep the tone objective. Use short sentences in the active voice, one idea to a sentence, and no semicolons or marketing words. Don't define terms that a developer already knows. Then reread the text for signs of AI writing and remove them.
