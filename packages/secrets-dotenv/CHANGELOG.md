# @kindgi/secrets-dotenv

## 0.1.4-rc.4

### Patch Changes

- Updated dependencies [5608264]
  - @kindgi/api@0.1.4-rc.4
  - @kindgi/dotenv-file@0.1.4-rc.4
  - @kindgi/platform@0.1.4-rc.4
  - @kindgi/types@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- Updated dependencies [3e427c5]
  - @kindgi/api@0.1.4-rc.3
  - @kindgi/dotenv-file@0.1.4-rc.3
  - @kindgi/platform@0.1.4-rc.3
  - @kindgi/types@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- Updated dependencies [0b1f48d]
- Updated dependencies [2b34f78]
- Updated dependencies [9a7f43b]
- Updated dependencies [fcc6a97]
- Updated dependencies [86ec2ef]
- Updated dependencies [e97958c]
- Updated dependencies [e2ab2ac]
- Updated dependencies [7528aca]
- Updated dependencies [e58e35c]
- Updated dependencies [8491dd8]
- Updated dependencies [933e00a]
- Updated dependencies [2040daf]
- Updated dependencies [71412f6]
- Updated dependencies [ba2f212]
- Updated dependencies [e7e2f86]
- Updated dependencies [42a2e66]
- Updated dependencies [7155588]
- Updated dependencies [7471e05]
- Updated dependencies [dc5cfb1]
- Updated dependencies [e2ba026]
- Updated dependencies [1bec998]
- Updated dependencies [ffb6096]
- Updated dependencies [ae417f7]
  - @kindgi/api@0.1.4-rc.2
  - @kindgi/types@0.1.4-rc.2
  - @kindgi/platform@0.1.4-rc.2
  - @kindgi/dotenv-file@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- Updated dependencies [0359caf]
- Updated dependencies [b8ff156]
- Updated dependencies [06b5fc0]
- Updated dependencies [8861bf8]
- Updated dependencies [f90c285]
  - @kindgi/api@0.1.4-rc.1
  - @kindgi/platform@0.1.4-rc.1
  - @kindgi/dotenv-file@0.1.4-rc.1
  - @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- Updated dependencies [c313224]
- Updated dependencies [024a47f]
- Updated dependencies [6260a59]
- Updated dependencies [d0ebeb6]
- Updated dependencies [a311b81]
- Updated dependencies [a0652ac]
- Updated dependencies [fa6680c]
- Updated dependencies [fac7472]
- Updated dependencies [d3dffb5]
- Updated dependencies [26b2a23]
- Updated dependencies [b67eee6]
- Updated dependencies [7a8e764]
- Updated dependencies [a0921a1]
- Updated dependencies [d9cee7c]
- Updated dependencies [dde7fdb]
- Updated dependencies [e17b230]
- Updated dependencies [3d23304]
- Updated dependencies [2923703]
- Updated dependencies [bfeabfd]
- Updated dependencies [d0ebeb6]
- Updated dependencies [62608e3]
  - @kindgi/api@0.1.4-rc.0
  - @kindgi/types@0.1.4-rc.0
  - @kindgi/platform@0.1.4-rc.0
  - @kindgi/dotenv-file@0.1.4-rc.0

## 0.1.3

### Patch Changes

- Updated dependencies [2544717]
- Updated dependencies [0f226c2]
- Updated dependencies [629057d]
- Updated dependencies [1463b77]
- Updated dependencies [453056f]
- Updated dependencies [6bae409]
- Updated dependencies [ab23a9b]
- Updated dependencies [6c274dd]
- Updated dependencies [2c185d8]
  - @kindgi/api@0.1.3
  - @kindgi/types@0.1.3
  - @kindgi/platform@0.1.3
  - @kindgi/dotenv-file@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- Updated dependencies [966a615]
- Updated dependencies [610a9de]
  - @kindgi/api@0.1.2
  - @kindgi/dotenv-file@0.1.2
  - @kindgi/platform@0.1.2
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [786ea98]
- Updated dependencies [324aba4]
  - @kindgi/api@0.1.1
  - @kindgi/dotenv-file@0.1.1
  - @kindgi/platform@0.1.1
  - @kindgi/types@0.1.1

## 0.1.0

### Minor Changes

- aec851d: Kindgi inside an existing app: project-local configuration, the app's own env files, nothing leaks.
  
  - **BREAKING — `@kindgi/env-schema`:** the runtime reads only `KINDGI_*` names. `DATABASE_URL` → `KINDGI_DATABASE_URL`, `OPENFGA_API_URL` → `KINDGI_OPENFGA_API_URL`, with no fallback; every unprefixed name belongs to the agents.
  - **`@kindgi/dotenv-file`:** parses the dotenv format the way applications do (verified against `dotenv@16.3.1`), adds `${VAR}` expansion (agrees with dotenv-expand 10 and 12 where they agree) and layered reading. The writer keeps hand-written lines byte for byte and refuses values it can't write back unchanged.
  - **`@kindgi/handler-runtime`:** `loadKindgiConfig` — one loader for `kindgi.config.*` (including `.mts` for CommonJS hosts) that reports a broken config's cause; `resolveDiscovery` walks only each discovery pattern's fixed prefix instead of the whole host repo.
  - **`@kindgi/secrets-dotenv`:** one resolver for a pack's env files (`.env` < `.env.local`, or `dev.envFiles`). `KINDGI_*` names never resolve as secrets, dev writes go only to `.env.local`, and warnings name `file:line`, never the line itself.
  - **`@kindgi/sdk`:** authoring skills updated (a handler with nothing to `await` can return `Promise.resolve`).

### Patch Changes

- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/api@0.1.0
  - @kindgi/types@0.1.0
  - @kindgi/dotenv-file@0.1.0
  - @kindgi/platform@0.1.0
