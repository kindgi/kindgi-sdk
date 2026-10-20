---
"@kindgi/cli": patch
---

`image.buildEnv: { NODE_ENV: 'production' }` no longer leaves a TypeScript pack's build steps without its dev dependencies. The build env is set before the install, and with npm, Yarn 1 or pnpm 9 a `NODE_ENV=production` there narrowed the install to production dependencies, so a build step's tool, such as the `prisma` CLI, was missing. The install now asks for dev dependencies itself (`npm ci --include=dev`, `yarn install --production=false`, `pnpm install --prod=false`); the scripts it runs, the rebuild and the prune to production after the steps are as before.
