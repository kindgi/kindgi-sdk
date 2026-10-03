---
"@kindgi/handler-runtime": minor
---

`createPackServiceSupervisor` takes an optional `token`: the one its front's callers send. Default: a new random one per supervisor, as before. Pass the previous supervisor's token, with its `port`, so a caller started with both keeps reaching the front across restarts. That caller is a runtime running from source for `kindgi dev --runtime-url`. A given token is at least 32 URL-safe base64 characters.
