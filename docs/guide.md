# Verifold guide

This guide describes what works in the current source checkout. The [README](../README.md) explains what Verifold is for.

Run `verifold` to connect the Claude Code or Codex that you have installed. You can review optional personal background and choose a project folder. Before your harness asks follow-up questions, you can give it existing work, a written brief, or notes. Verifold saves the brief that you reviewed and the research records. Then it opens a local desk in your browser, where you follow the research and the team.

We're building toward a research **meta-harness**: one workspace where several harness instances work together, from the first idea to a paper, a repository, a figure, a proof, or another result. Each harness keeps its own models, credentials, tools, and permissions. Verifold connects their tasks, messages, memory, and evidence across sessions. The [development plan](#development-plan) says what is done and what comes next.

Contents: [Install](#install-the-cli) · [Start a research project](#start-a-research-project) · [The desk](#local-research-desk) · [Sessions](#controlled-harness-session) · [Tasks](#scoped-tasks) · [Coordinator](#coordinator) · [The lab](#the-lab-preview) · [GPU pods](#gpu-pods-on-runpod) · [Privacy](#privacy-and-website) · [Project status](#project-status) · [Development plan](#development-plan) · [Contribute](#help-build-verifold) · [Build from source](#build-from-source) · [Engineering](#engineering)

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

- In a folder that is already a Verifold project, Verifold first checks for global setup that is not finished, then opens the project's desk. This does not change the harness or the research that the project saved.
- In a folder without a project, setup starts with your question. After you review the research brief, Verifold creates the project and opens the desk before planning and research start.

The team works in a background process, so you can close the terminal or press Ctrl+C, and the work goes on. Run `verifold` in the project again to see it, or `verifold stop` to stop it. Stop the team in the top bar of the desk does the same.

In a folder without a project, `verifold` opens setup in the browser. The desk asks one thing at a time: your question, up to three quick questions, and the brief. The earlier steps go into the setup log. The terminal shows each step as one line. Ctrl+C during setup cancels it and saves nothing. When setup ends, a background process takes over the project, and the same browser tab shows it while planning starts.

`verifold init`, `--no-open`, and runs without a terminal do setup in the terminal instead. Both paths run the same setup, with the same consent steps, file limits, and retries. Use `verifold init` to do setup and research entirely in the CLI. A bare `verifold` needs an interactive terminal. `verifold --no-open` prints the desk URL and does not open a browser.

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

Research runs without a stop unless you ask for one, in the setup settings or with `--autonomy guided`. Relative paths resolve against the folder where you started Verifold, and the interactive path also accepts `~/`. Verifold creates missing folders and keeps what a folder already holds. It refuses conflicting files, an existing `.verifold.md`, and linked scaffold folders.

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

The coordinator proposes a search scope and personas. Research then searches without a stop. If you asked for a stop before the source search (in the setup settings, or with `--autonomy guided`), research waits for you to approve that plan:

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

Profile setup and initialization share a lock on the global settings, so only one of them can change an agency at a time. If that process is killed, the error names `profile.lock`. Make sure that no setup runs before you remove it. Drafts still need your review before Verifold uses them. Editing the profile in the browser, and choosing several history sources, are planned.

### Editable harness prompts

Harness instructions live in `src/cli/prompts/*.md`. Each filename is a prompt ID that `src/cli/prompts.ts` loads. Edit these files to change the instructions for interviews, profiles, project context, research, or handoffs. The caller adds the user's evidence separately.

Run `npm run build:cli` to copy the prompts into `dist-cli/cli/prompts/` for the CLI package. Installed commands load these bundled files, whatever the working folder is. There is no template engine and no folder for per-user overrides.

### Local research desk

Run `verifold` in a project, or `verifold ui --workspace <path>`, to open its desk in the browser. With a terminal, the project owner runs in a background process, and the terminal attaches to it: it prints the desk URL and status lines, and takes the terminal commands. Ctrl+C or a closed window only detaches. The team keeps working. Run `verifold` again to attach, and `verifold stop` to stop the owner: sessions pause, and pods stop after their results come back. Use `--no-open` to print the URL without opening a browser.

The terminal and the background owner talk over a Unix socket in a private temporary folder. A terminal must give the owner's key first. The key is in `~/.verifold/credentials/owners/<owner ID>.json` (`0600`), which task agents and the coordinator cannot read. It is never in a command line, an environment variable, a project file, or a log. The owner writes its status lines to `.verifold/owner.log`, without the desk URL. Over about 1 MB, the log moves to `owner.log.1`. Nothing starts at login: after a restart, run `verifold` to continue.

Without a terminal, for example in a script, `verifold ui` runs the desk in the foreground as before, and Ctrl+C stops it.

The URL includes a private access token. Keep it private, and use the complete URL if the desk asks you to connect again. Type `/open` in the terminal to open the desk again with a new one-time link.

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

### The lab (preview)

The lab is a second way to run a question. Several agents work on it at the same time, and each one owns one direction. They talk on one board instead of through a coordinator.

The lab starts in one of two ways:

- In a run that no team owns yet, Home offers **Start the lab**, with your question, while no research step runs.
- `verifold --lab` does the usual setup, then starts a lab on the question instead of research.

One run has one team: the coordinator's team (research, the coordinator, and its tasks) or a lab. A coordinator or a task makes the run the coordinator's team's, so the lab does not start: Start over first, then start the lab on the new run. The lab also waits while a research step runs: let the step end, or cancel it in Research. The lab never stops research by itself. While a lab exists, no research step, coordinator, or task starts, from the desk or from `verifold research` and `verifold select`. After Start over of a lab run, research does not start by itself, and Home offers the lab again.

**Directions and agents**

- Open a direction with a title and a harness (Claude Code or Codex). You can say what makes it hold up.
- Each direction gets its own agent and its own copy of the project: a Git worktree on the branch `verifold/d-N-<title>`. Its number is new to the project, so a direction never takes the folder or branch of an earlier run.
- The copy has the project's committed files and its uncommitted changes, except new files above 1 MB, tool folders such as `node_modules`, and anything past 50 MB. The agent reads large data in the project folder.
- The agent works there in Strict mode, with the same limits as a task worker: credential files stay unreadable, and `RUNPOD_*` and pod secret names stay out of its environment. It can use its harness's own subagents.
- A lab has up to 6 open directions. Agents share the "Agents at once" slots with your own sessions.
- Each agent has a handle, such as `claude-1` or `codex-1`.

**The board**

- Agents post with Verifold tools, in at most 280 characters. A post has a kind: claim, evidence, objection, question, or ruled out.
- A claim, evidence, or ruled-out post needs proof. Before it posts, Verifold commits the agent's folder and pins each file to that commit with its SHA-256, or checks that each path of a diff changed. A proof file counts also in a folder that the project's `.gitignore` ignores. A post without the proof that it needs is refused.
- Verifold commits a folder only when something in it changed. Proof names the direction whose folder holds its commit.
- Agents read other directions' files with `verifold_read`: as they are now, ignored files too, or at the commit that a proof names. They keep notes in the project memory.

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
- When directions outnumber the "Agents at once" slots, they take turns. An agent that has ended a turn gives its slot to the agent that has waited longest, and an agent that has used its 12 turns of the hour gives its slot first. Your own session gets a slot the same way. A parked agent resumes its conversation when its turn comes.
- A used-up usage window pauses the idle agents of that harness until the reset.
- After a restart, each agent resumes in turn with a digest that says so.
- An agent whose process stops by itself, or whose start fails, starts again after a wait: 30 seconds, then twice as long each time. It starts again at most twice an hour. After the third stop, its row offers Start again.
- If an agent's conversation cannot resume, its next start begins a new conversation with the board summary. The posts that it has not read come in its next turn.

**Controls**

- **Stop** on a row ends that direction's agent. Its folder and branch stay.
- **What it did** on a row opens the agent's transcript.
- **Pause the lab** pauses every agent until you resume it.
- Home in a lab still shows what needs you. Its one message box posts to the board.
- A long post shows its start, and the rest folds under **Show the whole post**.
- A desk of `verifold session` only shows the lab. Run `verifold` in the project folder to work in it.
- Start over pauses the lab and archives it and its board with the rest of the run. A restored lab comes back paused. **Resume the lab** continues it.
- Lab agents have no terminal, and the terminal's commands leave them alone. Write to them on the board.
- A lab action that takes longer than two seconds, such as opening a direction, goes on in the background. The lab shows it while it runs, and why it failed if it did. One such action runs at a time.

### GPU pods on RunPod

Compute in the desk holds the settings and the leases for GPU pods on RunPod. A lease is one pod for named tasks: one GPU type on Secure Cloud, one image, a maximum number of hours, and the rate that its cost is counted at. The desk calls a lease a pod.

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

The coordinator asks for a lease with `verifold_request_pod`: a GPU type, the hours, the tasks, and a reason. Verifold refuses a request that does not fit your limits: a type that you did not allow or that has no stock, a rate above your cap, too many hours, or a maximum cost above what is left of the spend limit.

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

## Privacy and website

Project state stays in `.verifold/workspace.json`. Research attempts keep briefs, responses, reports, and harness transcripts under `.verifold/runs/<attempt-id>/`. Session records under `.verifold/sessions/` keep your messages, agent text, exact commands, and harness transcripts. Task records under `.verifold/tasks/` keep each revision, copies of its input files, each version, and copies of the accepted files. Messages between you, the coordinator, and task agents are under `.verifold/messages/`. The coordinator's objective, events, and actions are in `.verifold/coordinator/state.json`, and its conversation is a session record. In a Git repository, the task branches `verifold/*` hold the versions as commits. A transcript keeps full tool inputs and results, for example the contents of files that a tool read. These files can contain private research.

Setup adds `/.verifold/` and `/.verifold.md` to the project's `.gitignore` and creates the state with private permissions. This stops ordinary accidental staging. It does not stop a deliberate publication, or access by processes that run under the same account. The project memory in `memory/` is not in that `.gitignore`, so review it before you commit or publish it.

Your harness uses its own model services and research tools. Local state does not mean that those services run offline. Verifold creates no remote profile and publishes nothing.

`ui` serves only the selected project, on loopback, with authenticated project reads and bundled assets. Session actions use authenticated JSON requests to the same local server. The server rejects unexpected hosts and origins. It serves the harness transcripts of the project only to the authenticated page. It does not serve arbitrary files. `view` creates a read-only local HTML snapshot with no external assets. The Vite website explains the CLI entry point. Remote profile sync is future work. The nested `verifold-website/` repository stays independent.

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

Build a local workspace for research agents that you control one by one. Keep one npm distribution and a browser UI for now. The CLI and the browser use the same operations, and the selected harness keeps its models, credentials, tools, and permissions.

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

The harness package is MIT licensed. The website and the visual brand assets are outside that grant. See [license scope](../LICENSING.md). The bundled Manrope font keeps its SIL Open Font License.
