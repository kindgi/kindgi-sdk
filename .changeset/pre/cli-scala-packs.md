---
"@kindgi/cli": patch
"@kindgi/handler-runtime": patch
---

**Scala packs, preview.** A pack whose `kindgi.config.json` says `"language": "scala"` runs under the CLI like a Java pack. Its tools and guardrail checks are in Scala (`com.kindgi %% kindgi-pack-scala`), on kindgi-pack's indexer and pack service.

- **`kindgi init --template=scala`** scaffolds an sbt pack:
  - `build.sbt` (Scala 3.3, Java 17, kindgi-pack-scala at the CLI's version) and `project/build.properties`;
  - `kindgi.config.json`, with the `"cli"` pin and the `kindgiw` wrappers;
  - sample tools, a guardrail, an agent and a flow, as vals of objects named like their files, under a package named from the pack id (Java's and Scala's keywords escaped);
  - a munit suite.
- **`kindgi init` in an sbt app** (a `build.sbt`, or `--template=scala`) makes the app a Scala pack. It writes `kindgi.config.json`, with discovery under `kindgi` packages, and prints the dependency to add, unless the build already declares it.
- **`kindgi dev`** checks the pack's JDK (17 or later, found as for a Java pack) and its sbt (`dev.sbt`, else `sbt` on PATH).
  - It builds through sbt's server (`sbt --client`): the first build starts the server, and a save then compiles in about a second.
  - A change to `*.sbt` or `project/` reloads the build first.
  - Scala 3's and Scala 2's errors are located `file:line:col`.
  - When no server was running, dev owns the one it starts: it sets the server's idle timeout, so a crashed dev's server stops by itself, and shuts it down when dev stops. A server that was already running (an IDE's) is used and left running.
  - `SBT_OPTS` reaches sbt only.
  - The "Try it" commands say `./kindgiw`.
- **`kindgi build`** compiles and indexes locally. Then it builds the image:
  - sbt and JDK 17 in a pinned build image, which exports the runtime classpath as jars;
  - the index, built in the image, byte-identical to the local one;
  - the pack service on a pinned JRE 17, as user 65532.
  - The context leaves out sbt's build output, build-server state and credentials files.
  - A failing sbt step shows sbt's errors.
- **`kindgi doctor`** checks a Scala project's JDK, its sbt (the new `sbt` check), and the kindgi-pack-scala dependency, in `build.sbt` or `project/*.scala`.
- **`kindgi upgrade`** moves a Scala pack's `"cli"` pin and `build.sbt`'s kindgi-pack-scala version together.
- **The loader** accepts `"language": "scala"` in `kindgi.config.json`, with discovery defaults under `src/main/scala/`. A Java pack's image context no longer drops a source package named `target`.
