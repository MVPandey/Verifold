# Releasing the CLI

The npm package is `verifold`. The initial owner is `mvpandey`.

## Local checks

Use Node 24 for development and builds. The installed CLI supports Node 22, 24, and 26. Compatibility checks run the packed CLI on the first and latest release of each supported major, including a fake-host research flow. Install dependencies from the lockfile with `npm ci`.

Run `make validate` and `npm run audit:security`. Review the packed file list. Never include local research, credentials, or evaluation records.

The npm package contains compiled harness code and its usage and license documents. It contains no runtime dependencies or install scripts.

Pre-commit and pre-push use `make validate`. Enable them in each clone with `git config --local core.hooksPath .githooks`.

`prepublishOnly` repeats validation and the network security audit when publishing from the source directory. The tag workflow runs these checks before packing. Do not bypass these checks.

## Trusted publishing

The workflow `.github/workflows/publish.yml` publishes matching version tags from commits reachable from `main`.

Configure the npm trusted publisher for:

- GitHub repository: `MVPandey/Verifold`.
- Workflow filename: `publish.yml`.
- Direct publication: allowed.

The workflow uses GitHub-hosted runners and OIDC. It does not need a stored npm publishing token. Official actions are pinned to commit IDs.

The initial package must exist before adding its trusted publisher. The npm owner configures the relationship with two-factor authentication.

After setup, create a release:

1. Change the package version and lockfile on a release branch.
2. Run the checks, commit, and push the release branch.
3. Open a pull request to `main` and merge after all required checks pass.
4. Update local `main`, then create and push a matching tag, such as `v0.2.0`.
5. Confirm the publish workflow and registry version.

The CLI reads its version from package metadata. Do not maintain a second version string.

The build job checks the tag, validates the package, checks dependency advisories, and uploads a packed tarball with its SHA-256 checksum. This job has no OIDC permission.

A separate publishing job verifies the checksum and publishes that exact tarball with provenance. Only this job has OIDC permission. It does not install project dependencies or run a build. A failed gate prevents publication.

Versions are immutable on npm. Use a new version for a correction. Do not move a published release tag.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/) for account setup.
