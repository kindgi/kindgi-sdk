---
"@kindgi/cli": patch
---

**`kindgi dev` no longer fails a Scala pack's rebuild now and then with "sbt printed no classpath".** sbt's thin client sometimes drops the server's output: the build succeeds, but the classpath line from `export Runtime/fullClasspath` never arrives. When sbt succeeds without that line, `kindgi dev` now runs `export Runtime/fullClasspath` again, alone, up to two more times, and gives the same error only if no try prints it. A failed build answers as before. An export run again that fails answers the same way, with sbt's errors, and isn't tried again.
