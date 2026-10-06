---
"@kindgi/cli": patch
---

`kindgi agents promotions list --table` has a STATUS column, so a refused or pending promotion no longer reads like one that went live. It shows the promotion's `status` (`promoted`, `pending-approval`, `refused`, `superseded`, `rejected`, `expired`). A promotion made before gates shows `promoted`, and a rollback or unpin, which take effect at once, shows `done`.
