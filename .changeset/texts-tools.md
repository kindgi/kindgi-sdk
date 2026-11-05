---
"@kindgi/types": patch
"@kindgi/tools": patch
"@kindgi/flow": patch
"@kindgi/specs": patch
"@kindgi/runtime": patch
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/cli": patch
"@kindgi/client": patch
---

**A run a text started can answer it.** `@kindgi/agents` offers two built-in tools in such a run: `kindgi_reply_to_text`, when the number grants `texts.reply`, and `kindgi_hand_to_person`.
- A reply goes to the person who texted, on the same number and channel. The number, channel and sender come from the run, never from the model: the reply takes only its text, up to 1600 characters.
- A refusal (`texts-window-closed`, `texts-opted-out`, `texts-with-person`, `texts-not-granted`) comes back to the agent as the tool's output, and nothing is sent.
- The hand-over gives the conversation to a person, with a note for them, and no run answers that thread's texts after it. It doesn't wait for a person's yes the way other changes in such a run do; a workspace or agent rule that always asks still asks.
- `toolsAllowedUnattended` can list the reply and the hand-over.
- A run that waits keeps its thread: `InvokeAgentInput.textThread` is recorded with the run, and a resumed run replies on the thread it started from.
- A pack tool can't use the `texts` app: `defineTool` refuses it (`BUILT_IN_ONLY_APPS`). A flow's tool node can't name a tool built into Kindgi (the `kindgi_` prefix, `BUILT_IN_TOOL_PREFIX`, now exported by `@kindgi/types` too).
