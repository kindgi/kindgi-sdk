---
"@kindgi/cli": patch
---

`kindgi doctor`'s fixes name a package manager this machine has. When a project declares pnpm (or yarn, or bun) but that tool isn't installed, the fixes use npm instead: `npm install`, saying the project names the other one, and `npx --no kindgi …`.
