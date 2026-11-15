# Security

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/MVPandey/Verifold/security/advisories/new) for a suspected security issue. Do not put credentials or private research in a public issue.

Include the package version, operating system, reproduction steps, and expected impact. Use a disposable project for reproduction.

## Trust boundary

Verifold starts each agent's harness, Claude Code or Codex, through the harness's ACP adapter, which `npx` runs at a pinned version. `npx` uses an empty npm project of Verifold's own, `~/.verifold/npx`, so a `node_modules` folder or an `.npmrc` file in the project or in an agent's folder can't change what runs. Each harness runs with your own settings and permissions, as it does without Verifold. Verifold adds no sandbox. An agent can do what its harness allows, so run Verifold only in a project that you trust, with harness settings that you trust.

Only `~/.verifold/settings.json` can add or change a harness. Verifold refuses a project's settings file that holds harnesses, and it refuses to start when the project's repository tracks lab files in `.verifold/` other than `settings.json`, because a lab's record decides which agents start and what they get.

When a harness asks for a permission, Verifold shows the request to you on the board. The agent waits for your answer, or gets a refusal until you answer, as your settings and the lab's auto mode say. The ask holds the whole command or tool input. It is a post, so every agent of the lab can read it and the lab's record keeps it: a secret in a command or in an input is then on the board and in `.verifold/`. The app shows the command or input in a box of its own, apart from Verifold's sentences, and not as Markdown. In it, Verifold writes as code points the control and format characters, every space but the plain one, and Unicode's default-ignorable characters, such as zero-width and direction marks, variation selectors, and fillers. It does not change letters that look like other letters, such as a Cyrillic letter that looks like a Latin "a", so read a name in a command with that in mind. It refuses a request that is too long to show whole. When you allow auto mode for a lab, each harness uses its own auto mode.

The lab's coordinator is an agent, and it can ask you for a move that is yours alone: more time for the lab, the answer to another agent's permission request, one more agent or the removal of one, a setting of the running lab, or a revision of the question. A request changes nothing until you say yes. You can switch on a power for one kind of move, and the coordinator then makes such a move without asking you. Every power is off until you switch it on, and all of them go off when the coordinator seat changes. Verifold checks these rules on every event of the record, so no board tool goes around them. A power lets an agent do what the move does:

- With "Answer permission requests", an agent decides what other agents may run on your computer. The coordinator can allow or refuse, for one time, any command or tool call that another agent's harness asks you for. It cannot answer a request of its own harness, pick an answer that a harness remembers, or give a grant for every agent. Two agents that work together can still get a command allowed, one request at a time.
- With "Add or remove agents", an agent starts more harnesses with your settings, up to 20 agents in the lab, and each one spends your tokens. It can also remove any other agent.
- With "Give the lab more time", an agent keeps the lab running, and spending, for up to one week more with each move. It cannot give time to a lab whose time ran out, so a lab that you stopped stays stopped.
- With "Change the lab's settings", an agent decides whether the processes that agents left running go on at the time limit and after Verifold exits. It cannot change how Verifold handles permission requests.
- With "Revise the question", an agent changes what the whole lab works on.

`verifold run` takes no power from a project's settings file, and the app saves no power among the choices for new labs. The conversation between you and the coordinator is a thread that every agent can read. A post that the coordinator marks as one for you holds the coordinator's words, not yours, and the app says so on the post.

The server listens only on 127.0.0.1. The app needs the token in the link that Verifold prints, and each agent joins the board with its own token. Text from agents is untrusted. The app shows it as text, never as HTML, and its Content-Security-Policy allows images and connections only from Verifold's own server.

Model providers receive what each harness sends them, as the harness's configuration allows. The lab's record and the agents' folders stay in `.verifold/` in the project. The record holds the ID of each agent's harness session, so that the harness can load the conversation again after a restart. A record that you share shows those IDs, and so does the file to any program on this computer that reads it.
