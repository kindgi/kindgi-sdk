---
"@kindgi/cli": patch
"@kindgi/handler-runtime": patch
"@kindgi/sdk": patch
---

**`kindgi dev` runs your pack's code sandboxed.** The tools' code, often written by a coding agent, runs as you; now it can't read your home folder (SSH keys, cloud credentials, registry tokens, other projects), the secret files in the app (`.env*`, `.kindgi`, `.git`, `kindgi.env`, `pack.env`, `.kindgirc.json`, `.npmrc`, `.pypirc`, `.netrc`), other tools' temp files, or the Docker socket and other UNIX sockets. It can't write outside the app either (on macOS every other folder, where a program it replaced would run later outside the sandbox; on Linux the system is read-only), or write Kindgi's configuration (`kindgi.config.*`, `pyproject.toml`), which `kindgi dev` loads. On macOS the keychain, LaunchServices and Apple Events are closed; on Linux the code gets its own session, away from your terminal. It keeps the network, the app's own files, the runtime and the dependencies, and its own temp folder; a process it starts is inside too, and so is the indexer, which loads every module (and its top-level code) to list the pack.

- **macOS:** Seatbelt (`sandbox-exec`). **Linux:** the system's bubblewrap (`bwrap`), which also hides other processes. Where neither can run (Linux without bwrap, Ubuntu 23.10+ without its AppArmor permission, a container, native Windows, or inside another sandbox), `kindgi dev` warns at start and runs your tools without it.
- **`KINDGI_DEV_SANDBOX`:** `on` (default), `off`, or `required` (stop rather than run without it). `dev.sandbox: false` turns it off for one project.
- **What runs is worked out at every start:** the runtime (Node, a Python interpreter's own paths, a JDK and the classpath), the links its paths go through (a uv-managed Python, SDKMAN's `current`), and a checkout's linked workspace packages; never a folder that holds the home folder.
- **With the sandbox on, `kindgi dev` starts only with one Kindgi configuration in the app**, so code can't add another by a name looked up first.
- **A path or a socket a tool needs:** `dev.sandbox.allowRead` and `dev.sandbox.allowUnixSockets` in the pack's config (`~/.aws` for the AWS SDK's credential chain, a local Postgres socket); `kindgi dev` names each at every start. A path that would open the whole home folder never is.
- **`kindgi doctor`** says whether `kindgi dev` can sandbox your tools here, and what would fix it.
- **The pack service supervisor** (`createPackServiceSupervisor`) takes `command` as a function called before every start, and a `cwd`.
- **The tools skills** tell an agent to open a path in `dev.sandbox.allowRead`, never to turn the sandbox off.
