# kindgi-cli

The [Kindgi](https://kindgi.com) CLI for Python developers. It's the same CLI as the npm package `@kindgi/cli`, with Node brought in as a Python dependency ([`nodejs-wheel-binaries`](https://pypi.org/project/nodejs-wheel-binaries/)). A Python project needs only Python, uv and Docker:

```sh
uvx --from kindgi-cli kindgi init my-pack --template=python   # a new Python pack
cd my-pack
uv sync                                                        # kindgi and kindgi-cli
uv run kindgi dev                                              # Kindgi locally, reloading on save
```

In an existing project: `uv add --dev kindgi-cli`, then `uv run kindgi …`.

It's a dev dependency: a production image built with `kindgi build` carries no Node.

This build is for Python packs. A TypeScript pack uses the npm CLI (`npm install --save-dev @kindgi/cli`). Docs: [docs.kindgi.com](https://docs.kindgi.com).

The wheel carries `@kindgi/cli` and the npm packages it depends on; their licenses are in `THIRD-PARTY-NOTICES.txt`.
