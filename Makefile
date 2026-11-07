.DEFAULT_GOAL := help
.PHONY: help install app format validate

help: ## Show the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN { FS = ":.*## " } { printf "  %-10s %s\n", $$1, $$2 }'

install: ## Install the locked Python and app environments, and use the tracked Git hooks
	uv sync --locked
	npm --prefix app ci
	git config --local core.hooksPath .githooks

app: ## Build the app into the package, where the server serves it
	npm --prefix app run build

format: ## Fix lint findings and format the code
	uv run ruff check
	uv run ruff format
	npm --prefix app run lint:fix
	npm --prefix app run format

validate: ## Check the lock file, lint, format, types, tests, and the app without changing files
	uv lock --check
	uv run ruff check --no-fix
	uv run ruff format --check
	uv run ty check
	uv run pytest
	npm --prefix app run validate
