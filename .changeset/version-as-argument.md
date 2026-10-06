---
"@kindgi/cli": patch
---

`kindgi tools get-version`, `kindgi tools unregister` and `kindgi tools reinstate` take the version as an argument: `kindgi tools get-version acme.echo 1.2.0`. Their `--version=<semver>` never worked, since the global `--version` flag (print the CLI's version) took it first and refused a value. `kindgi flows unregister` takes it the same way. A test over every command now refuses a command option that shares a global flag's name or short flag.
