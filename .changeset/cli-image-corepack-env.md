---
"@kindgi/cli": patch
---

A TypeScript pack that installs with pnpm or Yarn no longer starts with a warning that its pack service dropped `COREPACK_ENABLE_DOWNLOAD_PROMPT`. `kindgi build` set it on the image's base stage, so the final image carried it, and the pack service drops every variable the pack doesn't declare. It's now set only in the install stage, where corepack fetches the package manager. Rebuild the pack's image with this CLI to stop the warning; nothing else in the image changes.
