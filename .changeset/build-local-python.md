---
"@kindgi/cli": patch
---

`kindgi build --local` builds Python packs. It refused them ("build a Python pack with the build service"), and a self-hosted runtime has no build service, so a Python pack couldn't be deployed to one. A Python pack's image now builds with this machine's Docker from the same Containerfile and context as the build service's (its lockfile, frozen; the indexer stage's `/app/index.json` byte-identical to the local index), behind the same integrity gate; with `--push` it's pushed, signed, and written into the envelope for `kindgi deploy`. A Python pack's build context is now written as a directory and tarred the way a TypeScript pack's is, so the build service gets the same bytes as before.
