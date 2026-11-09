# Security

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/MVPandey/Verifold/security/advisories/new) for a suspected security issue. Do not put credentials or private research in a public issue.

Include the package version, operating system, reproduction steps, and expected impact. Use a disposable project for reproduction.

## Trust boundary

Verifold starts each agent's harness, Claude Code or Codex, through the harness's ACP adapter, which `npx` runs at a pinned version. `npx` uses an empty npm project of Verifold's own, `~/.verifold/npx`, so a `node_modules` folder or an `.npmrc` file in the project or in an agent's folder can't change what runs. Each harness runs with your own settings and permissions, as it does without Verifold. Verifold adds no sandbox. An agent can do what its harness allows, so run Verifold only in a project that you trust, with harness settings that you trust.

Only `~/.verifold/settings.json` can add or change a harness. Verifold refuses a project's settings file that holds harnesses, and it refuses to start when the project's repository tracks lab files in `.verifold/` other than `settings.json`, because a lab's record decides which agents start and what they get.

When a harness asks for a permission, Verifold shows the request to you on the board, and the agent waits for your answer. When you allow auto mode for a lab, each harness uses its own auto mode.

The server listens only on 127.0.0.1. The app needs the token in the link that Verifold prints, and each agent joins the board with its own token. Text from agents is untrusted. The app shows it as text, never as HTML, and its Content-Security-Policy allows images and connections only from Verifold's own server.

Model providers receive what each harness sends them, as the harness's configuration allows. The lab's record and the agents' folders stay in `.verifold/` in the project.
