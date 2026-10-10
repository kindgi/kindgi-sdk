---
"@kindgi/cli": patch
---

**Java and Scala packs are a preview, and say so; their SDK comes from Maven Central.**

- `kindgi init --template=java` and `--template=scala`, and `kindgi init` in a Maven or sbt app, print "(preview)" and what it means: Java and Scala support is tested and supported, but the API may still change in 0.1.6 without the usual deprecation period. The JSON output has `"preview": true`, and the template's README says it too.
- kindgi-pack and kindgi-pack-scala come from Maven Central at the CLI's version. The next steps no longer say to build them from the Kindgi SDK repository, a Scala pack's `build.sbt` names no local resolver, and `kindgi build` makes a Java or Scala pack's image from Central. A CLI run from a Kindgi checkout still installs the checkout's SDK first.
- `kindgi init --help` lists the `scala` template and sbt apps.
