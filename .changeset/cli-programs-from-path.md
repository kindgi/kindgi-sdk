---
"@kindgi/cli": patch
---

**Every program the CLI starts is the one on `PATH`, never a copy in the folder it runs in.** As with git before, the CLI started these by a bare name: docker, the package manager (`pnpm`, `yarn`, `bun`, `npx`), `kindgi doctor`'s tools, a cloud's CLI for a token (`gcloud`, `az`, `aws`), the browser's opener, the feedback editor, an MCP server's runner, and the pack's Python, JDK, Maven and sbt. On Windows, Node looks for a bare name in the folder the program runs in (the pack's, or wherever `kindgi` was started) before `PATH`, unless `NoDefaultCurrentDirectoryInExePath` is set. On every platform, an empty or relative `PATH` entry points into that folder too. So a `docker.exe` or `python.exe` in the pack ran in the real one's place.

Each is now found in `PATH`'s absolute entries and run by that path, and `kindgi dev`'s sandbox wraps the program it found. A command set as a path (`dev.python`, `JAVA_HOME`, `EDITOR=/usr/bin/vim`) runs as given, and a program that isn't on `PATH` fails as it did before. On Windows, a Store app's `python.exe` alias is still found. The WooCommerce starter's `connect-store` script finds its browser opener the same way.
