---
"@kindgi/cli": patch
"@kindgi/handler-runtime": patch
---

**Java packs, preview.** A pack whose config is a `kindgi.config.json` with `"language": "java"` runs under the CLI like a TypeScript or Python pack. Its tools and guardrail checks are in Java (`com.kindgi:kindgi-pack`).

- **`kindgi init --template=java`** scaffolds a Maven pack:
  - `pom.xml` with kindgi-pack at the CLI's version, and the Maven wrapper;
  - `kindgi.config.json`;
  - sample tools, a guardrail, an agent and a flow, under a package named from the pack id;
  - a JUnit test.
- **`kindgi init` in a Maven app** (a `pom.xml`, or `--template=java`) makes the app a Java pack. It writes `kindgi.config.json`, with discovery under `kindgi` packages, and prints the dependency to add.
- **`kindgi dev`** checks the pack's JDK (17 or later: `dev.javaHome`, else `JAVA_HOME`, else `java` on PATH) and its Maven (`dev.maven`, else the pack's `mvnw`, else `mvn`). It compiles with Maven, recompiling on save with javac's errors located `file:line:col`. It indexes with the Java indexer and runs the pack service through its launcher, which keeps the service token out of the JVM's environment. `MAVEN_ARGS` and `MAVEN_OPTS` reach Maven only. On Windows, `kindgi dev` runs a Java pack under WSL.
- **`kindgi build`** compiles and indexes locally. Then it builds the image:
  - Maven and JDK 17 in a pinned build image;
  - the index, built in the image, byte-identical to the local one;
  - the pack service on a pinned JRE 17, as user 65532.
- **`kindgi doctor`** checks a Java project's JDK, its Maven, and the kindgi-pack dependency.
- **The loader** reads `kindgi.config.json`. That file next to another pack config (`kindgi.config.ts`, `[tool.kindgi]`) is refused, naming both files and which one to keep.
