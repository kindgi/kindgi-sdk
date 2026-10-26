---
"@kindgi/connections": patch
---

**A Google or Microsoft connection can be the company's mailbox.** The `google` and `microsoft` entries' `owners` are now `['member', 'company']`: a tenant admin connects the company's mailbox by signing in as that mailbox (`support@acme.example`), not as themselves.
- **Gmail's quota costs** are in the `google` entry's rate limit, in Gmail's own units: reading a message 60 (20 for its headers only), a thread 120, a message list 5, the mailbox's history 2 and its profile 1, beside a send's 100.
