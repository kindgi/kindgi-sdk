# Common mistakes

## Contents

- 1. Copying another tool's shape without user intent.
- 2. Passing bare strings to `agent.tools`.
- 3. Forgetting the `Result` unwrap.
- 4. `handler` and `spec` together.
- 5. `{placeholder}` in `urlTemplate` without a matching input key.
- 6. An HTTP tool's `secretRef` in the wrong env.
- 7. Reading a secret from `process.env` in a tool that runs for many tenants.
- 8. Bumping `version` on every dev save.
- 9. A package a tool imports, listed only in `devDependencies`.
- 10. A tool that needs the app's install scripts in the image.
- 11. Turning the dev sandbox off for a file the tool needs.
- 12. Importing a Next.js module that has `import 'server-only'`.
- 13. A default import of a package that ships only CommonJS.

1. **Copying another tool's shape without user intent.** The pack may
   ship `tools/echo/` as a starter example. Copying its skeleton to
   make `tools/lookup/` produces plausible-looking code that solves
   the wrong problem. Ask the user what the new tool should DO first.

2. **Passing bare strings to `agent.tools`.** `tools: ['acme.verify-citation']`
   doesn't type-check (`tools` is `ToolRef[]`), and `defineAgent`
   returns `invalid-agent` for a bare string that slips through. Use
   `[{id: 'acme.verify-citation', version: '^0.1.0'}]`.

3. **Forgetting the `Result` unwrap.** `defineTool` returns
   `Result<DefinedTool, ToolError>` — a bad schema doesn't throw at import
   time unless you check `defined.kind === 'err'`. Always unwrap at
   module load so a broken pack fails LOUDLY, not on first invocation.

4. **`handler` and `spec` together.** Mutually exclusive.
   `defineTool` returns `invalid-tool-definition` with both set.

5. **`{placeholder}` in `urlTemplate` without a matching input key.**
   HTTP tools substitute placeholders from the input at invoke time.
   Missing keys throw a clear error at invoke time — check both sides
   line up.

6. **An HTTP tool's `secretRef` in the wrong env.** The runtime
   resolves `authorization.secretRef` itself, on every call, in the env
   the ref names: `{ envName: 'local', … }` is the pack's `.env` /
   `.env.local` under `kindgi dev`, while `'production'` reads
   `.env.production`. A secret it can't find fails the call with
   `secret-unavailable`, naming it. Only a harness of your own that
   calls `invokeTool` directly has to pass `ctx.resolveSecret`.
7. **Reading a secret from `process.env` in a tool that runs for many
   tenants.** The pack service's environment is one for all of them.
   Declare the secret in `needsSpec.secrets` and read `ctx.secrets`.

8. **Bumping `version` on every dev save.** Old habit from
   frameworks that stored manifests immutably by `(id, version)`.
   Kindgi's dev mode reads tool manifests directly from source —
   version doesn't gate iteration. Bump it when the *contract*
   changes (breaking schema shape, semantic behavior), not when you
   save. See `iterating-and-testing.md`.

9. **A package a tool imports, listed only in `devDependencies`.** The
   deployed pack installs the app's production dependencies only, so the
   import works under `kindgi dev` and fails in the image. When a tool
   imports a new package (an ORM client such as `@prisma/client`, an API
   SDK), check that the app's `package.json` lists it under
   `dependencies`. Build-time tools (the `prisma` CLI, `typescript`) stay
   in `devDependencies`. `kindgi dev` warns as soon as a tool imports one
   ("⚠ The pack imports @prisma/client (in kindgi/tools/…), which
   package.json lists only in devDependencies: …"), and `kindgi build`
   refuses the pack until it moves.
10. **A tool that needs the app's install scripts in the image.** The
    image installs with scripts off, so the app's `postinstall` /
    `prepare` (`prisma generate`, husky) don't run there; `kindgi build`
    lists them ("✓ The app's own install scripts don't run in the image:
    …"). A tool that uses Prisma's client then fails the build ("@prisma/client
    did not initialize yet"). Add `prisma({ schema: 'prisma/schema.prisma' })`
    (from `@kindgi/sdk/build`; add `config: 'prisma.config.ts'` when the app
    has one) to `image.extensions` in `kindgi.config.ts`. Other generate
    steps: `defineBuildExtension({ name, contextFiles, postInstall: [{ bin, args }] })`.
    Debian packages: `image.systemPackages`. Placeholder env for those steps:
    `image.buildEnv` (never secrets).

11. **Turning the dev sandbox off for a file the tool needs.** Under `kindgi dev`
    the tool's code runs sandboxed: it can't read outside the app (the home
    folder, `~/.aws`) or any `.env*` file, and gets `EPERM` there. A tool that
    needs a path names it in `kindgi.config.ts`: `dev: { sandbox: { allowRead: ['~/.aws'] } }`.
    Never set `KINDGI_DEV_SANDBOX=off` or `dev.sandbox: false` to get past it
    (https://docs.kindgi.com/v0.2/guides/secrets/dev-sandbox/).

12. **Importing a Next.js module that has `import 'server-only'`.** Outside
    Next.js that line stops the module from loading, so the tool fails
    `kindgi test`, `kindgi dev` and `kindgi build`. When the app doesn't
    install the package (Next.js doesn't need it), `kindgi test` fails with
    `Cannot find package 'server-only'`, and `kindgi dev` and `kindgi build`
    with `Could not resolve "server-only"`. When it does, all three fail
    with the package's own "This module cannot be imported from a Client
    Component module". Don't remove the line, and don't alias `server-only`
    away in the vitest config: the build still fails. Move the code the tool
    needs, as it is, to a module without the line (`lib/orders-core.ts`).
    The guarded module keeps the line and re-exports it
    (`import 'server-only'; export * from './orders-core';`), so the app's
    own imports don't change, and the tool imports the new module. Nothing
    guards it, so only the app's server code and the pack should import it.

13. **A default import of a package that ships only CommonJS.** A pack's
    code runs as ES modules: `kindgi build` bundles it into `.mjs` files,
    leaving out the packages from `node_modules`, and `kindgi dev` and the
    deployed pack load it with Node's own `import()`. Node gives
    `import OrdersClient from '@acme/orders-client'` the package's whole
    `module.exports`; when the package puts its class on `exports.default`
    (TypeScript's CommonJS output for `export default`), the class is on its
    `default`. Vitest, Next.js, and tsx in an app without `"type": "module"`
    give the class itself. So the tool passes `kindgi test`, and app code it
    imports works in the app, but under `kindgi dev` and once deployed it
    fails with `TypeError: OrdersClient is not a constructor`. With
    `"moduleResolution": "NodeNext"` (a new pack's `tsconfig.json`),
    TypeScript already refuses `new OrdersClient()`; with `"bundler"`
    (Next.js apps) it compiles. This is Node's own behavior, and Kindgi keeps
    it: take the class either way.

    ```ts
    import OrdersClientExport from '@acme/orders-client';

    type DefaultOf<T> = T extends { default: infer C } ? C : T;

    function defaultOf<T>(loaded: T): DefaultOf<T> {
      const value = typeof loaded === 'function' ? loaded : (loaded as { default: unknown }).default;
      return value as DefaultOf<T>;
    }

    const OrdersClient = defaultOf(OrdersClientExport);
    ```

    A dynamic import is the same: `(await import('@acme/orders-client')).default`
    is the class under Vitest and the whole `module.exports` under Node, so
    take it with `defaultOf((await import('@acme/orders-client')).default)`.
