---
"@kindgi/connections": patch
---

**A Google or Microsoft connection can be the company's mailbox.** The `google` and `microsoft` entries' `owners` are now `['member', 'company']`: a tenant admin connects the company's mailbox by signing in as that mailbox (`support@acme.example`), not as themselves.
- **Gmail's quota costs** are in the `google` entry's rate limit, in Gmail's own units: reading a message 60 (20 for its headers only), a thread 120, a message list 5, the mailbox's history 2 and its profile 1, beside a send's 100.
- **`gmailMessagesList`** (`@kindgi/connections/google/tools`) lists or searches a Gmail mailbox, newest first: each message's subject, sender, when it came, the start of its text and whether it's unread. It needs only `gmail.readonly`.
- **`as: 'company'`** on `gmailSend`, `gmailMessagesList`, `outlookSend`, `outlookMessagesList` and `outlookMessageGet` makes the tool use the company's mailbox instead of the person's own. `as` is part of what a tool declares, so an id you've published keeps its `as`: give a company mailbox its own tool id (`acme.store-mail.list`).
- **`@kindgi/connections/mail`**: `MailMessage`, one shape for a message from Gmail or Outlook, and `MailFunctions`, the calls a runtime makes to watch a mailbox for new mail and read it for a run.
- **`gmailMessageGet`** reads one message whole and answers a `MailMessage`: who it's from and to, its reply-to, its subject, its text (the plain-text part, else the HTML as text: the first 50,000 characters), its attachments' names, types and sizes, and whether it's an automatic reply. It needs only `gmail.readonly`.
- **`googleMail`** (`@kindgi/connections/google/mail`) is Gmail's `MailFunctions`. `start` gives the mailbox's latest history id; `changes` reads the new mail in a label since it; `since` lists a label's mail from a time, for a catch-up after Gmail forgets a history id; and `read` gives a message with the earlier messages of its thread, within a budget. They're called with a token and a `fetch`, and paced by the `google` entry's rate limits, as the tools are.
