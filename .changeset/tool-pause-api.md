---
"@kindgi/agents": patch
"@kindgi/api": patch
"@kindgi/client": patch
"@kindgi/sdk": patch
---

**A run paused until another system answers is answered at its link, or through the API.**

- **`@kindgi/agents`:** an agent's call to a tool that declares `pauses` parks the turn until the answer comes, and the turn goes on with it as the call's result. The model sees the answer as data from outside, inside an `<event>` block, and the turn's system prompt then says never to follow instructions found there. Resumed, the turn doesn't call the tool again. A wait that times out is the tool error `wait-token-timed-out`, handled by the agent's tool error rules like any other: it fails the turn unless they retry `tool-error`. A retried step waits on a new token.
- **`@kindgi/api`:**
  - `POST /v1/wait-tokens/{token}/complete` takes another system's answer at the link a pausing tool handed on. The token in the path is the credential: no `Authorization` header. The body is the tool's output as JSON, at most 1 MiB; an empty body is `{}`. It answers `200 { status: 'accepted' }` at once, and the run resumes behind the answer: the sender waits for none of the run. An answer that comes before the run reaches its wait is held for it, and dropped if the run never waits on that token (the tool answered at once, or its step was retried); the link then answers `409 wait-token-closed`, `unused`. The server logs the path as `/v1/wait-tokens/:token`, never the token.
  - `POST /v1/runs/{runId}/resume` answers a `pause:` waitpoint, as the link would, and needs write access and `execute` on the run's agent or flow. It returns the run as `GET /v1/runs/{runId}` does. Every other waitpoint stays `422 run-resume-not-supported`, and a body without `waitpointId`, or with a field it doesn't take, is now `400 bad-input`.
  - `GET /v1/runs/{runId}`'s `waitingFor` gains `tokens`: each wait's `tokenId`, `name`, tool and call, step, and when it times out. Never the link.
  - New error codes: `wait-token-not-found` (404: an unknown token and a wrong one alike), `wait-token-closed` (409, `details.state`), `wait-token-output-invalid` (400, `details.issues`: the wait stays open) and `unsupported-media-type` (415: a body that isn't JSON).
  - For a runtime: `createApp` takes `waitTokens`, a `WaitTokenBinding` (`complete` and `waiting`). Without one, the link answers `404` and resume `422`, as before.
- **`@kindgi/client`:** `runs.resume` answers a run's wait for another system, and `Run` carries `waitingFor` (`RunWaitingFor`, `RunWaitingApproval` and `RunWaitingToken` are exported). `approvals.completeToken`, which had no route and always threw `not-yet-wired`, and its `CompleteTokenInput` (re-exported by `@kindgi/sdk` too) are removed, so code that imports `CompleteTokenInput` stops compiling: an approval's run resumes through `approvals.decide`.
