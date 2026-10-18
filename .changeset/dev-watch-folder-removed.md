---
"@kindgi/cli": patch
---

**`kindgi dev` on Linux no longer stops when a folder in a Python, Java or Scala pack is removed while it runs.** On Linux, Node's recursive file watch reports a folder removed while it was reading it as an error on the watch, and keeps watching. The pack builders' own watch now hears that error and goes on: the folder's removal still comes as a change, and builds when it's a change to the pack's code. Any other error on the watch, such as the system's limit on file watches reached, may have hidden a change, and builds, as on the shared watch on macOS, so the result says how the sources are. One in a folder no build reads (a build's own output, such as `target/`, or a `.venv`) builds nothing, so a build that writes there doesn't set off the next. A Scala pack's build after such an error reloads sbt first, as after any change the watch can't name.
