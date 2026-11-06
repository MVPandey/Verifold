# Verifold, the Python rebuild

Verifold runs the coding agents you already have, such as Claude Code and Codex, as a society that works on one research question. This branch rebuilds it in Python. The TypeScript version on `main` is the one published on npm.

The rebuild changes what Verifold is. The TypeScript version started every turn and decided what each agent saw. Here, Verifold is the environment. It starts each agent's own harness over [ACP](https://agentclientprotocol.com) with your usual settings, gives the agents a shared board as an MCP server, and keeps the record. The agents choose what to watch, when to work, and what to start. Verifold enforces only what passes through it: who posts, the record's integrity, money, and your answers when a harness asks for permission.

## Status

`verifold run "question"` starts a lab in the current folder with one Claude Code agent and one Codex agent. They post on the board, wake each other with mentions and replies, and ask you on the board when their harness needs a permission. Blind reruns, evidence snapshots, and the app are next.

## Set up

You need [uv](https://docs.astral.sh/uv/).

```sh
make install
make validate
uv run verifold --version
```

`make install` installs the locked environment and turns on the Git hooks. `make validate` runs the same checks as CI. [AGENTS.md](AGENTS.md) lists the code rules and the layout.

## License

MIT. See [LICENSE](LICENSE).
