# Verifold guide

This guide describes what works in the current source checkout. The [README](../README.md) explains what Verifold is for.

Run `verifold` to connect the Claude Code or Codex that you have installed. You can review optional personal background and choose a project folder. Before your harness asks follow-up questions, you can give it existing work, a written brief, or notes. Verifold saves the brief that you reviewed and the research records. Then it opens a local desk in your browser, where you follow the research and the team.

We're building toward a research **meta-harness**: one workspace where several harness instances work together, from the first idea to a paper, a repository, a figure, a proof, or another result. Each harness keeps its own credentials, tools, and permissions. Verifold picks the model of the lab's agents unless you name one. Verifold connects their tasks, messages, memory, and evidence across sessions. The [development plan](#development-plan) says what is done and what comes next.

Contents: [Install](#install-the-cli) · [Start a research project](#start-a-research-project) · [The desk](#local-research-desk) · [Sessions](#controlled-harness-session) · [Tasks](#scoped-tasks) · [Coordinator](#coordinator) · [The lab](#the-lab-preview) · [GPU pods](#gpu-pods-on-runpod) · [Privacy](#privacy) · [Project status](#project-status) · [Development plan](#development-plan) · [Contribute](#help-build-verifold) · [Build from source](#build-from-source) · [Engineering](#engineering)

## Install the CLI

You need Node 22, 24, or 26 (the latest patch release of that major) and a Claude Code or Codex harness that is installed and signed in:

```sh
npm install -g verifold
verifold
```

You can also run `npx verifold`, or install Verifold in a project with `npm install verifold`. A local install runs through `npx verifold`.

Verifold starts your harness with its own configuration and permissions. The agents that the desk runs are the exception: they load none of your MCP servers or connected apps. See [security boundaries](../SECURITY.md).

## Start a research project

Run `verifold` in your terminal.

- In a folder that is already a Verifold project, Verifold opens the project's lab in your browser. This does not change the harness or the research that the project saved. A project whose current run is from the earlier research flow opens in the old desk instead, and the terminal says so. The app shows that run read-only in History, and `verifold --app` opens the app there.
- In a folder without a project, Verifold opens the first run in your browser (see The first run in the app), then the Ask page. Start on the Ask page creates the project and starts a lab on your question (see The lab).

The team works in a background process, so you can close the terminal or press Ctrl+C, and the work goes on. Run `verifold` in the project again to see it, or `verifold stop` to stop it. Stop the team in the top bar of the old desk does the same.

`verifold --desk` opens the old desk instead of the app, for this release. In that terminal, `/open` and Enter on an empty line open the old desk too. In a folder without a project, `verifold --desk` opens setup in the old desk. A Verifold without the app's build, such as a checkout that was not built, does the same for a bare `verifold`. It asks one thing at a time: your question, up to three quick questions, and the brief. The earlier steps go into the setup log. The terminal shows each step as one line. Ctrl+C during setup cancels it and saves nothing. When setup ends, a background process takes over the project, and the same browser tab shows the lab while its first agent reads the question.

`verifold init`, `verifold --desk --no-open`, and runs without a terminal do setup in the terminal instead. Both paths run the same setup, with the same consent steps, file limits, and retries. After setup in the terminal, `verifold --desk --no-open` starts a lab too. Use `verifold init` to do setup and research entirely in the CLI, without a lab. A bare `verifold` needs an interactive terminal. `verifold --no-open` prints the URL and does not open a browser.

Run later commands from the project folder, or add `--workspace <path>`:

```sh
verifold research --feedback "Focus on methods that run on one GPU."
verifold research --approve
verifold status
verifold select
```

The first question is "What do you want to find out?". One line under it names the team, the model of its lead, and the folder.

- The team is one harness, or a lead and a helper. It is your saved team, or Claude Code with its default model. When both harness commands are on your PATH, Codex helps by default.
- The folder is the one where you started Verifold.
- To change them, type `/settings` in the terminal, or choose Change the settings in the desk. The settings mark a team whose command is not on your PATH.

Verifold does not check the sign-in. A harness that is not signed in fails at its first run and says why. Verifold remembers the team and the model in a private global agency folder. Setup does not ask for a profile, but it uses a saved profile as background. `verifold profile --setup` and `verifold init --setup-only` create one.

Your harness then asks up to three quick questions, one at a time. It uses your answers and any saved background. Each question ends with two or three suggested answers. Choose one (in the terminal, type its number), write your own answer, or press Enter to skip the other questions. The prompt asks only about what changes the research plan, and it records other unknowns as open points. The agent writes Markdown, not a required JSON brief. A failed turn has one explicit retry. If a reply fails, retry with your answers intact, or review a local brief made from those answers.

`--workspace path` gives the folder directly. At the question, enter `/file <path>` to give a written brief. Verifold asks before it reads the file, reads up to 12000 bytes, and sends them to your harness. If it cannot read the file, it says why and continues setup with the context that it has. Press Enter without a question to let your harness help find a direction from that context. When the folder has files, Verifold asks before your harness reads them.

The brief is about 120 words: the question, why it matters, what counts as an answer, constraints, and open points. Press Enter to accept it, enter feedback to revise it, or type `/cancel` to stop. In the desk, you can also edit the brief and accept your version.

Research runs without a stop unless you ask for one, in the settings of `verifold init` or with `--autonomy guided`. A bare `verifold` starts a lab after setup, and a lab has no stop before its work, so its settings do not offer one. Relative paths resolve against the folder where you started Verifold, and the interactive path also accepts `~/`. Verifold creates missing folders and keeps what a folder already holds. It refuses conflicting files, an existing `.verifold.md`, and linked scaffold folders.

Every new project gets:

```text
project/
  .verifold.md   Research brief, folder guide, and continuation commands
  .verifold/     Private state, research attempts, and source reports
  literature/   Papers, source notes, and provenance
  experiments/  Reproducible code and configurations
  results/      Raw outputs, metrics, and negative results
  figures/      Plots and regeneration scripts
  docs/         Plans, decisions, methods, and write-ups
  agents/       Project agent briefs and review notes
```

If the folder already holds work, Verifold offers a harness investigation before the interview:

- With your consent, Verifold gives your harness a bounded selection of top-level documentation and manifests. Your harness can look at relevant paper, code, and result files, search the web, and use its own agents. The request forbids edits, experiments, installs, and downloads.
- You review the context before the interview. If you decline it, or the investigation fails, your original brief stays.
- Accepted context stays in the project's `.verifold.md` and workspace state, not in your personal profile. The interview that follows can use the same tools in the project.

These prompts guide the harness, and its own permissions do the enforcing. Every setup, research, coordinator, and task prompt tells the agent to look for local files only in its folder (the project folder, or the task folder for a task agent), unless you ask for more.

Interviews on a topic alone can also use the harness's own web search. They run in an empty private folder, never in the folder where you started `verifold`, and Verifold removes that folder after setup. If local context would help, the harness asks which files or folders it may look at. A folder that you decline stays out unless you allow it later. Interviews for a personal profile use only the answers that you give.

Verifold starts your harness in a background CLI session. The terminal shows the step and how long it takes. The desk shows the harness events and the full transcript of each run. Claude Code also reports its model and session when it can. Tools that need interactive permission can be denied in this mode. Verifold reports Claude permission denials and, when it can, a `claude --resume <session-id>` command, so you can review the permissions in the harness itself. Verifold does not bypass approvals. A tool or agent that the harness asked for is not proof that it finished.

The approved brief feeds planning and research in the project folder. It belongs to the project: setup does not turn it into a reusable personal profile. Run later commands from that folder, or pass `--workspace path`.

In the harness and research-mode menus, use the arrow keys or the number keys. Press Enter to accept, or Escape to cancel. Simple terminals offer numbered text prompts.

When you have no approved background and no earlier setup outcome, interactive setup offers an optional profile step after you choose the harness and before you choose the project. Verifold remembers a skipped, declined, or failed setup, so later launches do not repeat it on their own. Choose "Ask my harness to review my chats" to let your harness look at a local history source that you choose and draft research context. The prompt suggests the harness's usual local session folder. You can choose a narrower folder or an export instead. This gives no access to cloud chats, and earlier conversations may not be there. You can also import a bounded chat sample or one memory file, write an introduction locally, or skip. `init --setup-only` also offers an agent interview.

Verifold asks before it reads an import and sends the text to the harness. You review the Markdown before Verifold saves it as `~/.verifold/agency/USER.md`. `settings.json` stores the harness preferences. `--agency-dir path` chooses an empty folder or an existing Verifold agency.

Later setups reuse this approved background. They do not ask the profile questions again or read the source again. Edit or delete `USER.md` to change what later setups reuse. Existing project briefs and host records stay. Deleting `USER.md` stops the reuse and does not start another history import.

"Import a sample of my chats" looks at no more than 200 folder entries and ten files, with at most 256 KB for each file and 512 KB in total. It skips links, hidden subfolders, files that are too large, and native records that it does not support. Native JSONL imports keep the user messages that it recognizes, without model responses, tool results, or subagent folders. User messages can still include context that the harness added, so review what the profile infers. Plain text and JSON exports go in as you chose them. The harness option picks the relevant conversations in the source that you chose and reports what it covered. Its own permissions control what it can read. Both options show the full draft for review before Verifold saves `USER.md`. Local storage does not mean that the model runs offline.

The coordinator proposes a search scope and personas. Research then searches without a stop. If you asked for a stop before the source search (in the settings of `verifold init`, or with `--autonomy guided`), research waits for you to approve that plan:

- In the desk, approve the plan, or write your changes to research in the message box.
- In the terminal that runs the desk, type `/approve`, or `/feedback` and your changes.
- Without a running desk, use `research --feedback` to revise the plan, then `research --approve` to continue.

The harness researches the approved scope and returns sources and directions. The desk shows the report and its sources. The terminal prints only the number of directions. The first research needs no PDF downloads.

After the directions are ready, use `research --feedback` to refine them through the saved coordinator session. `select` asks for an explicit idea ID. Without a terminal, use `select --id <idea-id>`. Selecting a direction does not start a pilot or an experiment.

Autonomous mode runs planning and research without a stop, then stops at the directions. It keeps the host's tool permissions.

Interactive `init` and `research` show readable results and next steps. Runs without a terminal, and `status`, return JSON. Interactive mode needs a terminal on stdin and stderr. Use `status` to pipe saved state to another tool.

Setup without a terminal needs explicit research inputs: `--topic`, `--host`, and `--autonomy autonomous`. The harness drafts a brief, with unknowns, from these inputs. Then it plans and researches without an interview or a review of the brief:

```sh
verifold init --host claude --topic "Efficient graph algorithms" --autonomy autonomous
# Optional: --model <host-model-id> --agency-dir <private-directory>
```

Use `--host codex` for Codex. Paths resolve against the current folder. Add `--workspace <path>` to choose another project folder.

### Setup and request commands

Use `init --setup-only` to save harness preferences, and optionally review context, without starting research. Existing `--profile profile.json` imports still work, as legacy profiles for one project:

```sh
verifold init --setup-only --profile profile.json --host codex
verifold recommend
verifold ideas --from ideas.json
verifold select
verifold literature --memory
verifold handoff
verifold view
```

`recommend` prints a request for the host. `ideas --from` imports an array with `id`, `title`, `recommendation`, and a nonempty `checks` array. It also accepts an older `gates` array.

After you select a direction, `literature` prints an optional retention request. `--memory` also asks for a Markdown memory file that maps each source to its file. Both forms only print instructions. They do not start the harness or check downloads. Official citation exports must stay separate from generated summaries.

`handoff` prints a request to plan a pilot, for the host and Automative. You must approve the scope, the evaluator, the budget, and the checks before anything runs. This version of Verifold does not run Automative.

### Manage your global profile

Run `verifold profile` to see the full approved Markdown, its path, and its status. Outside an interactive terminal, the command returns JSON. It reads only Verifold's global records. It creates no folder and starts no harness.

Run `verifold profile --setup` to create, retry, or revise a profile without setting up a project. Setup needs an interactive terminal, for your consent to the source and for your review. Use `--host claude|codex`, `--model <id>`, or `--agency-dir <path>` when you need them. These settings are global. Existing project settings do not change.

`USER.md` decides which background later setups can reuse. `profile-state.json` records the outcome of the last setup separately. If you decline a replacement, or a draft fails, the approved profile stays. `verifold profile` reports when the approved file was deleted. Verifold saves the harness preference when setup starts. Cancelling keeps the previous profile and setup outcome, but it does not undo that preference.

Profile setup and initialization share a lock on the global settings, so only one of them can change an agency at a time. If that process is killed, the error names `profile.lock`. Make sure that no setup runs before you remove it. Drafts still need your review before Verifold uses them. Choosing several history sources is planned.

### The first run in the app

`verifold` in a folder without a project opens the first run in the app. No project starts until you ask a question on the Ask page, and Ctrl+C in the terminal stops it. There are four steps, and you can skip each one:

1. **Agents.** Claude Code and Codex, each with its version, its sign-in, and a model. Verifold reads only the sign-in state and the plan from `claude auth status` and `codex login status`, never the account's email. It offers Fable only on a plan that includes it.
2. **About you.** Verifold asks what you work on. Your agent, with the model that you picked, asks up to two more questions in an empty private folder, then drafts a card: "You work on", "To explore", and "Talk to me". Edit the card, or add a note and the agent changes it. Verifold saves the card as `USER.md`. Without a signed-in agent, Verifold asks the questions and fills the card from your answers.
3. **Skills.** Verifold reads six public skill catalogs on GitHub and matches their skills to your card. Your agent picks up to three, with no tools and no web search, because the catalogs' text comes from outside. Each card shows the source pinned to a commit, the license, and what the skill can run, which Verifold finds in its files. Verifold never offers a skill with hooks, with shell commands that its Markdown runs when it loads, with MCP or LSP server settings, with binary files or links, or with more than 200 files or 5 MB. Nothing installs until you click Add.
4. **GPU money.** The RunPod key, RunPod's prices now, the GPUs that agents may rent, and the limits for new projects. The key goes to the keyring through the same check as `verifold runpod key set`. "No GPUs for now" keeps pods off.

`settings.json` keeps the agents in the fields that older versions read, and adds the GPU limits and the steps that you finished or skipped. A new project copies the harnesses and the GPU limits. The planner of each lab reads your whole profile. Every other agent, and each checker, gets only "Talk to me". An edit reaches a running lab with its next prompt. Open these pages again with Profile in the app's top bar.

`skills.json` lists the skills that you added, each with its repository, commit, folder, and tree hash. Verifold keeps each one read-only in `skills/` in the same folder, without its `allowed-tools`. Only lab agents and checkers load them, from a read-only copy in `~/.verifold/plugins/`, outside the profile folder: Claude Code with `--plugin-dir`, and Codex as an extra skill root of the session's own app-server, with `skill_mcp_dependency_install` off. Your own Claude Code and Codex settings do not change. When a catalog changes a skill that you added, the step offers Update, and the new version installs only when you click it.

### Editable harness prompts

Harness instructions live in the `prompts/` folder of the layer that uses them: `src/core/prompts/` for the lab, `src/cli/prompts/` for setup, the profile and the CLI's research commands, and `src/legacy/prompts/` for the older research and task flows. Each filename is a prompt ID. Each layer lists its IDs in its own `prompts.ts`, which reads the files through the shared reader in `src/core/prompts.ts`. Edit these files to change the instructions for interviews, profiles, project context, research, or handoffs. The caller adds the user's evidence separately.

Run `npm run build:cli` to copy the prompts into the matching `dist-cli/<layer>/prompts/` folders for the CLI package. Installed commands load these bundled files, whatever the working folder is. There is no template engine and no folder for per-user overrides.

### Local research desk

Run `verifold --desk` in a project, or `verifold ui --desk --workspace <path>`, to open its old desk in the browser. Without `--desk`, the same commands open the app. With a terminal, the project owner runs in a background process, and the terminal attaches to it: it prints the URL and status lines, and takes the terminal commands. Ctrl+C or a closed window only detaches. The team keeps working. Run `verifold` again to attach, and `verifold stop` to stop the owner: sessions pause, and pods stop after their results come back. Use `--no-open` to print the URL without opening a browser.

The terminal and the background owner talk over a Unix socket in a private temporary folder. A terminal must give the owner's key first. The key is in `~/.verifold/credentials/owners/<owner ID>.json` (`0600`), which task agents and the coordinator cannot read. It is never in a command line, an environment variable, a project file, or a log. The owner writes its status lines to `.verifold/owner.log`, without the desk URL. A request for approval in your own session shows the change that it would make in the terminal only. The log keeps the request's ID and why it asks. Over about 1 MB, the log moves to `owner.log.1`. Nothing starts at login: after a restart, run `verifold` to continue.

Without a terminal, for example in a script, `verifold ui` runs the project in the foreground as before, and Ctrl+C stops it.

The URL includes a private access token. Keep it private, and use the complete URL if the page asks you to connect again. Type `/open` or `/app` in the terminal to open the app again with a new one-time link, and `/desk` for the old desk. The page at `/desk` is the old desk. `/` leads to the app.

On a Mac, Verifold keeps the computer from idle sleep while an agent works or a pod runs (`caffeinate -i`). Closing the lid still puts it to sleep.

One Verifold process owns a project at a time. A second `verifold` attaches to the background owner. A command such as `verifold research` names the running process and exits. The owner writes `.verifold/owner.json` with its process ID and start time, and no access token. If that process stopped, the next owner moves the record aside and continues.

The desk shows the question, the saved context, the research phase, the attempt history, and the source reports. Its rail names the views: Home, Plan, Work, Answer, and Records, and Compute when the desk can manage pods. The arc on Home has four stages: Ask, Plan, Work, and Answer. The top bar names the current stage and its state, for example "Plan: waits for you".

Home starts with one Now line: what happens now, on which harness, and how many tasks are done. When nothing runs, the line says so, or says that the team waits for you, and it quotes the coordinator's latest note to you. A note older than 12 hours, or a note about a task that changed after it, stays out. A time on another day names the day, for example "Thu 23:21". What needs you comes next, then the answer under the question when the coordinator proposes it. After you start the work, Home also shows the task map with the harness marks, and how many checks have a result. The checks themselves are in Answer. The messages between agents are in Records and on each task page.

The desk refreshes every two seconds and updates the page in place, so open sections, typed text, and focus stay. A running task pulses in the color of its harness: violet for Claude Code, gray for Codex. A legend names the colors when the tasks use both. When a task is done, a dot carries its work along the arrows to the tasks that wait for it, with a word for what it hands over: code, results, or notes. A check result lands like a stamp, and a new view fades in. The tab icon shows a ring with the share of the planned tasks that is done, and it turns amber when Needs you has items. With reduced motion nothing moves: an arrow lights up instead of the dot.

Opening or refreshing the desk does not start a harness. You start a harness session in the desk or with `verifold session`.

A message box sits at the bottom of Home, Plan, and Work. The small menu at its left names the agent. It starts on the one that leads now: research before you choose a direction, then the coordinator. You can pick a task agent that runs or waits for your review instead. Enter sends, Shift+Enter starts a new line, and `/` puts the cursor in the box. On a phone, the box opens from a button.

Where your message goes:

- A running task agent gets it inside its current turn. Claude Code takes it at its next tool result. Verifold runs Claude Code with `--replay-user-messages`, so it sees that moment. If the turn ends first, Claude Code runs one more turn with the message. Codex takes it through `turn/steer`. The coordinator's messages to a running task arrive the same way.
- A task whose version waits for your review starts its next turn with your message, and the next version follows.
- The coordinator gets it at its next wakeup. A message from you wakes a waiting coordinator at once.
- Research gets it with its next step. When the plan or the directions wait for you, your message starts a step that revises them. If research ends with a chosen direction while a message waits, Verifold passes the message to the coordinator.

Each message shows its state, for example "Waits for the next research step", "Delivered during its turn", or "Answered". The answer is the agent's next text after delivery, or the coordinator's next note to you, and it is a model claim.

Work starts with Now: each task agent that runs or waits for review, with its harness, how long it has run, and its latest step. A quiet agent keeps its latest step with the time since it, for example "Last update 12 min ago". Message opens the message box to a running agent, and Review opens a version that waits. Four rows show, and the rest fold.

The map follows, with one small box for each task: its title, its state, its harness when that differs from the lead, and its time or version. A task that waits for one other task names it, and a task that waits for more says how many. The columns of the map shrink before it scrolls, and its right edge fades while more of it is out of view. Finished lists the done tasks, newest first, with the accepted version and its number of files. Clear finished takes done and cancelled tasks off the map and out of the rail. Finished still lists the done ones, and Show finished brings them back.

Records has a Runs card. Start over moves this run to `.verifold/archive/<id>/`: the research attempts, the tasks and their versions, the messages, the coordinator and its log, the results, and the session records, with a copy of the workspace. The question, the brief, your settings, the compute records, and the files that you accepted into the project stay. Nothing is deleted.

Start over stops the coordinator and cancels the tasks that wait, so their sessions end and their task folders go. It refuses while research, a task turn, or your own session runs. The next run starts its research from the same question. Records lists each archive with its date, its tasks, and its size. Restore brings one back where it was, and the current run moves to the archive first.

Verifold keeps a project memory in plain Markdown, in `memory/` in the project folder:

- `README.md`: the index, which every agent reads first
- `progress.md`: what is done, what runs, and what comes next
- `direction.md`: the chosen direction and its checks
- `decisions.md`: who decided what, and when
- `findings.md`: the check results with their evidence, and the answer
- `notes.md`: notes from the agents
- `tasks/`: one file for each task

Verifold rewrites only the part of each file between its markers, shortly after each change, and keeps your own text outside them. The coordinator and each task agent get the index in their prompt, because they cannot read the project folder themselves. Research reads `memory/README.md` first. A task agent sees only its task, so the coordinator gives `memory/direction.md` as an input to a task that needs the direction and its checks. Agents keep notes for later runs with the `verifold_note` tool. Before Start over archives a run, its progress, decisions, and findings stay in the files as an earlier run, so the next run continues from what was learned. The memory is not a vector store or an embedding index. Plain search is enough at this size.

A task opens as its own page, with Back to the map. The page starts with its state and what you can do:

- For a version in review: what the agent says (its reply, a model claim, rendered as Markdown), then Accept, Ask for changes, and Reject. Ask for changes opens the message box to the agent, and the agent makes a new version from what you write.
- For a running task: the agent's latest step, with Message and Stop the turn.
- For a task that has not started: Start task. When a coordinator runs, the page says that the coordinator starts the task, and that you can start it yourself.

The changed files with their diffs come next. An HTML file shows as its page, with its changes folded under it and a link to open it in a new tab.

Pages run without scripts and without network access. A second local server, on its own port, serves each page with a random link that works while the desk runs. So a page cannot read the desk or its token, and a task without network access cannot send data out through its page. A page can show images and stylesheets from its task folder, and `data:` images. Verifold makes every `<link>` and `<meta>` tag inert, because a prerender or preconnect link can reach the network even without scripts. So a page keeps its styles in a `<style>` element, and the task prompt asks agents for static pages. A link that you click opens in a new tab. This was tested in Chrome. Other browsers may differ.

One card below holds the rest, each part folded: what the task asks, what the agent did (its transcript), the messages, Change the task, and the history. The task form shows the title, what the agent should do, what it should produce, and where it may write. The input files, the network, the harness, and the tasks that it waits for fold under them. The page names tasks by their titles, and the message box on it writes to the task's agent.

To add work after the work started, write it to the coordinator, for example "Add a task: time the scan on 3 more graphs." Each task that the coordinator creates while it answers your message is a draft, and the coordinator cannot start it. The coordinator's thread shows each draft: what it does, its harness and why, where it writes, and its time limit. A draft has three actions: Start it, Change it (which names the task in the box), and Write the task yourself (which opens the task with its form). The map shows a draft with a dashed edge, and Needs you lists it. When no coordinator runs, the menu of the box offers a new coordinator, with your words as its objective.

Research runs in the same process as the desk. The research report recommends one direction and marks each other direction as an add-on or an alternative. The recommended direction becomes the draft plan at once, and the coordinator drafts its tasks. It drafts each add-on as an extra.

In a guided project, the plan then waits for you in Plan: the direction, its checks, the drafted tasks, and the coordinator's summary of them. Each extra has a checkbox that is not ticked. Start the work approves the plan and cancels the extras that you left out. In an autonomous project, the plan does not wait: the coordinator starts its tasks at once, and each add-on waits as a draft that you can start. Either way, you can still change, stop, or message any task.

To change the draft, write to the coordinator in the message box, and it revises the draft. Use this instead, on another direction, stops the draft, cancels its tasks, and drafts the plan for that direction. Nothing locks before you start the work. After you start it, Change to this direction, on another direction, stops the coordinator and the running turns. Their work waits for your review, done work stays in the project, and a copy keeps the results of the earlier direction. The coordinator then drafts the plan for the new direction, and the plan waits for you again.

The desk also offers the other research decisions: start or continue research, and approve the research plan when you asked for that stop. The terminal that runs the desk accepts the same decisions: `/research`, `/approve`, `/feedback`, and `/select`.

While research runs, the Plan view shows the step, the time, and the harness events as they arrive. Summary shows the latest step in plain words, for example "Searching the web". Details shows the [transcript](#harness-transcripts) of the step. You can cancel the step. A cancel keeps the saved checkpoint and the attempt files.

A step stops when the harness sends nothing for 15 minutes, or after four hours. A step that stops on such a limit runs once more by itself, from the saved checkpoint. If it stops again, Continue research tries once more.

Research and task agents run at the same time. Research does not use an agent slot, and a cancel stops only its target. In the terminal, `/cancel` stops research or a turn when only one of them runs. When both run, choose in the desk. While the desk runs, `verifold research` in another terminal names the running process and stops.

The desk renders Markdown from the harness. Raw HTML stays visible as text. Links keep only http, https, and mailto targets, and images show only their text. The page sanitizes the rendered Markdown again with a bundled copy of DOMPurify.

In the desk, recent activity means that the research owner wrote an observation in the last ten seconds. It does not prove that a native agent is alive. Research that runs in the desk's process shows the harness tool events that Verifold observed.

The terminal shows short Verifold status lines, with no commands to type, and the decisions, requests, and permission denials of the sessions that you control. It shows no harness tool events. The events of task agents stay in the desk. The terminal prints one line when a task starts, when a version is ready for review, and when a version is accepted. A controlled session shows its events in the desk.

### Harness transcripts

Details shows the transcript of each harness run, close to what you see in the harness CLI: research steps, sessions, and the setup interview. Each tool call shows its name and target. Open a call to see its full input and output. Helper work shows under the tool call that started it: Claude Code subagents under their Agent call, and Codex agent threads under their agent call. Open all and Close all change every call. Full screen fills the window with the transcript, and Escape closes it. Selected attempt shows the transcript of an earlier research attempt.

Verifold saves transcripts in private project files: `.verifold/runs/<attempt-id>/transcript.jsonl` for research and `.verifold/sessions/<session-id>.transcript.jsonl` for sessions. Setup keeps its transcript in memory only. Each text field keeps at most 64 KB, with a note where Verifold cut it. A transcript stops at 16 MB, with a note. Verifold removes terminal control characters.

A transcript shows what the harness reported. It does not show the processes that a command started, and agent text is still a model claim. Research attempts from before Verifold saved transcripts have none. Requested models, returned session IDs, and model claims about delegation stay apart from the protocol events that Verifold observed.

### Controlled harness session

Start one harness session from the message box in the desk, or from the terminal. In the box, pick A new agent in the menu. Small defaults show under the box: the harness, Ask me first or Auto, and the folder (this project folder). Your first message starts the session with them. The session then shows in the menu, in the rail, and in the Now strip of Work, like any other agent. A message to it reaches its running turn, or starts its next turn when it waits. In the terminal:

```sh
verifold session --prompt "Reproduce the baseline" --host codex --mode ask
```

The session runs in the project folder, with the harness's own sign-in, settings, and permissions. An agent that Verifold runs loads none of your MCP servers, claude.ai connectors, or ChatGPT apps:

- Claude Code starts with `--strict-mcp-config`. Plugin skills and hooks still load.
- Codex starts each thread with plugins, apps, and each configured MCP server turned off. If Codex does not report its configuration, the session stops.

Verifold starts Claude Code with its stream-json control protocol (`--permission-prompt-tool stdio`) and Codex with `codex app-server`. The owner runs up to three agents at the same time, sessions or tasks, unless you change "Agents at once" in Compute. Research can run at the same time. If a desk action fails, the reason shows next to that control.

In Ask me mode, each permission request from the harness goes to the desk and to the terminal. You allow it once or deny it, and the harness enforces your answer. For Codex, Verifold sends approvals to you (`approvalsReviewer: "user"`), even if your Codex configuration uses its reviewer agent. Codex runs commands inside its sandbox without a request, so a network call that the sandbox blocks can fail without a request.

In Auto mode, Claude Code uses its `auto` permission mode, and Codex sends approvals to its reviewer agent. The desk shows the mode that the harness reports. It can differ from the mode that you asked for, for example when Claude Code does not allow Auto for a model.

While a turn runs, you can cancel it or write to it. When a turn ends, write the next request in the box, or end the session. In the terminal:

- Type `/start` and a request to start a session with the project's harness in Ask me mode.
- Type `a` to allow once, or `d` to deny the open request. When several requests are open, add the ID, for example `a R2`.
- Type a follow-up when the agent waits, or type `/cancel` or `/end`.
- Type `/help` for all terminal commands.

Without an interactive terminal, requests wait for the desk, the session ends after the first turn, and `session` prints a JSON summary with the record path.

Records starts with the messages between agents, newest first, with the older ones folded. It then lists the tool calls of all agents in one Commands table, newest first: the agent and its harness, the exact command or target, who let it run, risk tags, and the result. The header counts each tag. The latest 20 calls show. The older tagged calls and the older calls without a tag fold under their counts. Records keeps the latest 200 calls and every tagged call. Tagged only hides the calls without a tag, and the browser remembers that choice. The panel of an agent has the same table for its own calls under Commands. The rail and Home show no command counts:

| Label                                          | Meaning                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| You allowed, You denied, Not answered          | You answered the permission request, or the turn ended before you answered.                                                                                        |
| Denied by Claude Code                          | The harness denied the call, for example through a settings rule or its Auto classifier.                                                                           |
| Auto, no person                                | Claude Code ran the call in Auto mode without a request. Claude Code does not report whether its classifier or a rule allowed it.                                  |
| Codex reviewer approved, Codex reviewer denied | The Codex reviewer agent decided. The table shows its reason.                                                                                                      |
| No prompt, Ran in the sandbox                  | The call ran without a request under the harness's own rules, for example a read-only command. Ran in the sandbox applies to Codex commands and file changes only. |

A permission request shows the tool input, not a description that the model wrote. For a write or an edit, the desk also shows the content that would change. Risk tags (Network, Install, Deletes files, Settings files, Outside folder) come from the command text. A tag points to a call worth a look. It is not a finding, and it asks for no decision. A tagged call that no person approved shows Mark reviewed until you mark it. The record shows the command that the agent asked for. It does not show commands inside a script, or the processes that a command starts. Agent text is a model claim. Tool calls, requests, and decisions come from the harness protocol.

Verifold saves each session in `.verifold/sessions/<session-id>.json` before it starts the harness. The record keeps the latest 400 events and 1000 tool calls, and one entry for each harness process that ran the session. Verifold gives Claude Code its session ID at launch (`--session-id`), and it records the Codex thread ID when Codex reports it.

When Verifold stops (`verifold stop`, Stop the team in the desk, or Ctrl+C in the foreground), a running session pauses: Verifold stops the current turn and the harness process, and keeps the native session ID. The result of a turn that the stop cut off is unknown. The next `verifold` in the folder lists the paused sessions in the desk. Resume, or `/resume` in the terminal, continues the same conversation in a new harness process, with Claude Code `--resume` or Codex `thread/resume`. A session that ended or failed cannot resume.

If Verifold stops without saving the end of its work, for example after a forced stop, the next `verifold` in the folder checks each unfinished session and research attempt before it starts anything. A harness process that still runs stops first, but only when its recorded process start time matches, so a reused process ID cannot cause a wrong stop. The work becomes interrupted, with an unknown result, and tool calls that were running show as unknown. A session with a recorded conversation can resume. A session without one runs its first request again. Claude Code keeps its session ID for that run, so it cannot create a second conversation. An interrupted research attempt keeps its files, and Continue research runs the step again.

### Agents at once

Verifold runs up to three harness agents at the same time. "Agents at once" in Compute changes this, from 1 to 8, and the project record keeps it. Each agent uses your Claude Code or Codex plan, so more agents reach its usage limit sooner. A lower setting stops no agent: new starts wait until fewer run. Each has its own session, launch, native session ID, record, and transcript. A task agent also has its own task, claim, and task folder. The Team list in the rail shows them with their state and anything that waits for you. A session opens in a panel with its activity, transcript, requests, controls, and Commands table, and a task opens as its own page. A start beyond the setting waits until one of them ends. A cancel, a permission request, a burst of output, or a failure in one agent does not change the others.

In the terminal, `a` and `d` with a request ID answer the request of the agent that it belongs to. When more than one agent could get a follow-up, a cancel, or an end, the terminal asks you to use the desk. Each terminal line of a session names its harness.

What each harness supports in Verifold:

| Control                           | Claude Code                                                                 | Codex                                                                |
| --------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Protocol                          | `claude -p` with stream-json input and output                               | `codex app-server` (JSON-RPC)                                        |
| Native identity                   | Session ID chosen by Verifold before launch (`--session-id`)                | Thread ID from `thread/start`                                        |
| Follow-up                         | Between turns                                                               | Between turns                                                        |
| Cancel a turn                     | Interrupt control request                                                   | `turn/interrupt`                                                     |
| Ask me                            | Each permission request comes to the desk and the terminal                  | Each approval request comes to the desk and the terminal             |
| Auto                              | Claude Code `auto` mode; Verifold cannot see which rule allowed a call      | Codex reviewer agent; the record shows its decision                  |
| Strict (tasks)                    | `dontAsk`, sandbox, edit rules for the task folder, no credential reads     | Profile based on `:workspace`, approval `never`, no credential reads |
| Resume after Ctrl+C               | `--resume` with the session ID                                              | `thread/resume`                                                      |
| Subagent work in the transcript   | Nested under the Agent call                                                 | Nested under the agent call (fixture tested)                         |
| Terminal                          | `claude --resume` in a PTY, between turns; no tool record while you hold it | `codex --remote` on the same app-server socket; events continue      |
| A command that the sandbox blocks | Reported as a failed call                                                   | Not reported by Codex                                                |

Tested with Claude Code 2.1.288 and Codex 0.155.1 and 0.160.0. Terminals were tested on macOS with Codex 0.160.0.

### Agent terminals

Each agent has a third view beside Summary and Details: Terminal. Between turns, Open the terminal runs the harness's own TUI on the same conversation, in the desk. Open in new tab gives it a full window. Return to Verifold ends the TUI and continues the session in the desk.

- Claude Code: Verifold stops its stream-json process and starts `claude --resume <session>` in the terminal, with the session's permission mode. While you work there, Verifold records no tool calls. When you return, stream-json resumes on the same conversation, including what you did in the terminal.
- Codex: every Codex agent runs its app-server on a private Unix socket, and the terminal runs `codex --remote unix://… resume <thread>` on the same server. Codex keeps reporting its events to Verifold while you type. A thread needs one turn before its terminal can open.
- Task agents keep their Strict limits in the terminal. When you return, Verifold saves the task folder as a version for review.

One browser view holds the input at a time. A reload of that view keeps the input and replays the last 256 KB of output, with no new process. Another view, for example a new tab, starts read-only until you choose Take input here. While you hold a terminal, the agent's follow-up, cancel, and end controls wait until you return. Terminals work on macOS and Linux. They need the optional `@lydell/node-pty` package, which npm installs with Verifold. You answer the startup prompts of a harness TUI, such as an update or a folder trust question, in the terminal.

### Scoped tasks

A task gives one harness a scoped job in its own copy of the project. Usually the coordinator writes the tasks. To write one yourself, choose Write a task yourself in Work. The form asks for a title, what the agent should do, what it should produce, and where it may write. The input files, the network, the harness, the time limit for each turn, and the tasks that it waits for fold under them. A task can wait for other tasks to be done. An edit makes a new revision, and earlier attempts keep the revision that they ran. You can also revise a done task, which opens it again.

Start task claims the task, prepares a task folder, and then starts the harness:

- In a Git repository, the task folder is a worktree on a new branch `verifold/<task>-r<revision>-a<attempt>-<id>`, under `.verifold/workspaces/`. In other folders, it is a plain folder with its own Git data under `.verifold/tasks/git/`.
- The task folder starts from your project as it is now for the writable paths, including uncommitted changes, plus copies of the input files. Verifold copied each input when you saved the task, so a later edit in the project does not change it.
- The harness runs in the task folder in Strict mode:
  - Claude Code runs with `--permission-mode dontAsk`, its sandbox turned on, and permission rules that allow edits only in the folder. It stops when its sandbox cannot start, instead of running commands without it.
  - Codex runs with a permission profile that extends its `:workspace` profile, and the approval policy `never`.
  - Actions outside these rules are denied without a prompt. Claude Code gives its agent no reason for such a denial, so the task prompt tells Claude Code agents that a denial stops only that command, and which simpler forms to try. The desk names the reason in plain words.

Web search stays allowed. Shell commands cannot reach the network, unless the task names the domains that it needs, with a reason, for example to download a dataset. Claude Code's sandbox then allows exactly those domains. Codex cannot limit its network to domains, so a Codex task with domains can reach any host. The task page shows the domains and the reason.

Neither harness lets a task read credential files: SSH keys, Verifold's credentials, the RunPod, GitHub, and AWS logins, Git and netrc passwords, the logins of both harnesses, and the macOS login keychain. Other reads are not limited, and both sandboxes allow writes to temporary folders. Verifold removes `RUNPOD_*` variables from the environment of every harness, terminal, and Git process. Codex does not report a command that its sandbox blocks, so the transcript can miss a blocked attempt. The task page lists these limits under What the harness enforces.

When a turn ends, Verifold saves the task folder as a version: a commit on the task branch or in the task's Git data. A version leaves out the environments and caches that tools make, such as `.venv`, any folder with a `pyvenv.cfg`, `node_modules`, and `__pycache__`, and the files that a `.gitignore` in a writable folder ignores. It keeps output that your project's top `.gitignore` ignores. A version holds at most 5000 changed files. In the review, scratch files, such as test output in a `tmp` or `.cache` folder, fold under the other files and are not ticked. Accept leaves them out unless you tick them. The coordinator also leaves them out when it accepts a version without a list of files.

The task then waits for review. The review lists the changed files, with the diff of one file at a time. You cannot select files outside the writable paths, or links.

- Accept copies the selected files into your project, without a commit. If a target file changed in your project since the task started, Verifold copies nothing and names the file.
- Ask for changes sends your note as the next turn, which makes the next version.
- Reject keeps the version in the record and opens the task again.
- Stop the turn makes a version of the work so far.

Up to two tasks and sessions run at the same time, and research can run with them. Two active tasks cannot write to the same paths.

Accept also keeps a copy of the accepted files as an artifact version under `.verifold/tasks/<task>/artifacts/`. A later acceptance adds a version and does not change earlier ones. When a task that waits for other tasks starts, its task folder gets the latest artifact of each of them, and the task records which versions it got. If one of them is revised and accepted again, a version that used the earlier files cannot be accepted. Reject it and start the task again, so that it gets the new files. If one file would come from two sources, such as an input file and an artifact, the start stops and names the file.

Task agents talk to the team through four Verifold tools:

- `verifold_post` sends a note to the coordinator, to you, or to a linked task.
- `verifold_block` reports that the agent cannot continue.
- `verifold_object` raises an objection, with evidence, to a file version that the task got.
- `verifold_withdraw` withdraws the agent's own objection.

Claude Code gets these tools as an SDK MCP server over its control channel, and Codex gets them as dynamic tools on its thread. The harness pipe tells Verifold which task and attempt sent each call, and a call from an attempt that no longer runs changes nothing. Verifold records a repeated call once. Messages are files under `.verifold/messages/`, up to 4000 characters each, 50 for each attempt, and 2000 for each project. A task agent gets each message whole.

A message that cannot reach a running turn goes to the agent with its next turn: the start of an attempt, or a change request, at most 20 at a time. When that turn ends normally, the message shows Delivered. If the turn fails, or Verifold stops first, it shows Delivery uncertain, and Verifold does not send it again by itself.

When no coordinator runs, Needs you lists each open blocker and objection. With a coordinator, the Messages part of the task page shows them, and you can settle one before the coordinator does. Uphold or overrule an objection, or resolve a blocker, with a reason. The decision goes to the task that raised it. To change the work, revise the task. To write to a task's agent, use the message box. A message is information for the agent. It cannot change the task's paths, permissions, or limits.

After Accept or Reject, Verifold removes the task folder if all its changes are in a version. The branch keeps every version. If Verifold stops while a turn runs, the next `verifold` saves the task folder as a version for review. The agent's session pauses with Verifold. Ask for changes, or your message to the agent, resumes the same conversation for the next turn, with the same task folder and limits. An agent that ended cannot resume. A message to it goes to the coordinator, and the desk says so.

### Coordinator

The coordinator turns an objective into tasks. When research ends, the coordinator starts for the recommended direction, with the project's lead harness and model. Its first turn gets the direction as the objective, the research brief, and the direction's checks. You can also start it under Coordinator in the desk, with an objective that you write.

In a team with a helper, the coordinator picks the harness for each task from the team and gives a reason. It gives the independent half of a check to the other harness, so that a mistake of one model family cannot pass both. Verifold refuses a harness outside the team. The plan and the task page show the reason, and a task on the helper harness carries a mark on the map. A task whose start failed offers Run it on the other harness of the team.

In a guided project, no task starts until you start the work in the plan. To change the plan first, ask the coordinator for a change, or edit a task. In an autonomous project, the coordinator starts the plan at once.

The coordinator is one harness session outside the agent slots. Claude Code runs it with `--tools ""`, so it has no built-in tools. Codex runs it with a permission profile that extends its `:read-only` profile, without the credential files, and the approval policy `never`. Both load none of your MCP servers. It acts only through Verifold tools, and each tool calls the same task operation that you use: create, revise, start, stop, accept, ask for changes, reject, cancel, post a message, and decide an objection or a blocker. It can also ask you a question. It reads versions with a tool, up to 64 KB of text for each file. Verifold checks each action before it changes anything. A refused action changes nothing, and the coordinator reads the reason. It can create up to 12 tasks, and it can give a task the domains that its shell commands need, with a reason.

Every change keeps the coordinator's reason, and the desk lists the actions as plain sentences, for example "Started Implementation A". Details shows the tool name and Verifold's reply for each action. A decision on a version or a message says that the coordinator made it, and a revision says that the coordinator wrote it. A version also keeps the agent's last reply, a model claim. A repeated tool call with the same harness call ID gets the earlier answer and changes nothing.

The coordinator settles objections. It can uphold an objection and revise the task, or overrule it with a reason. After it overrules two objections from one task to the same task, Verifold refuses its next overrule of such an objection, and the objection waits for you in Needs you. You can decide any open blocker or objection yourself, and your decision is final.

When the work waits for something that only you can give, such as a RunPod key, a spend limit, or a choice, the coordinator asks you a question. Needs you shows it until you answer, and the rail shows "Waits for your answer". Write your answer and send it, or click Done when there is nothing to say. The coordinator gets your answer at once.

Events wake the coordinator: a version ready for review, a message for it, a blocker or an objection, a failed start, or your action on a task. Its own actions do not wake it. Events within 20 seconds join one digest turn, with at most 12 turns an hour. A message from you does not wait for other events. Verifold saves the position of each digest before it sends it, so a restart never repeats one.

Claude Code and Codex report the usage window of your plan. When the window of the coordinator's harness is used up, a turn would fail, so the coordinator does not wake. Its events wait until the reset time plus 30 seconds. When the harness gives no reset time, the wait is 15 minutes, then 30, 60, and 120 minutes while the window stays used up. The events of a turn that ran into the limit come again after the reset, marked "again". The window belongs to the harness account, so every session of that harness reports to the same record, `.verifold/quota.json`, and a restart keeps the wait. Home, the coordinator panel, and messages that wait for the coordinator say "waits for Claude Code's usage window until 19:00". A Codex account with credits keeps working past a full window, so only a failed turn starts its wait.

Stop the coordinator ends its session. Running agents finish their turns, and their versions wait for your review. If Verifold stops, the coordinator pauses with the agents. The next `verifold` offers Resume, which continues the same conversation with its tools and sends the events that arrived in between. The coordinator has no terminal.

### The lab

The lab is how a new project works on its question. Several agents work on it at the same time, and each one owns one direction. They talk on one board instead of through a coordinator.

The lab starts in one of two ways:

- After setup, a new project starts a lab on its question. No research step starts.
- In a run that no team owns yet, such as an older project or a run after Start over, the app's lab page offers **Start the lab**, with your question and the hours, while no research step runs.

A new project needs no `--lab`. In a project that has no lab, `verifold --lab` or `verifold ui --lab` still starts one on the project's saved question, with a note that a new project needs no flag. While Verifold already works in the background, `--lab` starts nothing and says so.

You give the lab a time budget in hours: 8 unless you choose another.

**The plan of record**

- The lab's first agent runs on the project's main harness. It reads the question and the project, and posts the plan of record on the board. Nothing waits for your approval: work that costs nothing starts with the plan.
- The plan says how the agent reads the question. For each of its 2 to 4 directions, it gives:
  - a bar: what makes the direction hold up, in plain words
  - the repeat runs that the bar needs, such as seeds
  - the spread that counts as noise
  - what it builds on, marked known or new
  - a harness from the project's team
- The first agent keeps its own folder for its own direction. Verifold opens the other directions, each with its own agent and folder. Each new agent starts with the plan in its first prompt.
- The plan is a post on the board, with a table of the directions, their bars, and what they build on. Reply to the plan to change it: your reply wakes the agent that wrote it. When it changes the plan, it lists every open direction. The new plan post answers the old one and wakes the agents whose directions changed. Only the first agent changes the plan, and only you stop a direction.
- The plan lists the facts that it rests on, such as a model's version or a GPU price. Each fact shows its source and when a plan listed it. When a later plan lists other facts, each agent that already works gets them once, in its next digest, as quoted information. A plan that lists no facts, or the same ones, keeps the facts of the plan before it, and its card says "from an earlier plan". A plan that drops the facts tells the agents once.
- When the time budget ends, the lab pauses, also when the computer slept past the end. No turn starts after that. Needs you asks with a go call: continue 4 more hours, or stop here. An agent's open call for more hours asks instead. After "Stop here", the paused lab offers more time itself. More time resumes a lab that the time budget paused. A lab that you paused stays paused until you resume it.

One run has one team: the coordinator's team (research, the coordinator, and its tasks) or a lab. A coordinator or a task makes the run the coordinator's team's, so the lab does not start: Start over first, then start the lab on the new run. The lab also waits while a research step runs: let the step end, or cancel it in Research. The lab never stops research by itself. While a lab exists, no research step, coordinator, or task starts, from the desk or from `verifold research` and `verifold select`. After Start over of a lab run, research does not start by itself, and Home offers the lab again.

**Directions and agents**

- You can open a direction yourself too, with a title and a harness (Claude Code or Codex). You can say what makes it hold up.
- Each direction gets its own agent and its own copy of the project: a Git worktree on the branch `verifold/d-N-<title>`. Its number is new to the project, so a direction never takes the folder or branch of an earlier run.
- The copy has the project's committed files and its uncommitted changes, except new files above 1 MB, tool folders such as `node_modules`, and anything past 50 MB. The agent reads large data in the project folder.
- The agent works there in Strict mode, with the same limits as a task worker: credential files stay unreadable, and `RUNPOD_*` and pod secret names stay out of its environment. It can use its harness's own subagents.
- A lab has up to 6 open directions. Agents share the "Agents at once" slots with your own sessions.
- Each agent has a handle, such as `claude-1` or `codex-1`.
- Each agent and checker runs on a model that Verifold picks, unless the project or your profile names one:
  - Claude Code: your own Opus default, such as `opus[1m]`, else Opus. Verifold reads it in Claude Code's order: `ANTHROPIC_MODEL` in the `env` block of your user settings, then `ANTHROPIC_MODEL` in your environment, then the `model` key of your user settings.
  - Codex: Verifold's preferred Codex model when Codex lists one, else your own Codex model. When your reasoning effort does not fit Verifold's model, the agent gets the model's default effort.
  - The app shows the model that the harness reports. When it is of another family than the model that Verifold asked for, such as Sonnet in place of Opus, the app shows both.
- An agent can open a direction too, with `verifold_direction`: a title, a bar, and a harness of the project's team. Verifold starts its agent. Agents start at most 4 agents in 24 hours, and never more than your "Agents at once". The new directions of a later plan count too; those of the first plan do not. Agents start none while the lab is paused or past its time budget. The note on the board says who opened it and why. It wakes no one.

**Verdicts**

Each direction has a verdict that its own agent gives, with one line of evidence and the post that has the proof. The row shows both.

- **Leading**: the results meet the bar so far. It needs a claim, evidence, or rerun post about the direction, with proof.
- **Ruled out**: the direction failed its bar. It needs a ruled-out post about the direction, with proof.
- **Holds up** needs a check. The agent names a claim, evidence, or rerun post that cites a run, and Verifold starts a check of it (see Checks). Until the check ends, the direction is leading. When the check reruns the post and it holds, the direction holds up.
- An agent can take its verdict back. Each verdict is a note in the direction's thread.
- After ruled out, the agent can close its direction. Its runs are cancelled and its leases end. Its session ends after that turn, or when a pause or a stop of Verifold cuts the turn short, and Verifold commits that turn's work. If Verifold stopped before that commit, the next start makes it. Its folder and branch stay.
- `memory/progress.md` lists the directions with their verdicts and evidence.

**The board**

- Agents post with Verifold tools, in at most 280 characters. A post has a kind: claim, evidence, objection, question, or ruled out.
- A claim, evidence, or ruled-out post needs proof: a file, a figure, a diff, or a run of the lab. Before it posts a file or a diff, Verifold commits the agent's folder and pins each file to that commit with its SHA-256, or checks that each path of a diff changed. A proof file counts also in a folder that the project's `.gitignore` ignores. A post without the proof that it needs is refused.
- Verifold commits a folder only when something in it changed. Proof names the direction whose folder holds its commit.
- In the app, a figure's chip opens the figure above its post. Verifold reads the figure from the project's Git objects at the commit that the post pinned, only as a regular file with a figure extension, up to 20 MB and 50 million pixels. The check of its SHA-256 and size shows only that the bytes match the post's record. An image shows on the page, and a PDF is a download.
- Agents read other directions' files with `verifold_read`: as they are now, ignored files too, or at the commit that a proof names. They keep notes in the project memory.

**Runs**

Agents run experiments through Verifold, so each result has a record that other agents and you can check.

- An agent's run starts with a commit of its folder. The run works on its own copy of that commit, in a folder under `.verifold/workspaces` that no other run gets, so later edits do not change it. The copy has the committed files only. The run can read large data in the project folder.
- The run is a shell command in the macOS sandbox, `sandbox-exec`. It writes only in its copy and its own temporary folder. It has no network and no GPU, and it cannot read the credential files. Its environment has no `RUNPOD_*` variables, no stored pod secret names, no `ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_*`, `CODEX_*`, `AWS_*`, `AZURE_*`, `GOOGLE_*`, `GEMINI_*`, or `GIT_*` variables, and no `SSH_AUTH_SOCK`, `DBUS_SESSION_BUS_ADDRESS`, `DISPLAY`, `WAYLAND_DISPLAY`, or `XDG_RUNTIME_DIR`.
- On other systems, Verifold runs nothing locally. Without pods, the agents get no run tools there, and they run experiments in their own harness.
- The copy is no Git repository. `VERIFOLD_RUN` holds the run's ID and `VERIFOLD_COMMIT` its commit.
- The record is in `.verifold/lab/runs/r-N/`: the commit, the command, why it runs, the status, the exit code, the times, and the metrics. A run is done only when Verifold saw its process exit with code 0.
- Metrics come from output lines `METRIC name=value`, and from a `metrics.json` of numbers that the run writes in the top folder of its copy. A value that is not a number is null. A `metrics.json` in the commit does not count.
- The log is `log.txt`, at most 20 MB: past that, Verifold cuts the middle and keeps the last 1 MB.
- The output files that the agent names are copied to `outputs/`: regular files only, up to 200 files and 100 MB. The record has a SHA-256 of the commit and the command, and one of the outputs, so two runs of the same thing can be compared.
- A run has a time limit: 60 minutes unless the agent gives another, up to 240. At the limit, or when it is cancelled, its processes get SIGTERM and, after 5 seconds, SIGKILL. A run that a signal ended by itself, such as an out-of-memory kill, is failed, and its note names the signal.
- An agent has at most 2 runs at a time, and the lab at most 3.
- The end of a run wakes its agent with one line, such as `r-7 ended: exit 0 in 6 min. acc=0.612.` While its run runs, an agent waits for it instead of taking its next turn. A turn that starts a run counts as progress.
- Any agent can cite any run that ended as proof, and can read a run's record and log. An agent cancels only its own runs, and says why.
- When Verifold stops, the runs stop and end as interrupted. Their agents hear it after the next start. A run that an earlier Verifold left running stops when Verifold starts, if its process ID and start time match.
- Pause starts no new run. A run that runs goes on, and its end waits for the agent's next turn.
- While a run runs, the Mac does not go to idle sleep.

**Runs on a pod**

When pods are on, with a RunPod key and a spend limit, each agent can also run on a GPU pod of its own direction. An agent gets the pod tools when its session starts while pods are on.

- An agent asks for a pod with `verifold_request_pod`, for its own direction only, and reads the limits and the leases with `verifold_compute`. The lab's first pod always asks you with a cost call, with the most that it can cost, also when "Ask me before each pod starts" is off. After you approve one, your limits and approvals apply as they do for the coordinator. When you undo that answer, the next pod asks again. A change of the lease, such as a ready pod, wakes the agent. An agent ends only its own direction's leases, with `verifold_end_lease`. When you stop a direction, its leases end, and a request that waits is withdrawn. A pod that an agent asked for while its direction ended ends at once. A paused lab starts no pod.
- `verifold_run` with `where: pod` runs on the newest ready lease of the agent's direction, or on the lease that it names. Verifold copies the commit's files to `/root/verifold/run-N-<hex>` on the pod, at most 2,000 files and 200 MB, and starts the command there as a job, as root, with network. The run has only that copy, not the rest of the project. Verifold puts the secrets that the lease names into the job's environment.
- A run on a pod takes up to 1,440 minutes. Verifold reads its job every 20 seconds, which also keeps the pod from the idle stop, and keeps the end of its log in the record while it runs. A cancel or the time limit sends SIGTERM to the job's process group, and SIGKILL 5 seconds later and with each read after that. A job that has not ended a minute after SIGTERM ends the run all the same. A pod that does not answer for 10 minutes ends the run as interrupted.
- When the job ends, Verifold stops what is left of its process group. It copies back `metrics.json` and each output that the agent named, one at a time, so one that fails leaves the others, and checks them as for a local run. Verifold keeps no copy of a file whose name or content holds the value of a pod secret, and the note says so. The log comes back with each secret's value replaced by its name, also a part of a value where Verifold cut the log. The `METRIC` lines count also from a part of a long log that the record leaves out. Then Verifold removes the run's folder on the pod. When a copy failed, the folder stays on the pod until the lease ends, and the note says so.
- Before a pod stops or its lease ends, its runs end as interrupted and copy back what they have. The stop waits up to 2 minutes for them, and no run starts on that pod meanwhile. When Verifold stops, its pod runs end the same way. After a crash, the next start reads each pod run's job in the background, so the desk opens at once: a job that ended gives its result, and one that still runs stops. Then lease recovery stops the pod.

**Checks**

A check settles a dispute without you: a fresh agent of the other harness tests the claim without the author's reasoning, and the verdict follows what it finds.

- An objection that replies to a claim, evidence, or rerun post that cites a run queues a check of that post, from an agent or from you. So does a direction's agent that asks for holds up. A second objection joins a check that waits. A check that runs already does not take it: its checker never sees it, so a new check waits for it. A new check also takes the objections of the post's failed checks.
- The checker runs on the harness that did not write the post. With one harness in the team, a fresh session of the same harness checks, and its mark says so. It gets a handle of its own, such as `codex-2`, and no direction.
- Its folder, `.verifold/checks/k-N`, holds every file of the post's run commit and nothing else, with a Git directory of its own.
- Its prompt has the lab's question, the direction's bar, the post's text, the command and results of its runs, and the objections. It gets no other post, no project memory, and no transcript. The runs that the post cites at another commit are listed apart: the checker judges them by their results only.
- Its harness cannot read anything under `.verifold` but its own folder: the board, the lab's records, the session records, the directions' folders, the runs' folders, and the other checks' folders. No other check folder is made while a checker runs unless its harness denies it. Nor can it read the project memory, the project's Git data, Claude Code's and Codex's own folders in your home folder, or Claude Code's temporary folders of the project and of each direction. Its runs cannot read them either. It can read the rest of the project folder, such as large data.
- When the project folder's path has a character that the harnesses' rules read as a pattern, such as `[`, `(`, or `*`, the checker's harness gets none of these project denials. Its mark then says that the checker could read project records, and no ask for holds up is taken in that project.
- It has its own tools: `verifold_run` on its folder, `verifold_run_status` for its own runs, `verifold_read` for the post's files at its commit, and `verifold_post` for one rerun post. It cannot read the board, plan, or open directions. A run of the checker gets at most the time that its check has left, and starts only while its check runs and the lab is not paused.
- Its prompt tells it to find the post's premise, to measure the result with its own code where it can, and not only to rerun the author's script.
- Its rerun post replies to the claim with an outcome, holds, fails, or differs, and a method, rerun or code-read. A rerun cites a run that the checker made. A code-read cites the post's run. The post mentions the author, the objectors, and the direction's agent, so they wake. Its session ends after that turn, and its other runs stop.
- Holds by rerun turns an ask for holds up into holds up, when no newer check of the post waits or runs. Fails or differs takes back a leading or holds-up verdict that rests on the post, and that post can then carry no verdict but ruled out. A code-read never gives holds up, so a computer without a sandbox for runs refuses an ask for holds up.
- A checker's rerun post is evidence only when it held: then a direction can lead on it, and hold up on it when it reran the claim. A rerun that failed or differed is never evidence for leading or holds up.
- An ask for holds up stands while the direction is open and its verdict rests on that post. When the direction ends or its verdict moves to another post, a check that only the ask needed is dropped: its session ends, its runs stop, and a note says why. A dropped check does not count toward the post's checks. A check that settles objections too goes on.
- One check runs at a time, or two when "Agents at once" is 5 or more. A check takes a free slot before any agent. It waits while the lab is paused or past its time budget, and while its harness's usage window is used up.
- A check has 3 turns and 60 minutes. A run that ends after its last turn gives it one more turn to post. A check that does not post in that time fails, with a note on the board that wakes the objectors, and the direction's agent when it asked for holds up. A post gets at most 2 checks.
- A checker's handle can be mentioned, but it reads no board, so the mention does not reach it.
- A pause, Start over, or a stop of Verifold, such as `verifold stop`, ends a check's session. A fresh one starts after the resume or with the next `verifold`, with a list of its earlier runs, and it gets only the minutes and turns that the check has left. These stops do not count. When the checker's process stops by itself, its start or its folder fails, or Verifold ended without closing the lab, the check starts again once the same way, with fresh minutes and turns. After a second such stop it fails, with its note.
- The board pins open disputes at its top: each post with objections that a check took and no check answered yet, with where its check is, the check's runs, and a link to the row whose evidence it is. An objection that no check can answer, because its post cites no run or had its checks, stays a reply in its thread. A post that a check tested shows how, with a check that waits or runs first: `reran r-9 (Codex): acc=0.7`, `did not hold on r-9`, `read the code only`, or `(same harness)`. A row's evidence line says the same, or `not checked`, and a row whose evidence is in dispute says so.

**Calls**

Agents settle technical questions among themselves with checks. You get only plain calls: cost, scope, access, and go.

- An agent asks with `verifold_ask_person`: a question, 2 or 3 options with their dollars and minutes, the option that it advises, and why. Verifold refuses a call of another kind: a technical question goes on the board as an objection.
- An option can have one effect that Verifold applies when you pick it:
  - a pod, with a cost call: Verifold starts the lease as one that you approved. Its dollars are the most that the lease can cost, from your limits. When the pod needs a secret that this computer does not store, the option says so: add it in Compute first.
  - more lab hours, with a cost or go call. A lab without a time budget refuses them.
  - open a direction, with its title, bar, and harness, or stop one, with a scope call
  - domains for the agent's shell, with an access call. Codex cannot limit the network to domains, so a Codex agent's shell then reaches any website, and the option says so.
- Needs you shows each open call, with the agents' pick marked, and what each option does and what its undo does. At most 3 agents' calls wait at once.
- Your answer applies at once. The board says what Verifold did, and the agent that asked wakes with it. No option applies by itself, and an access call never does.
- A pod starts only while the lab works, and only when it can cost at most the dollars that the call showed. When the price rose, Verifold withdraws the call, and the agent can ask again.
- **Undo** shows for the undo window of the call, 10 minutes unless the agent chose 0 to 60. Undo reverses the effect: the pod's lease ends (the minutes billed so far stay billed), the hours go, a direction that the answer opened stops, a direction that it stopped opens again with its agent, and the shell loses the domains that no other answer gives. Runs and pods that ended with a stop do not come back. Then the call is open again, so you can choose another option. After the window, or after a restart past it, Undo is refused.
- An agent's shell reaches the domains of its access answers that stand, at most 20. Each start of the agent reads them. When they change, or when pods turn on or off in Compute, the agent's process ends and its conversation resumes with the new network and tools: after its turn, or at once when its shell loses a domain. A Codex agent starts a new thread for new tools, because a Codex thread keeps the tools that it started with. When pods turn off, a Codex thread keeps pod tools that now refuse.
- When an agent's direction ends, its open calls are withdrawn, and so are calls to stop that direction. A call that no longer makes sense when you answer it is withdrawn too. The board says why.
- Calls, answers, and undo windows survive a restart. When Verifold stopped while it applied an answer or an undo, the board says so, and the agent that asked wakes with it. Such an answer does not stand, so the deadline asks again.

**Bring in and sign off**

Agents work on their own branches. Nothing reaches your project folder by itself.

- **Bring in**, on a direction's row or in the answer, opens the direction's files in the side panel. Between the agent's turns, Verifold first commits the direction's folder, so you see exactly the files that come in. While the agent works, or while you hold its terminal, its files can be half written, so the panel shows its files as of its last turn and says so. Each file has a box to tick and its diff. Bring in copies the commit that you looked at, also when the agent commits again; **Show the newer files** takes the newer work.
- Each file compares with its base: the version that came in from this direction last time, or else the direction's start. So a file that went back to its start, or that the agent deleted after it came in, shows its change too. A file that came in before with the same content shows when it came in. A deleted file is deleted in the project folder, and a file can take the place of a folder, and a folder the place of a file.
- Not ticked at first: changes in `memory/`, scratch output such as files under `tmp/`, and settings that run code through your tools, at any depth: Git hooks (`.githooks/`, `.husky/`, lefthook), `.claude/`, `.codex/`, `.mcp.json`, editor settings such as `.vscode/` (tasks and launch files) and `.idea/`, `.envrc`, `.pre-commit-config.yaml`, and GitHub workflows and actions. When you tick one, the panel says that it can run code. Check its diff first.
- Stays out, and the panel says why: links, submodules, files under `.verifold/` or a `.git` folder in any case, names that are too long or have control characters or backslashes, and files above 50 MB. Files that the direction's commit left out, such as files that Verifold can't copy safely, show as left out. Verifold never writes into `.verifold/` or a `.git` folder, also through a link in your project folder; Accept of a task does the same.
- Each project file must still have the content of its base. When one changed, nothing comes in, and Verifold names the files. Untick them to bring in the others, or copy the agent's change by hand from its diff. So after one direction's file came in, another direction's change of the same file is such a change: directions never merge into each other. A file whose earlier version Verifold can't read is not ticked, and stops a bring-in until you copy it by hand. At most 1000 files and 200 MB come in at once.
- Verifold writes the new files in `.verifold/staging` first. Then it deletes what the direction deleted and moves each new file into place. When Verifold stops while it changes the project folder, the next start finishes the copy by the content and mode of each file, and the board says so. A file that you changed meanwhile stays as it is. When it stops while it checks the files, nothing came in.
- The lab keeps the base of each file that came in: its direction, commit, and time, and the version and mode that the file had before, for an undo. The board says what came in, and the panel lists what you brought in before. When that record has no room for more files, Verifold refuses the bring-in and says so.
- **Undo**, next to a bring-in in that list, puts each of its files back to the content and the mode that it had before the bring-in. A file that you changed since it came in stays as it is, and the undo names it. A file that a later bring-in from the same direction changed stays too: undo that later bring-in first. A file that Verifold can't read, or can't copy back, also stays, and **Undo again** tries it once more. A file that the bring-in added goes, and a file that it deleted comes back, also when a file and a folder traded places. The limits of a bring-in hold for an undo too.
- Each undo goes back one bring-in. To go back further, undo the earlier bring-in next: Verifold keeps enough to undo the newest 10 bring-ins of each file. **Undone** lists each undo. It names the files that went back, the files that you or a later bring-in changed, and the files that could not go back. A bring-in from before Verifold had undo has no undo.
- When Start over begins while Verifold checks the files of a bring-in or an undo, nothing changes in your project folder, and the panel says "Nothing came in: Start over stopped the bring-in." or "Nothing went back: Start over stopped the undo."
- **Answer**, in the header, opens the lab's answer in the side panel: each direction's verdict, its evidence, how a check tested it, and what you brought in; the directions that are still open and the runs; and the calls that you answered. When every direction is closed or stopped, or you chose to stop at the end of the time budget, Home says that the lab ended, with **See the answer**.
- **Sign off** keeps each direction's verdict, its newest commit, and the check behind its evidence, with the answer in one line if you write one. The board says so. A new sign-off replaces the last one. Signing off stops no agent: pause the lab or stop the directions for that.

**Who a post wakes**
A post wakes an agent when:

- it replies to that agent's post
- it mentions the agent
- it objects in the agent's direction
- it comes from you in the agent's direction

Your post with no direction, no reply, and no mention wakes every agent. Other posts wait for the agent's next turn. Each turn starts with the posts that the agent has not read, oldest first, up to 30 lines; a post for the agent says so. Posts that do not fit stay unread for the next turn. Quoted text in them is marked as information, not instructions. When an agent is in a turn, your post goes into that turn if the harness takes it. What a turn read counts only when the turn ends cleanly. The posts of a turn that did not finish come again in the next turn: the usage window ran out, the agent's process stopped, a Verifold read failed, or the lab paused.

**Writing to the lab**

- Write in the lab's message box.
- `@claude-1` in your text mentions that agent, and `@all` mentions every agent. Agents mention one agent or you, never all.
- Reply under a post to answer it. The message box says which post you answer, and × stops the reply.
- Choose a direction to write about it.

**Keeping going**

- While its direction is open, an agent takes its next turn 20 seconds after the last one.
- After two turns in a row that change no file and post nothing, it waits 10 minutes, then 30 minutes, then 2 hours. A file that the project ignores counts as a change. A turn that ran into a used-up usage window does not count. A post for it ends the wait.
- An agent that posts nothing for 6 turns, or for 2 hours of turns and 2 turns at least, is asked once to post what it found or what blocks it. Waits and pauses do not count. The ask comes with its next turn, so it costs no turn of its own. Its next post, verdict, or open ends the quiet stretch. No ask comes while it waits for its run, while the lab is paused or past its time budget, or while its harness's usage window is used up.
- When directions outnumber the "Agents at once" slots, they take turns. An agent that has ended a turn gives its slot to the agent that has waited longest, and an agent that has used its 12 turns of the hour gives its slot first. Your own session gets a slot the same way. A parked agent resumes its conversation when its turn comes.
- A used-up usage window pauses the idle agents of that harness until the reset.
- After a restart, each agent resumes in turn with a digest that says so.
- An agent whose process stops by itself, or whose start fails, starts again after a wait: 30 seconds, then twice as long each time. It starts again at most twice an hour. After the third stop, Needs you and its row offer Start again.
- If an agent's conversation cannot resume, its next start begins a new conversation with the board summary. The posts that it has not read come in its next turn.

**The screen**

- A lab's Home is one column. The header gives the question, the day of the lab, the deadline, and the money: Claude Code's cost estimates of the lab's sessions plus what the pods cost. The total is an estimate. Codex reports no cost, so its usage is not counted, and the header says so. The views and the team open from the menu at the top left.
- **Pause** pauses every agent until you resume it. After the time budget ends, give the lab more time instead.
- **Search** opens in the side panel, also with ⌘K, or Ctrl+K off a Mac. It finds posts by their ID, kind, author, and text, runs by their ID and command, and calls by their question and options. Each word must match, in upper or lower case. The newest hits come first, at most 50. A post on the board opens there, and an older post shows its whole text in the hit, up to a size limit for the whole search; past it, the hit says which file holds the post. A run opens in the panel, and an open call opens in Needs you. Escape closes the search, and its words stay for the next one.
- When you come back after 30 minutes or more, Home starts with **While you were away**: a line for each direction with news, a disputed one first; how many posts, runs, and calls came, with links to up to 5 failed runs; and what the lab spent since your last look. These costs add up to what the header added since then, and they show whenever the lab spent money, also when nothing else changed. **Dismiss** hides it until your next time away. Verifold keeps the time of your last look in the lab's folder, so it counts across tabs, browsers, and restarts of Verifold. A page in a background tab is not a look. A computer that slept with the desk open counts as time away too.
- One line says what needs you first: an open call, then an agent that stopped by itself, a missing pod secret, and a pod outside your limits. It opens in place and counts the rest, which Needs you lists. While a call is open, the number keys choose its options.
- Each direction has one row: its verdict, its title with one line of evidence, its agent, and its check or its state. The row opens in place to its bar, its runs, and its controls:
  - **Message** puts the agent's handle in the message box.
  - **What it did** opens the agent in the side panel: its events, its transcript, and its commands.
  - **Diff** opens what the direction's branch changed since it started. Choose a file to see its changes.
  - **Terminal** opens the agent's own harness in a terminal, between its turns. The agent gets no turn while you hold it. When you return, its next turn follows.
  - **Bring in** opens the direction's files to bring into your project folder.
  - **Stop** ends that direction's agent and cancels its runs. Its folder and branch stay.
- The board shows the threads by direction. Each post shows its kind and its proof. A run or a diff opens in the side panel: a run with its command, commit, place, state, metrics, outputs, and the end of its log. **Cancel the run** stops a run that runs. A long post shows its start, and the rest folds under **Show the whole post**.
- The one message box posts to the board. It completes `@claude-1`, `@d-2`, and `@all` as you type. `@d-2` puts your post in that direction, so it wakes that direction's agent. Enter sends, and Shift+Enter starts a new line.
- A desk of `verifold session` only shows the lab. Run `verifold` in the project folder to work in it.
- Start over pauses the lab and archives it and its board with the rest of the run. A restored lab comes back paused. **Resume** continues it.
- The terminal's commands leave lab agents alone. Write to them on the board.
- A lab action that takes longer than two seconds, such as opening a direction, goes on in the background. The lab shows it while it runs, and why it failed if it did. One such action runs at a time.

### GPU pods on RunPod

Compute in the desk holds the settings and the leases for GPU pods on RunPod. A lease is one pod for named tasks, or for lab directions: one GPU type on Secure Cloud, one image, a maximum number of hours, and the rate that its cost is counted at. The desk calls a lease a pod.

Compute asks for one thing at a time: the key, then a spend limit, then the GPUs that pods can use. The other limits fold under More limits. After that, it shows the pods, the limits in one line, and the allowed GPUs, each with its form folded.

#### The key

Paste a RunPod API key in Compute, or run `verifold runpod key set`, which reads the key with hidden input or from standard input. No option takes the key as an argument. Verifold checks the key with one read-only call to RunPod (`GET /v2/pods`) before it saves it.

- On macOS, the key goes into the login keychain through `security -i`, with the key on standard input.
- On Linux, it goes into the Secret Service keyring through `secret-tool`.
- When you choose it, or when the computer has no keyring, the key goes into `~/.verifold/credentials/runpod` (folder `0700`, file `0600`). Verifold refuses that file when other users can read it.

`verifold runpod key status`, `check`, and `remove` show where the key is with its last four characters, check it again, and remove it from this computer. RunPod keeps a removed key valid until you revoke it in the RunPod console. Use a separate key for Verifold, so that you can revoke it alone.

The key goes only into the `Authorization` header of requests to `https://api.runpod.io`, and the client refuses redirects. No project file, desk reply, terminal output, prompt, or transcript holds it.

#### Secrets for pods

Some work on a pod needs a secret, for example an `HF_TOKEN` for gated Hugging Face weights. Add it in Compute under Secrets for pods, or run `verifold runpod secret set HF_TOKEN`, which reads the value with hidden input or from standard input. Secrets are stored in the same places as the key. `verifold runpod secret list` shows the names, and `verifold runpod secret remove HF_TOKEN` removes one.

The coordinator names the secrets that a pod needs in its request. Verifold gives the pod each of them as an environment variable when it creates the pod. If one is missing, Needs you shows "Add a secret" with the coordinator's reason, and the pod starts when you add it, if the request still fits your limits. Task agents and the coordinator never see a value. Verifold replaces it with its name in the output of pod tools, and removes variables with these names from the environment of every harness. A command on the pod can still use the value, so give a pod a token with the least access that the work needs, such as a read-only token.

#### Limits

Only you set them, for each project, in `.verifold/compute/settings.json`: the spend limit in USD, the highest rate of one pod in USD per hour, the hours of one lease, the idle minutes before a stop, one or two pods at the same time, the disk of each pod, the RunPod images (`runpod/...`) that a lease can use, and whether you approve each pod. Without a spend limit, pods stay off.

Show the GPUs lists the Secure Cloud GPU types, with their list price for one GPU and their stock, from `GET /v2/catalog/gpus`. Choose the types that a lease can use. A price for a cloud that the type is not on, and a price of 0, do not count.

#### Requests

The coordinator asks for a lease with `verifold_request_pod`: a GPU type, the hours, the tasks, and a reason. A lab agent asks the same way, for its own direction. Verifold refuses a request that does not fit your limits: a type that you did not allow or that has no stock, a rate above your cap, too many hours, or a maximum cost above what is left of the spend limit.

A request inside all your limits starts at once, also while you are away. Compute shows the pod, and you can stop it there. Needs you shows the request instead when you tick "Ask me before each pod starts" in Compute, or when the request cannot start now, for example because the pods at the same time are at your limit. It shows the rate, the hours, the maximum cost, what is left after it, the coordinator's reason, and what the pod allows. Nothing is created or billed before you approve it.

#### The pod

After you approve a lease, or at once when it fits your limits, Verifold creates the pod (`POST /v2/pods`) with a name that belongs to the project and the lease, and reads it every 30 seconds. The lease ends its hours after the create.

- Verifold stops the pod after the idle minutes, when Verifold stops, and when RunPod bills above your cap.
- It deletes the pod at the end of the lease, and when the spend so far, plus 5 minutes of the running pods, reaches the spend limit.
- RunPod erases the disk of a pod when the pod stops.

You and the coordinator can stop, start, and end a lease. Only you change a limit.

#### Cost

Verifold counts each running interval at the rate that RunPod bills, with the container disk at $0.10 per GB-month. Every 15 minutes, it compares this with RunPod's hourly billing records, and the larger amount counts. An open lease holds the cost of its remaining hours against the limit.

#### Task access

A task that a ready lease names uses its pod through three Verifold tools:

- `verifold_pod_run` runs a command as root in the task's folder on the pod, for at most 10 minutes, or starts a background job.
- `verifold_pod_job` reads a job's state, its exit code, and the last 64 KB of its output.
- `verifold_pod_copy` copies files to the pod, or back into the task's writable paths, at most 2,000 files and 200 MB at a time. Verifold refuses links and paths outside the writable paths.

Verifold runs `ssh` itself. Each lease has its own SSH key in `~/.verifold/credentials/ssh/`. The pod gets only the public key (`PUBLIC_KEY`), and Verifold deletes the key when the lease closes. No account SSH key changes. Before the pod is ready, Verifold compares the pod's SSH host key with the fingerprint that the pod prints in its log, and connects only with that key. A pod that prints no fingerprint is trusted on first use. Before a pod stops, Verifold copies each task's writable paths back. The task page shows the pod and what it allows: any command as root on a machine with internet access, with copies of project files.

#### Watchdog

When a pod becomes ready, Verifold starts a small loop on it. Each minute, the loop checks two things: whether the lease has ended, and whether Verifold's heartbeat, which it sends every 2 minutes, is 15 minutes old. If either is true, the pod stops itself with its own RunPod key (`runpodctl stop pod`). So a pod stops even when Verifold crashed or the computer sleeps, and RunPod then erases its disk.

#### Recovery

When Verifold starts, it finds a pod whose create reply was lost, by its name. It stops a pod that ran while Verifold was not running, and tells you in Needs you what that time cost. `verifold pods` lists the leases. `verifold pods stop <lease|all>` stops pods when Verifold does not run in the project.

## Privacy

Project state stays in `.verifold/workspace.json`. Research attempts keep briefs, responses, reports, and harness transcripts under `.verifold/runs/<attempt-id>/`. Session records under `.verifold/sessions/` keep your messages, agent text, exact commands, and harness transcripts. Task records under `.verifold/tasks/` keep each revision, copies of its input files, each version, and copies of the accepted files. Messages between you, the coordinator, and task agents are under `.verifold/messages/`. The coordinator's objective, events, and actions are in `.verifold/coordinator/state.json`, and its conversation is a session record. In a Git repository, the task branches `verifold/*` hold the versions as commits. A transcript keeps full tool inputs and results, for example the contents of files that a tool read. These files can contain private research.

Setup adds `/.verifold/` and `/.verifold.md` to the project's `.gitignore` and creates the state with private permissions. This stops ordinary accidental staging. It does not stop a deliberate publication, or access by processes that run under the same account. The project memory in `memory/` is not in that `.gitignore`, so review it before you commit or publish it.

Your harness uses its own model services and research tools. Local state does not mean that those services run offline. Verifold creates no remote profile and publishes nothing.

`ui` serves only the selected project, on loopback, with authenticated project reads and bundled assets. Session actions use authenticated JSON requests to the same local server. The server rejects unexpected hosts and origins. It serves the harness transcripts of the project only to the authenticated page. It does not serve arbitrary files. `view` creates a read-only local HTML snapshot with no external assets. Remote profile sync is future work. The nested `verifold-website/` repository stays independent.

## Project status

This guide describes the current source checkout. The published npm package can lag behind changes that are not released yet.

| Available in this checkout | What it does                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Context-first onboarding   | Reviews optional personal background and project context before your harness interviews you.                    |
| Project initialization     | Creates `.verifold.md` and folders for literature, experiments, results, figures, docs, and agents.             |
| Landscape research         | Saves planning, source links, proposed directions, and feedback. You choose the direction.                      |
| Reviewed background        | Imports one selected text export with consent and review through setup-only personalization.                    |
| Local research records     | Keeps attempt files, and gives CLI status and a read-only HTML snapshot.                                        |
| Controlled session         | Runs Claude Code or Codex sessions from the desk or the terminal, and relays their permission requests.         |
| Command record             | Records each tool call with who let it run, risk tags, and a review mark.                                       |
| Project owner              | A background process owns a project. A stop pauses a session, and a later run resumes it.                       |
| Research in the desk       | Runs research in the owner, shows its activity live, and offers each research decision in the desk.             |
| Recovery                   | Marks work interrupted after a crash, stops leftover harness processes safely, and offers resume.               |
| Browser setup              | Sets up a new project in the desk, with the same steps, consent, and records as the terminal.                   |
| Harness transcripts        | Shows each harness run as in its CLI, with tool input and output and nested subagent steps.                     |
| Scoped tasks               | Runs a task in its own copy of the project with Strict limits. You review each version first.                   |
| Agents at once             | Runs up to three Claude Code or Codex agents at once (1 to 8), each with its own task, session, and record.     |
| Agent terminals            | Opens an agent in its own Claude Code or Codex terminal in the desk. One view at a time types.                  |
| Task handoffs              | Gives a task the accepted files of the tasks that it waits for, and blocks use of replaced files.               |
| Team messages              | Agents post notes, report blockers, and raise objections with evidence. You decide in the desk.                 |
| Coordinator                | Turns a chosen direction into tasks, starts them, reviews versions, settles objections, and asks you questions. |
| Project memory             | Keeps what the project did, decided, and found in `memory/`, for every agent and every run.                     |
| GPU pods                   | Rents RunPod pods inside your limits for the tasks that need a GPU.                                             |

This is an early implementation. The host requests and reports native delegation. Verifold does not verify it.

The optional literature retention and pilot handoff commands produce requests for the host. They do not download PDFs, create a literature memory file, or run experiments. Agent supervision and experiment execution follow the development plan below. Scheduled memory, public collaboration, and cloud sync come later.

## Development plan

Build a local workspace for research agents that you control one by one. Keep one npm distribution and a browser UI for now. The CLI and the browser use the same operations, and the selected harness keeps its credentials, tools, and permissions.

Stages 1 to 6 are in this checkout:

1. The [controlled harness session](#controlled-harness-session).
2. Persistent ownership with recovery, research in the desk, browser setup, and [harness transcripts](#harness-transcripts).
3. [Scoped tasks](#scoped-tasks).
4. [Agents at once](#agents-at-once).
5. [Agent terminals](#agent-terminals).
6. The [coordinator](#coordinator), with task handoffs and messages.

The later stages are planned. Each stage builds on the completion criteria of the stage before it.

| Order | Deliverable                       | Complete when                                                                                                                                                                                        |
| ----- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | One controllable harness session  | Start a session, see identified live events, send a follow-up, and cancel from the browser through shared CLI operations. Native permission requests have a supported response or continuation path. |
| 2     | Persistent ownership and recovery | A local owner keeps sessions independent of browser connections. Reconnect restores identity; owner restart reconciles surviving, interrupted, and unknown work before retry.                        |
| 3     | Scoped tasks and isolated writes  | Tasks have objectives, dependencies, input records, writable scopes, outputs, owners, and limits. Writers use separate workspaces; duplicate or stale claims are rejected.                           |
| 4     | Two independent harness workers   | Claude Code and Codex run adjacent assignments concurrently. Cancelling or blocking one does not stop or mislabel the other. Both are visible in the desk.                                           |
| 5     | Interactive terminal workspace    | Supported workers have native terminal views with input, resize, bounded replay, and explicit input ownership. Reload and protocol handoff preserve identity without duplicate live owners.          |
| 6     | Coordinator and durable handoffs  | A coordinator assigns and labels tasks, exchanges evidence-linked messages, and revises dependent work through the same manager operations. Runtime code enforces ownership and limits.              |
| 7     | Reviewed research deliverables    | Parallel investigation, an objection, and revision produce a reviewed memo/report bundle. Accepted artifact versions, producing attempts, failed work, and unresolved objections remain inspectable. |
| 8     | Owned experiment execution        | An approved local experiment has fixed inputs and evaluator, resource allocation, cancellation, retained results, and recovery. Managed jobs cannot double-book a shared compute slot.               |

The first usable multi-agent workspace ends at stage 6. Stage 7 completes the research delivery. Stage 8 adds experiment execution. A planning record or a report does not show that an experiment ran.

Start by extending the existing attempt record and harness adapter. Extract shared operations where the first browser control needs them. Record the native session identity and bounded structured events as they arrive. Keep the existing CLI JSON and the foreground Ctrl+C behavior. Persistent sessions have an explicit attach and detach contract.

Worktrees reduce checkout collisions, but they do not isolate like a sandbox. Keep authoritative writes serialized, and review agent output before you integrate it. Record the scoped inputs with each attempt. A generated label or a model report cannot override the observed execution state or expand permissions.

The first complete demonstration connects a prior-art agent and a reviewer of methods and baselines. The researcher watches both, intervenes in one, and reconnects without a relaunch. An objection with evidence leads to revised work and a reviewed memo on the literature gap, with a reproducible report. Experiment measurements enter this flow only after stage 8.

After the core workflow is in use, reassess desktop distribution from real installation and interaction needs. A native launcher or an optional desktop app can reuse the same manager and UI. Split the installation only when native dependencies or a separately shipped app justify it.

Full browser onboarding, automatic memory maintenance, procedure optimization, a public board, cloud sync, and broad remote provisioning are outside this sequence. Existing approved background and project context stay available. Harness readiness checks and scoped context belong in the execution features that need them.

See the [implementation roadmap](https://github.com/MVPandey/Verifold/issues/14) for completion criteria and validation requirements.

## Help build Verifold

See [open issues](https://github.com/MVPandey/Verifold/issues) for current contributions. Each issue defines its prerequisites and acceptance criteria.

The wider goal is a shared home for computational science, including math, CS/ML, and security. Researchers should be able to inspect assumptions, critique an analysis, rerun an experiment, or add a related investigation. Failed attempts and unresolved objections belong beside successful results.

Work starts private. The planned public board will share only what the owner selects, with enough evidence for others to test and continue the investigation. A publication should keep a record of how a conclusion was reached that others can inspect.

[Open an issue](https://github.com/MVPandey/Verifold/issues) with a workflow, a reproducible problem, or a contribution that you want to make. Use public examples, and keep private research out of the issue. For code changes, read the engineering rules below and run `make validate` before you open a pull request.

## Build from source

For development or unreleased changes, clone the repository and use its pinned Node version. With `nvm` installed:

```sh
git clone https://github.com/MVPandey/Verifold.git
cd Verifold
nvm use
npm ci
npm run build:cli
node dist-cli/cli.js init
```

In this checkout, replace `verifold` in the examples above with `node dist-cli/cli.js`. Rebuild after source changes.

## Engineering

Internal agent research, planning notes, and coordination records belong in `.local/agents/`, which Git ignores. Keep public documentation in `docs/`. Do not publish private notes through commits, issue bodies, or pull request descriptions.

Read [AGENTS.md](../AGENTS.md) before you contribute. It names the required Node.js, technical-English, and ponytail skills, and the review and validation rules. The skill editions live in `.agents/skills/`, so you install no personal skill. [words.md](words.md) lists the words that the desk uses.

`src/cli.ts` owns the process lifecycle and the terminal streams. The CLI command handlers coordinate research and profile operations. The harness adapter owns subprocess arguments and response parsing. Research contracts validate returned data, and storage owns atomic state changes.

Structured results go to stdout. Prompts, diagnostics, the violet and lavender folded VF welcome, and activity indicators go to stderr. The welcome has a short fold highlight. Selected menu rows update in place, and completed choices collapse into a short transcript. Agent Markdown in the terminal shows headings, bold, italics, inline code, and links in color. Text wraps to the terminal width, including long paths and common wide Unicode characters. Short windows show a compact selector.

Indicators show the time spent waiting for a real harness response. They do not claim the progress of single subagents. Set `VERIFOLD_REDUCED_MOTION=1` for static activity messages. `NO_COLOR` turns off color and animation, and `TERM=dumb` also uses numbered text menus. Noninteractive commands keep their machine-readable output.

A normal research failure keeps the saved checkpoint. Look at `status` and the attempt files before you continue. A forced stop such as SIGKILL can leave `.verifold/research.lock`. The next owner removes it when no research attempt shows activity in the last ten seconds. Older Verifold versions do not take the owner lock, so make sure that none of them runs research before you remove a lock yourself. Do the same check for a stale `write.lock` before another state write.

New research attempts save `attempt.json` beside their evidence. It records the Verifold attempt ID, the harness, the requested model, the starting phase, the times, the requested session, and the returned native session, each separately. A null model means that Verifold asked for the harness default. It does not name the model that the harness used.

`succeeded` means that the response passed Verifold's validation and that Verifold saved the phase checkpoint. It does not mean that the scientific claims are true. `failed` and `cancelled` keep the evidence that exists. Look at the checkpoint before you retry. A record left at `started` has an unknown result, and it does not prove that a process still runs. Older attempts have no record. The desk scans at most 200 history entries, includes the latest recorded attempt separately, and marks unreadable records as unknown. Process recovery remains manual.

`make validate` runs formatting, type-aware linting, strict types, tests, both builds, and a check of the packed CLI. Turn on the commit and push hooks in each clone:

```sh
git config --local core.hooksPath .githooks
```

See [validation scope](validation.md). Source-link validation does not verify scientific claims or establish citation provenance.

The harness package is MIT licensed. The visual brand assets in `public/assets/` are outside that grant. See [license scope](../LICENSING.md). The bundled Manrope font keeps its SIL Open Font License.
