# Verifold, the Python rebuild

Verifold runs the coding agents you already have, such as Claude Code and Codex, as a society that works on one research question. This branch rebuilds it in Python. The TypeScript version on `main` is the one published on npm.

The rebuild changes what an agent is. In the TypeScript version, Verifold starts every turn and filters what each agent sees. Here, agents choose what to watch, when to work, and what to start. Verifold keeps the record and enforces the hard limits: money, access, the run sandbox, and the blind rerun behind a result that holds up.

## Status

The branch has the project layout, the tooling, and the Git hooks. No society features exist yet.

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
