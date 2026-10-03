---
"@kindgi/handler-runtime": minor
"@kindgi/sdk": minor
"@kindgi/cli": minor
---

Build extensions for a TypeScript pack image: `image` in `kindgi.config.*`, with `@kindgi/sdk/build`.

```ts
import { prisma } from '@kindgi/sdk/build';

export default {
  pack: { id: 'acme.app', version: '1.0.0' },
  image: {
    systemPackages: ['tesseract-ocr'],
    extensions: [prisma({ schema: 'prisma/schema.prisma', config: 'prisma.config.ts' })],
    buildEnv: { DATABASE_URL: 'postgresql://build-placeholder' },
  },
};
```

- **`@kindgi/handler-runtime/build-extensions`**, re-exported as **`@kindgi/sdk/build`**:
  - `ImageConfig` and `BuildExtension` (`contextFiles`, `systemPackages`, `postInstall` steps, `buildEnv`);
  - `prisma({ schema, config? })`: copies the schema in and runs `prisma generate` after the install, before the prune. An app's `postinstall` doesn't run in the image;
  - `defineBuildExtension()`.
- **`kindgi build`** reads and checks `image`, naming any field that's wrong, then renders it:
  - system packages in the base stage;
  - `buildEnv` in the install stage only, never the final image;
  - each step after the install, through the app's package manager (`pnpm exec`, `npx --no`, `yarn`).
