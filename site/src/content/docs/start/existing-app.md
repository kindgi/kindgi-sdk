---
title: Add Kindgi to an existing app
description: Add Kindgi to the app you already have, in TypeScript or Node, Python, Java or Scala, so your tools are your app's own code.
sidebar:
  order: 5
---

Add Kindgi to the app you already have: run `kindgi init` in it, and the
pack lives beside your code. Its tools import your app's own code, and your
app starts runs through the SDK. Pick your app's language.

:::tip[Your coding agent can do most of this]
`kindgi init` gives your app Kindgi's skills, in `.claude/skills/` and
`.agents/skills/`. After that, you can ask your coding agent instead of
following each step: "make a Kindgi tool from our order lookup", "add an
agent that uses it", "run it". It writes the code next to yours, runs it
with `kindgi dev`, and asks you for your model's key. [How it knows
Kindgi](../coding-agents/).
:::

## A TypeScript or Node app

A Next.js, Node or other TypeScript app, with a `package.json`:
[Add Kindgi to a TypeScript or Node app](../existing-app-typescript/). In a
Next.js app, a tool can't import a module that imports `server-only`: [move
the code it needs](../existing-app-typescript/#code-that-imports-server-only)
into a module without that line.

## A Python app

An app with a `pyproject.toml`, with uv, Poetry or pip:
[Add Kindgi to a Python app](../existing-app-python/).

## A Java app (Maven)

An app built with Maven, with a `pom.xml`:
[Add Kindgi to a Java app](../existing-app-java/). Java support is in
preview.

## A Scala app (sbt)

An app built with sbt, with a `build.sbt`:
[Add Kindgi to a Scala app](../existing-app-scala/). Scala support is in
preview.

## Starting runs from your app

Once the pack is in, your app starts runs and reads their answers through
the SDK's client: [Start runs from your app](../call-from-your-app/) in
TypeScript or Python, or [Call Kindgi from a Java app](../java-app/).

## Next

- [Quickstart: TypeScript](../quickstart-typescript/): a pack of its own,
  with every primitive.
- [Guides](../../guides/): one task at a time.
