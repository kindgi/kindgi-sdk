# @kindgi/sandbox

## 0.1.6

### Patch Changes

- @kindgi/types@0.1.6

## 0.1.5

### Patch Changes

- Updated dependencies [eff6249]
  - @kindgi/types@0.1.5

## 0.1.5-rc.0

### Patch Changes

- Updated dependencies [eff6249]
  - @kindgi/types@0.1.5-rc.0

## 0.1.4

### Patch Changes

- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
- Updated dependencies [2040daf]
- Updated dependencies [ae417f7]
  - @kindgi/types@0.1.4

## 0.1.4-rc.5

### Patch Changes

- @kindgi/types@0.1.4-rc.5

## 0.1.4-rc.4

### Patch Changes

- @kindgi/types@0.1.4-rc.4

## 0.1.4-rc.3

### Patch Changes

- @kindgi/types@0.1.4-rc.3

## 0.1.4-rc.2

### Patch Changes

- Updated dependencies [2040daf]
- Updated dependencies [ae417f7]
  - @kindgi/types@0.1.4-rc.2

## 0.1.4-rc.1

### Patch Changes

- @kindgi/types@0.1.4-rc.1

## 0.1.4-rc.0

### Patch Changes

- Updated dependencies [fac7472]
- Updated dependencies [26b2a23]
  - @kindgi/types@0.1.4-rc.0

## 0.1.3

### Patch Changes

- Updated dependencies [1463b77]
  - @kindgi/types@0.1.3

## 0.1.2

### Patch Changes

- 966a615: CommonJS apps can `require()` Kindgi. Every package's `exports` gives a `default` condition beside `import`, so `require('@kindgi/sdk/client')` loads the ES modules through Node's `require()` of ES modules, instead of failing with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There's still one copy of each module, so the same code runs from either kind of app.
  
  - Node 22.12 or later: every package's `engines.node` is `>=22.12.0` (Node loads ES modules with `require()` from 22.12 on), and so are the apps `kindgi init` creates.
  - TypeScript that compiles to CommonJS needs TypeScript 5.8 or later with `module: nodenext`, or `moduleResolution: bundler` in an app a bundler builds.
  - `@kindgi/handler-runtime`'s program entries (`pack-service-main`, `kindgi-index-main`) stay ES-modules-only: they run with `node`.
- Updated dependencies [966a615]
  - @kindgi/types@0.1.2

## 0.1.1

### Patch Changes

- @kindgi/types@0.1.1

## 0.1.0

### Patch Changes

- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
- Updated dependencies [aec851d]
  - @kindgi/types@0.1.0
