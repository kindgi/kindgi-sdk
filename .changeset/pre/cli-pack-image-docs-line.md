---
"@kindgi/cli": patch
---

`kindgi build --hosted` turns down a pack over 30 MiB with a link to what the pack's image needs. That link now goes to the docs for this CLI's release line, as the models guide's and the dev sandbox's links do. Before, it went to the 0.1 docs whatever the CLI's version.
