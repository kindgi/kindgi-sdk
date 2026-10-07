---
"@kindgi/cli": patch
---

**The CLI knows when it runs as `kindgi-cli`**, the PyPI build for Python developers, with Node from a wheel. Its launcher sets `KINDGI_CLI_INSTALL=pypi`, and then:
- **its hints for a Python pack say `uv run kindgi …`**, or `poetry run kindgi …` in a Poetry project, instead of `npx --yes @kindgi/cli@0.x …`, which needs Node;
- **`kindgi init --template=python`** lists `kindgi-cli` in the pack's dev group next to pytest, in the same minor range as `kindgi`, so `uv sync` brings the CLI too;
- **in an existing Python app**, `kindgi init`'s next steps add the line that installs it (`uv add --dev`, `poetry add --group dev`, or `pip install`);
- **a TypeScript pack is refused before anything starts:** the PyPI build has no bundler. The message names the npm CLI (`npm install --save-dev @kindgi/cli`).

Every `esbuild` load goes through one loader, which gives the same message.

**`kindgi doctor` under kindgi-cli** passes Node as the one the wheel brings, skips npm (a Python pack doesn't need it), and its fixes say `uv run kindgi …`, or `uvx --from kindgi-cli kindgi …` outside a project.

From the npm CLI, nothing changes.
