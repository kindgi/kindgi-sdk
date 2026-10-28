---
"@kindgi/api": patch
---

**An approval's approver, and the check for a second reviewer, compare user ids in either case.** A reviewer's id comes back from the roster in lower case, while an approval keeps the approver's id, and a request its asker's, in the case it was given. A seed user id (`KINDGI_SEED_USER_ID`) could be in upper case before 0.3.0. So:
- **An approval addressed to a member** is listed for, shown to and decided by them whatever the case of the id it names them by.
- **An Improve run's suggested change:** the reviewer who asks to make it live isn't counted as another reviewer who could approve it, whatever the case of their id, so the only reviewer can approve it themselves.
