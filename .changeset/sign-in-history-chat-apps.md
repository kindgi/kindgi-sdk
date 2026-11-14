---
"@kindgi/api": patch
"@kindgi/client": patch
---

**A person's sign-in history lists their chat apps.** `GET /v1/audit/sign-ins` has three new kinds: `chat-app-connected`, `chat-app-refresh-refused` (with `reason`) and `chat-app-disconnected`, with a new optional `clientId` naming the chat app. Its `?kind=` filter now lists every kind the route takes (the three second-factor kinds were missing from the spec), and the TypeScript client's `SignInEvent` gains `byUserId` and `clientId`.
