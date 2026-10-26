---
'@kindgi/cli': patch
---

**The `woocommerce` template's store agent takes its instructions from a prompt block the pack brings.** Their text is `blocks/store-agent-prompt.liquid`, and the block's file `blocks/store-agent-prompt.json` (`<pack>.store-agent-prompt`, the pack's version). The agent names it by range (`instructions: { prompt: '<pack>.store-agent-prompt', version: '^0.1.0' }`), so `kindgi deploy` publishes it with the agent, and a prompt pass (`kindgi proposals improve --tier=prompt`) can draft new instructions from it. The words are the ones the agent held before. The agent's own test reads them from the block. The README and AGENTS.md say where they live, and that a change to them needs a new version within the agent's range, since a deploy refuses a version whose content changed.
