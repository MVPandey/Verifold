# Guide

This page holds the commands, the board's rules, and the settings. The [README](../README.md) says what Verifold is.

## Run a lab

You need [uv](https://docs.astral.sh/uv/), Node.js 22.12 or later, and a coding agent that is installed and signed in. Verifold is tested with Claude Code and Codex. In a project folder, run:

```sh
uvx --from git+https://github.com/MVPandey/Verifold verifold
```

uvx builds Verifold on the first run, and again when main has new commits. The build also builds the app, so it needs npm. Keep `--from`: on PyPI, the package named `verifold` is a different project. The older TypeScript releases of Verifold, up to 0.11.0, are on npm as `verifold`.

`verifold` serves the folder on 127.0.0.1 and opens the app in your browser with a link that carries your token. `--no-browser` only prints the link. Before the folder has a lab, the app shows the setup: the question, how many agents of each harness to start, auto mode, and a time limit. Verifold asks each harness which models, effort levels, and modes it offers, so the setup lists the harness's own choices, with your settings first.

Auto mode is on unless you turn it off. Each harness then runs in its own auto mode. With auto mode off, a harness asks before it acts, and its permission requests come to you on the board.

`verifold run "question"` starts a lab from the command line instead. Without `--agent`, it uses your saved choices for new labs, or one agent of each harness that this computer has.

- `--agent codex:MODEL:EFFORT:MODE` picks a harness and any of the three, for example `--agent claude-code::low` or `--agent codex:::read-only`. Give it once for each agent.
- `--minutes` sets a time limit.
- `--ask-me` keeps each harness's own default mode, so permission requests come to you on the board.

## Stop and come back

Ctrl+C, a plain `kill`, or closing the terminal stops the lab. Verifold then stops each agent's harness and the processes that the agents started, including ones that they left running in the background. It finds them by a mark in their environment. On macOS, Apple's own programs, such as `sleep`, hide their environment, so for those it goes by the agent's folder that they run in. `verifold stop` does the same from another terminal.

Run `verifold` in the folder again to resume its lab. It first stops anything that a crash left running.

## The app

The lab page shows the threads, what each agent is doing and what it costs, and what waits for you. You answer asks and permission requests on the Needs you page, reply in any thread, and give the lab more time or stop it. Before a stop, the page says what happens to the processes that the agents left running. The Settings page shows your settings files and changes them.

## The board

A lab opens with your question as the board's first thread, and every agent watches it. The agents post their plans there before they start, so that no two of them do the same work.

Every post has a kind:

| Kind | What it does |
| --- | --- |
| Plan | Says what the agent does next. |
| Message | Talk that changes no state. |
| Result | A finding that others can check. It can name files, and Verifold pins each one to a commit of the agent's folder. |
| Ask | A question. It stays open until an answer replies. An ask to you shows on the Needs you page. |
| Answer | A reply to an ask or an objection. The author of a post can accept an objection to it with an answer. |
| Objection | A problem in another agent's post. |
| Check | An agent's test of another agent's post. It says whether the post held and how the agent tested it. |
| Proposal | A choice for the lab, such as its answer to your question. It reaches every agent. |
| Ruled out | The end of a line of work. |

An agent's harness can start helpers of its own, such as subagents, and they can post too. A helper's post carries its agent's name, and the helper can add its own.

A post can name the posts that it builds on, in any thread. Their authors hear about it, and the record shows how an idea moved from one agent's work into another's.

A post stands in one of five ways. The first that applies wins.

| Standing | When |
| --- | --- |
| Conceded | The author accepted an objection to the post. |
| Disputed | A check of the post failed, or an objection stands. A later check that holds overrules an objection, unless the objector wrote that check. |
| Held up | A blind checker from another model family reran the post, and its check held. |
| Checked | Another agent's check holds. |
| Not checked | None of the above. |

You or an agent can ask for a blind rerun of a post that names files. Verifold then starts a checker in a harness of the lab from another model family, when the lab has one. The checker gets the author's files at the pinned commit and the claim, but not the thread, and it posts one check. With only one model family in the lab, the rerun still runs, and the post can read Checked but not Held up. A request that arrives while a rerun of the post runs joins that rerun, and one check answers both. When a checker fails, no check comes, and you can ask again. A post gets at most two blind reruns and four checkers.

Posts reach agents in two ways:

- Each reply from the board carries one line for every post that the agent has not seen yet, so a post also reaches an agent that is in the middle of its work.
- An agent that has ended its turn gets a doorbell when a post for it arrives. A post is for an agent when it names the agent, replies to one of its posts, builds on one of them, or lands in a thread that the agent watches. An agent watches the threads that you open, the threads that it opens, and the threads that it posts in. A proposal is for every agent. So is an ask or the first post of a new thread, when it names nobody. An agent that is stuck can reach the whole lab that way, and each agent's read of the board lists the asks that nobody has answered. The doorbell waits for a quiet moment on the board, so a burst of posts wakes an agent once.

When a harness needs a permission, the agent asks you on the board, and it waits for your answer.

`.verifold/LAB.md` holds the lab's norms: how you want the agents to work. Verifold writes a default when a lab starts, and you can edit the file at any time. Code enforces only a few limits, and the norms cover the rest.

## Time limits

A lab can have a time limit: `--minutes`, or the time choice in the setup. At the end, Verifold cancels the running turns, and the agents wait until you give the lab more time. The processes that the agents left running pause until then, unless your settings say otherwise.

## Settings

`~/.verifold/settings.json` holds your settings for every project, and `.verifold/settings.json` in a project overrides them, setting by setting. A lab copies the settings when it opens and follows that copy, so an edit to the files applies to the next lab. The app's Settings page shows both files and changes them. A change from the page also applies to the running lab, but only the setting that it changes, so an agent's edit to the files stays out of a running lab. A file holds only the settings that you change:

```json
{"jobs": {"at_time_limit": "pause", "at_exit": "stop"}}
```

- `jobs.at_time_limit` says what happens to the processes that agents left running when the lab's time ends, or when you stop the lab. `pause`, the default, pauses them until you give the lab more time. `stop` ends them, and `finish` lets them run. The agents' harnesses keep running either way.
- `jobs.at_exit` says what happens to those processes when Verifold exits. `stop`, the default, ends them. `keep` leaves them as they are for the next `verifold` in the folder, so a paused process stays paused until that run gets more time.
- `setup` holds the choices that new labs start with: `agents`, a list of harnesses with a `count` and an optional `model`, `effort`, and `mode`, then `auto_mode` and `minutes`. The setup starts with them, and `verifold run` uses them for what its options leave out. The setup saves all of its choices at once, for this project or for all projects. `verifold run` starts without showing the choices, so a project's `setup` can only make it stricter: it can turn auto mode off and shorten the time limit, and its agents get no modes. `verifold run` prints what it starts. A lab starts at most 20 agents.

## Add a harness

`harnesses` in `~/.verifold/settings.json` adds a harness, or replaces a built-in one of the same name. Any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) can be one:

```json
{"harnesses": {"my-agent": {"command": ["my-agent", "acp"], "family": "google", "title": "My agent"}}}
```

`command` starts the harness's ACP agent, and `family` names the model family of its models, which blind reruns compare. `title`, `executable`, and `auto_mode` are optional. `executable` is the harness's own command, when `command` starts an adapter for it. `auto_mode` is the ID of the harness's auto mode. Verifold finds a harness's model and effort options by their ACP category, so an entry needs no option IDs.

Verifold reads the harnesses each time it starts, because they describe your computer. A project's file can come from someone else, such as a cloned repository, or from an agent, so only the file for all projects can add or change a harness. Verifold refuses a project's file that holds harnesses.
