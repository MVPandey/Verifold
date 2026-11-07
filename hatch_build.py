"""Builds the person's app into the package when a build starts without it, as `uvx` does from a fresh clone."""

import shutil
import subprocess
from pathlib import Path
from typing import override

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class AppBuildHook(BuildHookInterface):
    """Runs the app's build before Hatchling packs the files, unless the built app is already in the package."""

    @override
    def initialize(self, version: str, build_data: dict[str, object]) -> None:
        root = Path(self.root)
        # An editable install serves the app from the checkout, where `make app` builds it.
        if version == 'editable' or (root / 'src/verifold/web/index.html').is_file():
            return
        npm = shutil.which('npm')
        if npm is None:
            raise RuntimeError('Verifold builds its app with npm. Install Node.js 22.12 or later, then try again.')
        app = root / 'app'
        packages = app / 'node_modules'
        had_packages = packages.is_dir()
        if not had_packages:
            subprocess.run([npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=app, check=True)
        subprocess.run([npm, 'run', 'build'], cwd=app, check=True)
        if not had_packages:
            # uv keeps the clone in its cache, so remove the packages that only this build needed.
            shutil.rmtree(packages)
