---
"@kindgi/cli": patch
---

**`kindgi artifacts download` writes the file only once the whole download has arrived.** It writes the bytes to a new file beside the target, and gives that file the target's name only when the stream has ended with the sha256 the server sent. A download that stops part way, or whose bytes have another sha256, fails, says the target wasn't written, and leaves no partial file. Without `--force`, a file that turns up at the target during the download is kept, and the command fails as it does when the file was there from the start. With `--force`, an existing file is no longer overwritten before the download has arrived. A name of `.` or `..` from the server gives the file the blob id. The `size` and `hash` it prints are now those of the bytes it wrote.
