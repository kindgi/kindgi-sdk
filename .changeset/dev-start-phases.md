---
'@kindgi/cli': patch
---

`kindgi dev` says what the runtime's start is doing, step by step, with how long each took: pulling the image (its size, from the image's manifest, then how much has come as each layer arrives), starting the container, migrating the database (when the runtime reports it), and waiting for it to serve. A step still going says so every 3 seconds, in place of "still starting the runtime (3s elapsed)", and the serving line gives the start's total time.
