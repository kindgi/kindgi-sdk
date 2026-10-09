---
title: Start
description: What Kindgi is, installing it, and your first pack.
sidebar:
  order: 0
  label: Overview
---

Begin here.

1. [What is Kindgi?](introduction/): packs, the runtime, and how your app
   and your coding agent work with them.
2. [Install](install/): Node, Docker, and how a project gets the CLI and
   the SDK.
3. A first pack, running on your machine in ten minutes:
   [TypeScript](quickstart-typescript/), [Python](quickstart-python/),
   [Java](quickstart-java/) or [Scala](quickstart-scala/) (preview).
4. [Add Kindgi to an existing app](existing-app/): your app's own code as
   tools. From a Java app, [call Kindgi with the Java client](java-app/)
   (preview).
5. [Your coding agent](coding-agents/): the skills that teach it Kindgi.
6. Or let your coding agent set it all up: paste this into it, and do what it
   asks ([what it follows](agent/)):

   ```text
   Set up Kindgi for me: read https://docs.kindgi.com/start/agent/ and follow it step by step. Tell me whenever you need me to do something, and wait for me.
   ```

:::tip[Working with a coding agent?]
Once `kindgi init` has run, your coding agent has Kindgi's skills. You can
follow these pages yourself, or ask the agent for what you want: it writes
the tools, agents and flows, and runs them with `kindgi dev` and
`kindgi runs start`. You still name your pack and its agents, and you provide
the credentials, such as your model provider's API key.
[How it knows Kindgi](coding-agents/).
:::
