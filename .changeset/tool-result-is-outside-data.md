---
"@kindgi/tools": patch
"@kindgi/specs": patch
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/handler-runtime": patch
"@kindgi/connections": patch
"@kindgi/sdk": patch
---

**A tool can say its results are text from outside: `resultIsOutsideData`.** A tool manifest's new optional `resultIsOutsideData: true` says the tool's results are text nobody checked, such as a mail someone sent. An agent then reads each result of it as data, not instructions:
- in an `<event>` block;
- in that turn, and again in every later turn's history;
- with the framework's line about outside data in the system message from the turn's start.

It changes what the model is told, not what the tool may do. The pack index carries it, and `GET /v1/tools` shows it. `outlookMessagesList` and `outlookMessageGet` set it, so both move to version 1.1.0: a project that has 1.0.0 gets the flag when it takes 1.1.0.
