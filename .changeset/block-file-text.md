---
"@kindgi/handler-runtime": patch
---

**`blockFileText(text, kind, write)`** writes a block's new version into its file's text without touching disk, and answers the new text (`BlockFileText`). `writePackBlock` now writes through it, and a runtime uses it to commit a pinned block version to the pack's repository. The file keeps its other fields, their order and its indentation. A prompt whose file names `content.templateFile` keeps that field, and its new template comes back apart, for the caller to write into that file. It's refused (`invalid`) for content that doesn't fit the kind, or text that isn't this block's file, and (`not-newer`) for a version that isn't past the file's.
