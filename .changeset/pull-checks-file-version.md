---
"@kindgi/cli": patch
"@kindgi/handler-runtime": patch
---

**`kindgi blocks pull` and `kindgi suggested-changes pull` never write over a block file that holds edits.** Before either writes, it compares each block's file, and its template file, with the version the file says it is, as the runtime has it (`GET /v1/blocks/{blockId}/versions/{version}`). A file that holds other content is refused, and so is a file at a version the runtime doesn't have, since whether it holds edits can't be told. Every refused file is named before any is written. A settings file that gives no schema holds a version the runtime stored with the schema it carried, as a deploy holds it. `suggested-changes pull` checks a file older than the version the suggested change is built on the same way.

`@kindgi/handler-runtime` exports `holdsContent(kind, fileContent, versionContent)`, the compare both use; `writePackBlock`'s `expected` uses it too.
