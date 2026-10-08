---
title: Tools
description: Write a tool in TypeScript or Python, call an HTTP API without code, give a tool a secret or per-project values, mark it read-only, and use an MCP server's tools.
sidebar:
  order: 0
  label: Overview
---

A tool is a function with a typed input and a typed output. Agents call
tools, and so do flow steps. Kindgi checks the input before your code runs
and the output after it returns, so neither side gets malformed data.

- [Write a tool](write-a-tool/): a function in TypeScript or Python, tried
  from a flow, tested, and wired onto an agent.
- [Call an HTTP API without code](http-tools/): a tool that is one HTTP
  request, made by Kindgi.
- [Give a tool a secret](give-a-tool-a-secret/): declare the secret, read it
  from the call's context, keep it out of your code.
- [Give a tool per-project values](give-a-tool-env-values/): env values set
  for a tenant, an org or a project, read from the call's context.
- [Mark a tool read-only](read-only-tools/): what `mutating: false` changes
  for dry runs and approval gates.
- [Use an MCP server's tools](mcp-servers/): register an MCP server, and its
  tools become tools your agents and flows call.

The examples use the pack from the quickstarts, `my-pack`
([TypeScript](../../start/quickstart-typescript/),
[Python](../../start/quickstart-python/)), with `kindgi dev` running.
