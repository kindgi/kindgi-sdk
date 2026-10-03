---
"@kindgi/cli": patch
---

The Python SDK, `kindgi`, publishes to PyPI with the npm packages, at `0.1.0`.

- **`kindgi init` for a Python pack, from a published CLI**, writes `kindgi` from PyPI within the CLI's own minor: `kindgi>=0.1,<0.2` for a 0.1 CLI. That covers the new template, an existing app's `pyproject.toml`, and the install line it prints, quoted for the shell. A CLI run from a Kindgi checkout keeps using the checkout's `sdks/python`.
- **`check:publish`** fails when `sdks/python` and the npm packages don't share a major.minor.
- **`release.yml`** publishes `kindgi` to PyPI on the same dispatch, in its own `pypi-publish` environment, with trusted publishing and attestations. A version PyPI already has is skipped.
