---
"@kindgi/cli": patch
---

**`kindgi artifacts download` writes the file only once the whole download has arrived.** It writes the bytes to a new file beside the target, and renames that over the target only when the stream has ended with the sha256 the server sent. A download that stops part way, or whose bytes have another sha256, fails, says the target wasn't written, and leaves no partial file. With `--force`, an existing file is no longer overwritten before the download has arrived. The `size` and `hash` it prints are now those of the bytes it wrote.
