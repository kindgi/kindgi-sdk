---
"@kindgi/cli": patch
---

**`kindgi dev` on Linux no longer stops when a folder in a Python, Java or Scala pack is removed while it runs.** On Linux, Node's recursive file watch reports a folder removed while it was reading it as an error on the watch, and keeps watching. The pack builders' own watch now hears that error, as their shared watch on macOS already did, and builds, so the result says how the sources are. A Scala pack's build reloads sbt first, as after any change the watch can't name.
