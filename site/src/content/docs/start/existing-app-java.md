---
title: Add Kindgi to a Java app
description: Add Kindgi to the Java app you already have, built with Maven, so your tools are your app's own classes.
sidebar:
  order: 5.3
  label: "Existing app: Java"
  badge: { text: 'Preview', variant: 'caution', class: 'kg-preview' }
---

This page adds Kindgi to a Java app you already have, built with Maven. The
pack lives beside your code: its tools call your app's classes.

**Before you start**, set up what the [Install page](../install/) describes:
Docker, Node 22.12 or later (or uv, to run the CLI from PyPI), and access to
the runtime image. You also need a JDK 17 or later, with `JAVA_HOME` set to
it. In the app's folder, `npx --yes @kindgi/cli@0.1 doctor`
checks Node, Docker and access to the runtime image, and says how to fix
what's missing. Run it again after `kindgi init`, and it checks the JDK and Maven too.

:::caution[Preview]
**Preview.** Java and Scala support is tested and supported, but its API may
still change in a later release without the usual deprecation period.
:::

In the app's directory (where its `pom.xml` is), with a JDK 17 or later and
`JAVA_HOME` set:

```sh
npx --yes @kindgi/cli@0.1 init   # --pack-id=<id> if the app's artifactId doesn't make one
```

`init` writes `kindgi.config.json`: the pack id from the app's `artifactId`,
its version, the Kindgi CLI version it pins (`"cli"`, which `./kindgiw` runs,
also written), and discovery under `kindgi` packages
(`src/main/java/**/kindgi/tools/**/*.java`, and so on), so your app's own
`tools` packages are never taken for Kindgi's. It leaves `pom.xml` alone and
prints the dependency to add to it:

```text
…
  Kindgi added to … (a Java pack in the app; preview).
…
  Pack id: acme    Version: 0.1.0
  Wrote 14 files; skipped 0.
  Next steps:
    Add to pom.xml's <dependencies>:
      <dependency>
        <groupId>com.kindgi</groupId>
        <artifactId>kindgi-pack</artifactId>
        <version>…</version>
      </dependency>
…
```

Ask your coding agent: "Add the Kindgi dependency to our pom.xml."
Kindgi's skills in your app tell it how
([How it knows Kindgi](../coding-agents/)). For reference, it adds this to
`pom.xml`'s `<dependencies>`:

```xml
<dependency>
  <groupId>com.kindgi</groupId>
  <artifactId>kindgi-pack</artifactId>
  <version>…</version>
</dependency>
```

kindgi-pack comes from Maven Central, at the CLI's version. It needs Jackson
2.18 or later in your app (it declares 2.18.11): in a Spring Boot app, Spring
Boot 3.4 or later. An app with both a `package.json` and a `pom.xml` gets a
TypeScript pack unless you pass `--template=java`.

Then start Kindgi:

```sh
./kindgiw dev
```

Until you add a tool, it has nothing to register:

```text
…
  No primitives yet — add a tool or agent under src/main/java/; it registers on save.
…
    ✓ Kindgi is up
…
```

Without the dependency, the pack doesn't build, and `kindgi dev` says so
(`com.kindgi.pack isn't on the pack's classpath: add the com.kindgi:kindgi-pack dependency to pom.xml.`).
It keeps the runtime running: add the dependency and save.

`kindgi dev` runs the app's own Maven (its `mvnw`, else `mvn`; `dev.maven` in
`kindgi.config.json` names another, such as `["mvn", "-s", "settings.xml"]`)
and its JDK (`JAVA_HOME`, or `dev.javaHome`). `MAVEN_ARGS` and `MAVEN_OPTS`
reach Maven, never the pack.

A tool is a class in a `kindgi.tools` package under your own, and calls your
app's code directly. Ask your coding agent: "Make a Kindgi tool from our
customer order lookup." For reference, the tool looks like this:

```java
// src/main/java/com/acme/kindgi/tools/CustomerOrders.java
package com.acme.kindgi.tools;

import com.acme.orders.OrderService;
import com.kindgi.pack.Tool;
import java.util.List;
import java.util.Map;

public final class CustomerOrders {
  public record Input(String customerId) {}

  public record Output(List<Map<String, Object>> orders) {}

  public static final Tool<Input, Output> TOOL = Tool.define("acme.customer-orders")
      .description("The customer's orders, newest first.")
      .input(Input.class)
      .output(Output.class)
      .mutating(false)
      .handler((input, ctx) -> new Output(OrderService.findOrders(input.customerId())));

  private CustomerOrders() {}
}
```

`mutating(false)` says the tool only reads, so a dry run may call it.

A class your tool uses must be on the app's runtime classpath (`compile` or
`runtime` scope, not `test` or `provided`): the pack's image copies the
runtime dependencies only. Other public classes in a `kindgi.tools` package
must define a tool; a helper there is package-private, or a record, an enum
or an interface.

## Next

- [Call Kindgi from a Java app](../java-app/): start runs and follow them
  with the Java client.
- [Quickstart: Java](../quickstart-java/): a pack of its own, with every
  primitive.
- [Write a tool](../../guides/tools/write-a-tool/).

<!-- check-samples: stand-ins for your app's own code that the samples above import; the docs' sample check reads them, readers don't see them.

```java
// src/main/java/com/acme/orders/OrderService.java
package com.acme.orders;

import java.util.List;
import java.util.Map;

public final class OrderService {
  public static List<Map<String, Object>> findOrders(String customerId) {
    return List.of();
  }
}
```
-->
