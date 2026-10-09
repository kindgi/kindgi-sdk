---
"@kindgi/api": patch
"@kindgi/cli": patch
---

Time inputs follow the API's `date-time` format: an ISO 8601 time with a zone (Postgres `timestamptz` text is also accepted). Anything else gets `400 bad-input`. That includes a date without a time or zone, which was read in the server's zone, and anything else `Date.parse` used to take, such as `"Oct 9"` or `"1"`, which reached the store unchecked. One rule now covers every time the API reads, list cursors included:
- cost and eval-run `from`/`to` (eval runs checked none before);
- compliance evidence `from`/`to`, in the query and in the export filter;
- authz audit `from`/`to`;
- observations `since`/`until`;
- provenance and approvals `createdAfter`;
- memory `asOf` and fact times;
- memory erasure replay times;
- the test-set build's `since`/`until`;
- deployment `publishedAt`;
- API key `expiresAt`;
- secret `rotationDueAt`.

The CLI's time flags accept an ISO 8601 time with a zone, or a date (read as that day's start in UTC), and send either as a full ISO time, so a date given to the CLI never meets the new 400. Anything else is refused before any call. The flags are `--since`/`--until`, `--as-of`, `--created-after`, `--expires` (its durations stay), `--published-at` and `--rotation-due-at`.
