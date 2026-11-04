---
"@kindgi/cli": patch
---

**`kindgi init` tells a published CLI from a source checkout by the `@kindgi/sdk` spec in the CLI's own package.json, not by where the CLI sits.** It used to call any CLI outside a `node_modules` folder a checkout. A packed CLI copied somewhere else (a `pnpm deploy` folder, an unpacked tarball) then got `file:` or `link:` specs pointing into its own folder, and a Python, Java or Scala pack stopped with "the Kindgi checkout is incomplete". Now, wherever the CLI sits:

- A version (`0.4.0`, `^0.4.0`, `0.5.0-rc.1`) means a published CLI. The project pins it, as from `node_modules` before.
- `workspace:*` means a checkout only with a `pnpm-workspace.yaml` at or above the CLI. With none, init stops and says the packed CLI's `workspace:` specs were never replaced by versions. Under `node_modules`, it stays a publisher error.
- Any other spec (`link:`, `file:`, `catalog:`, a URL, `latest`, or none) stops init with an error that names it. Under `node_modules`, such a spec used to be copied into the project as it was.
- Python, Java and Scala packs read the same spec. Under `node_modules`, they used to take any CLI as published, and now stop with the same named error for a spec that isn't a version.
