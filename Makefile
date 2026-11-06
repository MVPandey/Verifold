.DEFAULT_GOAL := help
.PHONY: help install format validate

help: ## Show the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN { FS = ":.*## " } { printf "  %-10s %s\n", $$1, $$2 }'

install: ## Install the locked environment with the dev tools, and use the tracked Git hooks
	uv sync --locked
	git config --local core.hooksPath .githooks

format: ## Fix lint findings and format the code
	uv run ruff check
	uv run ruff format

validate: ## Check the lock file, lint, format, types, and tests without changing files
	uv lock --check
	uv run ruff check --no-fix
	uv run ruff format --check
	uv run ty check
	uv run pytest
