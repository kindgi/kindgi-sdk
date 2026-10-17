---
"@kindgi/api": patch
---

**A closing or suspended workspace's refused write says what still changes in it.** The `409 tenant-closing` and `409 tenant-suspended` messages, and S3's `403 AllAccessDisabled`, said nothing in it changes, though its deletes, revocations and erasures still go through. They now name those.
