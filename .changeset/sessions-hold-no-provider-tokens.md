---
"@kindgi/api": patch
---

Sessions no longer hold identity-provider tokens. `Session` and `SessionCreateInput` lose `accessToken` and `refreshToken`, and `POST /v1/auth/refresh` no longer copies them to the new session. Nothing has written them since the API's own OAuth flow was removed. Stored provider tokens are cleared in 0.1.6: the runtime's session store stops reading and writing them and empties them on existing sessions. They're credentials, so nothing keeps them. If you run a session store of your own that kept them, delete them.
