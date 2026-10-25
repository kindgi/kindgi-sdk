---
"@kindgi/log": patch
"@kindgi/tools": patch
"@kindgi/handler-runtime": patch
---

**A tool's error says why it failed.** A tool whose fetch failed used to report only `fetch failed`. The reason was in the error's cause, which no run showed. Now the message names each cause, Node's way:

```text
Handler for tool "acme.list-orders" threw: TypeError: fetch failed; caused by ConnectTimeoutError [UND_ERR_CONNECT_TIMEOUT]: Connect Timeout Error (attempted address: shop.acme.example:443, timeout: 10000ms)
```

- **Where:** a pack tool's handler, a check's `evaluate`, a pack file that fails to import, and a tool run in the server's own process. Every place a failure shows carries the message: the run's record, its events, the console, the model's retry and the CLI.
- **Three causes at most,** each on one line and cut at 500 characters, never inside a word. A cause the message already says is left out.
- **A refused connection names its addresses:** `AggregateError [ECONNREFUSED]: connect ECONNREFUSED ::1:4000, connect ECONNREFUSED 127.0.0.1:4000`.
- **An error without a cause reads as it did.**
- **The message is masked, its causes and the error's own words alike.** A Kindgi token becomes `[redacted]` whole, a `Bearer` value is redacted, a URL's password becomes `***`, and a URL's secret query or fragment value becomes `[redacted]`. `?token=`, `#access_token=`, `X-Amz-Signature=`, a SAS `sig=` and `?key=` are covered. Log lines keep their form, a token's last four included.
- **A pack tool's own secrets and connection tokens are taken out first,** at any depth of the error, before the message is masked or cut. So no part of one is left, a connection string's host included.
- **`@kindgi/log`** exports `describeCauses(err)`, which gives the `; caused by …` text, and `scrubText(text, { fullMask: true })`, which is the mask for an error a run shows.
