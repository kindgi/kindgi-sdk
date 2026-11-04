---
"@kindgi/api": patch
---

**`/mcp` offers agents and flows as tools, and follows a run in its own view.**

- **One tool per agent or flow** whose author exposed it (`mcp.expose`) and that the person can see. It needs the `kindgi:run` scope.
  - A call starts the run as the person, with an idempotency key, so a chat app's retry doesn't start a second run.
  - It names no project. The run lands where the runtime puts it: for an agent, the conversation's project when the call continues one, else the agent's own; for a flow, its own. It needs only the right to run it there. Naming a project asks `write` on it, which no chat scope holds.
  - It waits up to 25 seconds. A longer run goes on in Kindgi, and the call answers with the run's state, so no call stays open past a chat app's time limit.
  - A run the person may not start answers the route's refusal in words.
- **`kindgi.run_state`** reads a run as the person: whether it goes on, what it waits for, and its answer and files once it ends.
  - A chat app's model waits for a run that goes on with it: `waitSeconds` (at most 25) answers as soon as the run ends or waits for someone, and the model calls again until it ends. A run tool's answer for a run that goes on says so.
  - The run view calls it with no wait.
- **The run view** (`ui://kindgi/run.html`, an MCP Apps resource) follows the run to its end, through `kindgi.run_state`.
  - It shows what the run waits for, with console links.
  - When the run is done, its answer: at most 8,000 characters, with the rest in the console.
  - Its files' names.
  - When the run ends, a short note in the model's context. The view never sends a message as the person.
- **What a chat sees of a run.** Answer text is marked as agent output, to treat as data. A chat never gets the start answer's access token, an agent's instructions, an approval's context, or a connect link. A connect starts from the console.
