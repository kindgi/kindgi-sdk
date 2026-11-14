---
"@kindgi/connections": patch
"@kindgi/sdk": patch
---

**LinkedIn posts carry images and a link card, and a post can be deleted.** `linkedinPost`, from `@kindgi/connections/linkedin/tools`, takes `images`: 1 to 20 of the run's files, in order, each with its `altText`. One is the post's image, and two or more make a multi-image post. It takes `link` too: a card with its `url`, the `title` it shows (LinkedIn makes no card from a link itself) and a `description`, with one image at most as its thumbnail. `linkedinDeletePost` deletes a post the person made, by the `postId` that posting it gave.

- **Images.** Each is a JPEG, GIF or PNG of fewer than 36,152,320 pixels, LinkedIn's limits. Every image is read and checked before any is uploaded, and a file the run can't read fails the call in words, before anything is posted. The tool declares `readsFiles`, and its network adds `www.linkedin.com`, LinkedIn's upload host: an upload address on any other host is refused. On a runtime that gives a tool no file reads, a post with images fails in words, and a text post works as before.
- **Once per call.** The uploads happen in the recorded step with the post, so a step run again uploads and posts nothing more.
- **Calls.** Each image takes two of the person's 150 LinkedIn calls a day: one to start its upload, and one for its bytes.
- **Deleting.** A post already deleted counts as deleted, and a server error says deleting again is safe. It asks the same `posts.write` permission, and in a run no person started it waits for the person's yes, as a post does.
- **`appFetch`** takes bytes as a `body`, for an upload.
- **Versions.** `linkedinPost` moves to 1.1.0. `linkedinDeletePost` starts at 1.0.0.
- **Docs.** The connections guide, the LinkedIn guide's limits, the package README and the tools authoring skill name the new fields and the delete tool.
