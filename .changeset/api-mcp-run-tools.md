---
"@kindgi/api": patch
---

**`/mcp` offers agents and flows as tools, and follows a run in its own view.**

- **One tool per agent or flow** whose author exposed it (`mcp.expose`) and that the person can see. It needs the `kindgi:run` scope.
  - A call starts the run as the person, with an idempotency key, so a chat app's retry doesn't start a second run.
  - It waits up to 25 seconds. A longer run goes on in Kindgi, and the call answers with the run's state, so no call stays open past a chat app's time limit.
  - A run the person may not start answers the route's refusal in words.
- **The run view** (`ui://kindgi/run.html`, an MCP Apps resource) follows the run to its end, through `kindgi.run_state`, which only the view calls.
  - It shows what the run waits for, with console links.
  - When the run is done, its answer: at most 8,000 characters, with the rest in the console.
  - Its files' names.
  - A button that asks the chat about the result. The message names the run only, never its answer.
- **What a chat sees of a run.** Answer text is marked as agent output, to treat as data. A chat never gets the start answer's access token, an agent's instructions, an approval's context, or a connect link. A connect starts from the console.
