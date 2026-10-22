---
title: Add Kindgi to a Scala app
description: Add Kindgi to the Scala app you already have, built with sbt, so your tools are your app's own code.
sidebar:
  order: 5.4
  label: "Existing app: Scala"
  badge: { text: 'Preview', variant: 'caution', class: 'kg-preview' }
---

This page adds Kindgi to a Scala app you already have, built with sbt. The
pack lives beside your code: its tools call your app's code.

**Before you start**, set up what the [Install page](../install/) describes:
Docker, Node 22.12 or later (or uv, to run the CLI from PyPI), and access to
the runtime image. You also need a JDK 17 or later, with `JAVA_HOME` set to
it, and sbt 1.10 or later. In the app's folder, `npx --yes @kindgi/cli@0.1 doctor`
checks Node, Docker and access to the runtime image, and says how to fix
what's missing. Run it again after `kindgi init`, and it checks the JDK and sbt too.

:::caution[Preview]
**Preview.** Java and Scala support is tested and supported, but its API may
still change in a later release without the usual deprecation period.
:::

In the app's directory (where its `build.sbt` is), with a JDK 17 or later,
`JAVA_HOME` set, and sbt:

```sh
npx --yes @kindgi/cli@0.1 init   # --pack-id=<id> if the build's name doesn't make one
```

`init` writes `kindgi.config.json`: the pack id from the build's `name`, its
version, the Kindgi CLI version it pins (`"cli"`, which `./kindgiw` runs, also
written), and discovery under `kindgi` packages
(`src/main/scala/**/kindgi/tools/**/*.scala`, and so on), so your app's own
`tools` packages are never taken for Kindgi's. It leaves `build.sbt` alone and
prints what to add to it:

```text
…
  Kindgi added to … (a Scala pack in the app; preview).
…
  Pack id: acme    Version: 0.1.0
  Wrote 14 files; skipped 0.
  Next steps:
    Add to build.sbt:
      libraryDependencies += "com.kindgi" %% "kindgi-pack-scala" % "…"
…
```

Ask your coding agent: "Add the Kindgi dependency to our build.sbt."
Kindgi's skills in your app tell it how
([How it knows Kindgi](../coding-agents/)). For reference, it adds this
line to `build.sbt`:

```scala
libraryDependencies += "com.kindgi" %% "kindgi-pack-scala" % "…"
```

kindgi-pack-scala, and kindgi-pack under it, come from Maven Central at the
CLI's version. Like kindgi-pack, it needs Jackson 2.18 or later in your app. An app with a `build.sbt` next to a `package.json` or a
`pom.xml` gets a TypeScript or Java pack unless you pass `--template=scala`.

Then start Kindgi:

```sh
./kindgiw dev
```

Until you add a tool, it has nothing to register:

```text
…
  No primitives yet — add a tool or agent under src/main/scala/; it registers on save.
…
    ✓ Kindgi is up
…
```

Without the dependency, the pack doesn't build, and `kindgi dev` says so
(`com.kindgi.pack isn't on the pack's classpath: add "com.kindgi" %% "kindgi-pack-scala" to build.sbt's libraryDependencies.`).
It keeps the runtime running: add the dependency and save.

`kindgi dev` builds through the app's sbt server (`sbt --client`): it starts
one when none is running and stops it when it stops, and a server your IDE
runs is used and left running. `dev.sbt` in `kindgi.config.json` names
another sbt (such as `["sbt", "-mem", "2048"]`) and `dev.javaHome` another
JDK. `SBT_OPTS` reaches sbt, never the pack.

A tool is a `val` of an object in a `kindgi.tools` package under your own,
named like its file, and calls your app's code directly. Ask your coding
agent: "Make a Kindgi tool from our customer order lookup." For reference,
the tool looks like this:

```scala
// src/main/scala/com/acme/kindgi/tools/CustomerOrders.scala
package com.acme.kindgi.tools

import com.acme.orders.{Order, OrderService}
import com.kindgi.pack.scaladsl._

object CustomerOrders {
  final case class Input(customerId: String)
  final case class Output(orders: Seq[Order])

  val tool: Tool[Input, Output] = Tool[Input, Output]("acme.customer-orders")
    .description("The customer's orders, newest first.")
    .readOnly
    .handler((in, _) => Output(OrderService.findOrders(in.customerId)))
}
```

`readOnly` says the tool only reads, so a dry run may call it.

A class your tool uses must be on the app's runtime classpath (not `% Test`
or `% Provided`): the pack's image ships the runtime classpath only. In a
`kindgi.tools` package, a file with no object (a model) or a case class's
companion is a helper; an object whose tool is a `def` or a `lazy val` is an
error that asks for a `val`. The
[Scala quickstart's known limits](../quickstart-scala/#known-limits) apply.

## Next

- [Call Kindgi from a Java app](../java-app/): the Java client works from
  Scala too.
- [Quickstart: Scala](../quickstart-scala/): a pack of its own, with every
  primitive.
- [Write a tool](../../guides/tools/write-a-tool/).

<!-- check-samples: stand-ins for your app's own code that the samples above import; the docs' sample check reads them, readers don't see them.

```scala
// src/main/scala/com/acme/orders/OrderService.scala
package com.acme.orders

final case class Order(id: String, total: BigDecimal)

object OrderService {
  def findOrders(customerId: String): Seq[Order] = Seq.empty
}
```
-->
