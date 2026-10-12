---
"@kindgi/agents": patch
"@kindgi/api": patch
---

**A gate past the tenant's limit on approvals waiting fails its step, naming the limit.**
- **The contract:** a HITL binding's `enqueue` refuses an approval past the tenant's limit by throwing an error with `code: 'approvals-pending-limit'` (and `approvalsPending`, the limit).
- **In a turn:** the tool gate and the session gate then fail the turn with `ApprovalsPendingLimitError`, never waiting for an approval nobody can see. Any other `enqueue` failure stays soft, as before.
- **Over the API:**
  - `approvals-pending-limit` answers `429`;
  - a promotion whose gate wants an approval past the limit is refused with it (`PromotionErrorCode`);
  - `POST /v1/runs` documents its `429`s: that one, and `rate-limit-exceeded` with `details.limit: 'runs-pending'` past the tenant's limit on runs waiting to start.
