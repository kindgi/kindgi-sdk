// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Kindgi Inc.

/**
 * Lockfiles the package managers wrote for one app, for
 * `build-loaded-install.test.ts`: a workspace whose member `apps/support`
 * is the pack (pnpm 10, npm 11, yarn 1.22), and a single project (pnpm 12,
 * with its env document, here cut to two platforms). The member loads
 * chalk (a catalog entry under pnpm), debug, ms 2.0.0 (debug has its own
 * ms 2.1.3), react-dom (react as its peer), is-number 7.0.0 (patched under
 * pnpm; the root has 6.0.0), and the root has left-pad for development.
 *
 * They live here as text, not as lockfile-named files, so nothing reads
 * them as the repository's own dependencies.
 */

import type { ReduceInputs } from '../src/build/loaded-install.js';

/** An app's install, as `reduceInstall` reads it: everything but what the pack loads. */
export type LockFixture = Omit<ReduceInputs, 'roots' | 'tools' | 'peers'>;

/** pnpm 10.28: a workspace with a catalog, an override, a patch and a public hoist pattern. */
export const PNPM_WORKSPACE: LockFixture = {
  manager: 'pnpm',
  packRel: 'apps/support',
  files: [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'apps/support/package.json',
    'patches/is-number@7.0.0.patch',
  ],
  lockfile: {
    name: 'pnpm-lock.yaml',
    text: `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

catalogs:
  default:
    chalk:
      specifier: ^4.1.2
      version: 4.1.2

overrides:
  has-flag: 4.0.0

patchedDependencies:
  is-number@7.0.0:
    hash: a6ed8e9a2df1dc7919678cd07ff18ff7c2c527d32c76db28fb412a08a85b0f9f
    path: patches/is-number@7.0.0.patch

importers:

  .:
    dependencies:
      is-number:
        specifier: 6.0.0
        version: 6.0.0
    devDependencies:
      left-pad:
        specifier: 1.3.0
        version: 1.3.0

  apps/support:
    dependencies:
      chalk:
        specifier: 'catalog:'
        version: 4.1.2
      debug:
        specifier: 4.3.7
        version: 4.3.7
      is-number:
        specifier: 7.0.0
        version: 7.0.0(patch_hash=a6ed8e9a2df1dc7919678cd07ff18ff7c2c527d32c76db28fb412a08a85b0f9f)
      ms:
        specifier: 2.0.0
        version: 2.0.0
      react:
        specifier: 18.3.1
        version: 18.3.1
      react-dom:
        specifier: 18.3.1
        version: 18.3.1(react@18.3.1)
    devDependencies:
      left-pad:
        specifier: 1.3.0
        version: 1.3.0

packages:

  ansi-styles@4.3.0:
    resolution: {integrity: sha512-zbB9rCJAT1rbjiVDb2hqKFHNYLxgtk8NURxZ3IZwD3F6NtxbXZQCnnSi1Lkx+IDohdPlFp222wVALIheZJQSEg==}
    engines: {node: '>=8'}

  chalk@4.1.2:
    resolution: {integrity: sha512-oKnbhFyRIXpUuez8iBMmyEa4nbj4IOQyuhc/wy9kY7/WVPcwIO9VA668Pu8RkO7+0G76SLROeyw9CpQ061i4mA==}
    engines: {node: '>=10'}

  color-convert@2.0.1:
    resolution: {integrity: sha512-RRECPsj7iu/xb5oKYcsFHSppFNnsj/52OVTRKb4zP5onXwVF3zVmmToNcOfGC+CRDpfK/U584fMg38ZHCaElKQ==}
    engines: {node: '>=7.0.0'}

  color-name@1.1.4:
    resolution: {integrity: sha512-dOy+3AuW3a2wNbZHIuMZpTcgjGuLU/uBL/ubcZF9OXbDo8ff4O8yVp5Bf0efS8uEoYo5q4Fx7dY9OgQGXgAsQA==}

  debug@4.3.7:
    resolution: {integrity: sha512-Er2nc/H7RrMXZBFCEim6TCmMk02Z8vLC2Rbi1KEBggpo0fS6l0S1nnapwmIi3yW/+GOJap1Krg4w0Hg80oCqgQ==}
    engines: {node: '>=6.0'}
    peerDependencies:
      supports-color: '*'
    peerDependenciesMeta:
      supports-color:
        optional: true

  has-flag@4.0.0:
    resolution: {integrity: sha512-EykJT/Q1KjTWctppgIAgfSO0tKVuZUjhgMr17kqTumMl6Afv3EISleU7qZUzoXDFTAHTDC4NOoG/ZxU3EvlMPQ==}
    engines: {node: '>=8'}

  is-number@6.0.0:
    resolution: {integrity: sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==}
    engines: {node: '>=0.10.0'}

  is-number@7.0.0:
    resolution: {integrity: sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==}
    engines: {node: '>=0.12.0'}

  js-tokens@4.0.0:
    resolution: {integrity: sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ==}

  left-pad@1.3.0:
    resolution: {integrity: sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==}
    deprecated: use String.prototype.padStart()

  loose-envify@1.4.0:
    resolution: {integrity: sha512-lyuxPGr/Wfhrlem2CL/UcnUc1zcqKAImBDzukY7Y5F/yQiNdko6+fRLevlw1HgMySw7f611UIY408EtxRSoK3Q==}
    hasBin: true

  ms@2.0.0:
    resolution: {integrity: sha512-Tpp60P6IUJDTuOq/5Z8cdskzJujfwqfOTkrwIwj7IRISpnkJnT6SyJ4PCPnGMoFjC9ddhal5KVIYtAt97ix05A==}

  ms@2.1.3:
    resolution: {integrity: sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==}

  react-dom@18.3.1:
    resolution: {integrity: sha512-5m4nQKp+rZRb09LNH59GM4BxTh9251/ylbKIbpe7TpGxfJ+9kv6BLkLBXIjjspbgbnIBNqlI23tRnTWT0snUIw==}
    peerDependencies:
      react: ^18.3.1

  react@18.3.1:
    resolution: {integrity: sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ==}
    engines: {node: '>=0.10.0'}

  scheduler@0.23.2:
    resolution: {integrity: sha512-UOShsPwz7NrMUqhR6t0hWjFduvOzbtv7toDH1/hIrfRNIDBnnBWd0CwJTGvTpngVlmwGCdP9/Zl/tVrDqcuYzQ==}

  supports-color@7.2.0:
    resolution: {integrity: sha512-qpCAvRl9stuOHveKsn7HncJRvv501qIacKzQlO/+Lwxc9+0q2wLyv4Dfvt80/DPn2pqOBsJdDiogXGR9+OvwRw==}
    engines: {node: '>=8'}

snapshots:

  ansi-styles@4.3.0:
    dependencies:
      color-convert: 2.0.1

  chalk@4.1.2:
    dependencies:
      ansi-styles: 4.3.0
      supports-color: 7.2.0

  color-convert@2.0.1:
    dependencies:
      color-name: 1.1.4

  color-name@1.1.4: {}

  debug@4.3.7:
    dependencies:
      ms: 2.1.3

  has-flag@4.0.0: {}

  is-number@6.0.0: {}

  is-number@7.0.0(patch_hash=a6ed8e9a2df1dc7919678cd07ff18ff7c2c527d32c76db28fb412a08a85b0f9f): {}

  js-tokens@4.0.0: {}

  left-pad@1.3.0: {}

  loose-envify@1.4.0:
    dependencies:
      js-tokens: 4.0.0

  ms@2.0.0: {}

  ms@2.1.3: {}

  react-dom@18.3.1(react@18.3.1):
    dependencies:
      loose-envify: 1.4.0
      react: 18.3.1
      scheduler: 0.23.2

  react@18.3.1:
    dependencies:
      loose-envify: 1.4.0

  scheduler@0.23.2:
    dependencies:
      loose-envify: 1.4.0

  supports-color@7.2.0:
    dependencies:
      has-flag: 4.0.0
`,
  },
  rootManifest: {
    name: 'acme-app',
    private: true,
    packageManager: 'pnpm@10.28.0',
    dependencies: {
      'is-number': '6.0.0',
    },
    devDependencies: {
      'left-pad': '1.3.0',
    },
  },
  packManifest: {
    name: '@acme/support',
    version: '0.1.0',
    private: true,
    dependencies: {
      chalk: 'catalog:',
      debug: '4.3.7',
      ms: '2.0.0',
      react: '18.3.1',
      'react-dom': '18.3.1',
      'is-number': '7.0.0',
    },
    devDependencies: {
      'left-pad': '1.3.0',
    },
  },
  workspaceText: `packages:
  - apps/*

catalog:
  chalk: ^4.1.2

overrides:
  has-flag: 4.0.0

patchedDependencies:
  is-number@7.0.0: patches/is-number@7.0.0.patch

publicHoistPattern:
  - supports-color
`,
};

/** pnpm 12.4: a single project; the lockfile starts with pnpm's env document. */
export const PNPM_ENV: LockFixture = {
  manager: 'pnpm',
  packRel: '',
  files: ['package.json', 'pnpm-lock.yaml'],
  lockfile: {
    name: 'pnpm-lock.yaml',
    text: `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 12.4.2
        version: 12.4.2

packages:

  '@pnpm/exe.darwin-arm64@12.4.2':
    resolution: {integrity: sha512-A0WDo8iErfZBXgrLseQxw8i8Y9ctUpOEl/Uu+cubnTzpD8tT9ykIB548L8YTM2WD4OS+ZOHSxy8aGZcvKq8PaQ==}
    cpu: [arm64]
    os: [darwin]

  '@pnpm/exe.linux-x64@12.4.2':
    resolution: {integrity: sha512-/pbt0UVTa8NMDhzOWLQRfZ6G9ROKXlJPZtx845BqyWfc7hCrWXhTLBd70yO2y8+E+IWN3oHM1s/JsIQNGk1yvg==}
    cpu: [x64]
    os: [linux]
    libc: [glibc]

  pnpm@12.4.2:
    resolution: {integrity: sha512-CK3GYTGAJ1x8ntraOdzwjJxhrU5+rzMKTzRh8QKw+QdCNFTRF/mOctR/7wYWBwZE17/8lzpqV/UJCm18NosHyQ==}
    engines: {node: '>=18.*'}
    hasBin: true

snapshots:

  '@pnpm/exe.darwin-arm64@12.4.2':
    optional: true

  '@pnpm/exe.linux-x64@12.4.2':
    optional: true

  pnpm@12.4.2:
    optionalDependencies:
      '@pnpm/exe.darwin-arm64': 12.4.2
      '@pnpm/exe.linux-x64': 12.4.2

---
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      chalk:
        specifier: ^4.1.2
        version: 4.1.2
      debug:
        specifier: 4.3.7
        version: 4.3.7(supports-color@7.2.0)
      is-number:
        specifier: 7.0.0
        version: 7.0.0
      ms:
        specifier: 2.0.0
        version: 2.0.0
      react:
        specifier: 18.3.1
        version: 18.3.1
      react-dom:
        specifier: 18.3.1
        version: 18.3.1(react@18.3.1)
    devDependencies:
      left-pad:
        specifier: 1.3.0
        version: 1.3.0

packages:

  ansi-styles@4.3.0:
    resolution: {integrity: sha512-zbB9rCJAT1rbjiVDb2hqKFHNYLxgtk8NURxZ3IZwD3F6NtxbXZQCnnSi1Lkx+IDohdPlFp222wVALIheZJQSEg==}
    engines: {node: '>=8'}

  chalk@4.1.2:
    resolution: {integrity: sha512-oKnbhFyRIXpUuez8iBMmyEa4nbj4IOQyuhc/wy9kY7/WVPcwIO9VA668Pu8RkO7+0G76SLROeyw9CpQ061i4mA==}
    engines: {node: '>=10'}

  color-convert@2.0.1:
    resolution: {integrity: sha512-RRECPsj7iu/xb5oKYcsFHSppFNnsj/52OVTRKb4zP5onXwVF3zVmmToNcOfGC+CRDpfK/U584fMg38ZHCaElKQ==}
    engines: {node: '>=7.0.0'}

  color-name@1.1.4:
    resolution: {integrity: sha512-dOy+3AuW3a2wNbZHIuMZpTcgjGuLU/uBL/ubcZF9OXbDo8ff4O8yVp5Bf0efS8uEoYo5q4Fx7dY9OgQGXgAsQA==}

  debug@4.3.7:
    resolution: {integrity: sha512-Er2nc/H7RrMXZBFCEim6TCmMk02Z8vLC2Rbi1KEBggpo0fS6l0S1nnapwmIi3yW/+GOJap1Krg4w0Hg80oCqgQ==}
    engines: {node: '>=6.0'}
    peerDependencies:
      supports-color: '*'
    peerDependenciesMeta:
      supports-color:
        optional: true

  has-flag@4.0.0:
    resolution: {integrity: sha512-EykJT/Q1KjTWctppgIAgfSO0tKVuZUjhgMr17kqTumMl6Afv3EISleU7qZUzoXDFTAHTDC4NOoG/ZxU3EvlMPQ==}
    engines: {node: '>=8'}

  is-number@7.0.0:
    resolution: {integrity: sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==}
    engines: {node: '>=0.12.0'}

  js-tokens@4.0.0:
    resolution: {integrity: sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ==}

  left-pad@1.3.0:
    resolution: {integrity: sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==}
    deprecated: use String.prototype.padStart()

  loose-envify@1.4.0:
    resolution: {integrity: sha512-lyuxPGr/Wfhrlem2CL/UcnUc1zcqKAImBDzukY7Y5F/yQiNdko6+fRLevlw1HgMySw7f611UIY408EtxRSoK3Q==}
    hasBin: true

  ms@2.0.0:
    resolution: {integrity: sha512-Tpp60P6IUJDTuOq/5Z8cdskzJujfwqfOTkrwIwj7IRISpnkJnT6SyJ4PCPnGMoFjC9ddhal5KVIYtAt97ix05A==}

  ms@2.1.3:
    resolution: {integrity: sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==}

  react-dom@18.3.1:
    resolution: {integrity: sha512-5m4nQKp+rZRb09LNH59GM4BxTh9251/ylbKIbpe7TpGxfJ+9kv6BLkLBXIjjspbgbnIBNqlI23tRnTWT0snUIw==}
    peerDependencies:
      react: ^18.3.1

  react@18.3.1:
    resolution: {integrity: sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ==}
    engines: {node: '>=0.10.0'}

  scheduler@0.23.2:
    resolution: {integrity: sha512-UOShsPwz7NrMUqhR6t0hWjFduvOzbtv7toDH1/hIrfRNIDBnnBWd0CwJTGvTpngVlmwGCdP9/Zl/tVrDqcuYzQ==}

  supports-color@7.2.0:
    resolution: {integrity: sha512-qpCAvRl9stuOHveKsn7HncJRvv501qIacKzQlO/+Lwxc9+0q2wLyv4Dfvt80/DPn2pqOBsJdDiogXGR9+OvwRw==}
    engines: {node: '>=8'}

snapshots:

  ansi-styles@4.3.0:
    dependencies:
      color-convert: 2.0.1

  chalk@4.1.2:
    dependencies:
      ansi-styles: 4.3.0
      supports-color: 7.2.0

  color-convert@2.0.1:
    dependencies:
      color-name: 1.1.4

  color-name@1.1.4: {}

  debug@4.3.7(supports-color@7.2.0):
    dependencies:
      ms: 2.1.3
    optionalDependencies:
      supports-color: 7.2.0

  has-flag@4.0.0: {}

  is-number@7.0.0: {}

  js-tokens@4.0.0: {}

  left-pad@1.3.0: {}

  loose-envify@1.4.0:
    dependencies:
      js-tokens: 4.0.0

  ms@2.0.0: {}

  ms@2.1.3: {}

  react-dom@18.3.1(react@18.3.1):
    dependencies:
      loose-envify: 1.4.0
      react: 18.3.1
      scheduler: 0.23.2

  react@18.3.1:
    dependencies:
      loose-envify: 1.4.0

  scheduler@0.23.2:
    dependencies:
      loose-envify: 1.4.0

  supports-color@7.2.0:
    dependencies:
      has-flag: 4.0.0
`,
  },
  rootManifest: {
    name: 'acme-app',
    packageManager: 'pnpm@12.4.2',
    version: '0.1.0',
    private: true,
    dependencies: {
      chalk: '^4.1.2',
      debug: '4.3.7',
      ms: '2.0.0',
      react: '18.3.1',
      'react-dom': '18.3.1',
      'is-number': '7.0.0',
    },
    devDependencies: {
      'left-pad': '1.3.0',
    },
  },
  packManifest: {},
};

/** npm 11: a workspace; the member's is-number 7.0.0 is nested under apps/support. */
export const NPM_WORKSPACE: LockFixture = {
  manager: 'npm',
  packRel: 'apps/support',
  files: ['package.json', 'package-lock.json', 'apps/support/package.json'],
  lockfile: {
    name: 'package-lock.json',
    text: `{
  "name": "acme-app",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "acme-app",
      "workspaces": [
        "apps/*"
      ],
      "dependencies": {
        "is-number": "6.0.0"
      },
      "devDependencies": {
        "left-pad": "1.3.0"
      }
    },
    "apps/support": {
      "name": "@acme/support",
      "version": "0.1.0",
      "dependencies": {
        "chalk": "^4.1.2",
        "debug": "4.3.7",
        "is-number": "7.0.0",
        "ms": "2.0.0",
        "react": "18.3.1",
        "react-dom": "18.3.1"
      },
      "devDependencies": {
        "left-pad": "1.3.0"
      }
    },
    "apps/support/node_modules/is-number": {
      "version": "7.0.0",
      "resolved": "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
      "integrity": "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==",
      "license": "MIT",
      "engines": {
        "node": ">=0.12.0"
      }
    },
    "node_modules/@acme/support": {
      "resolved": "apps/support",
      "link": true
    },
    "node_modules/ansi-styles": {
      "version": "4.3.0",
      "resolved": "https://registry.npmjs.org/ansi-styles/-/ansi-styles-4.3.0.tgz",
      "integrity": "sha512-zbB9rCJAT1rbjiVDb2hqKFHNYLxgtk8NURxZ3IZwD3F6NtxbXZQCnnSi1Lkx+IDohdPlFp222wVALIheZJQSEg==",
      "license": "MIT",
      "dependencies": {
        "color-convert": "^2.0.1"
      },
      "engines": {
        "node": ">=8"
      },
      "funding": {
        "url": "https://github.com/chalk/ansi-styles?sponsor=1"
      }
    },
    "node_modules/chalk": {
      "version": "4.1.2",
      "resolved": "https://registry.npmjs.org/chalk/-/chalk-4.1.2.tgz",
      "integrity": "sha512-oKnbhFyRIXpUuez8iBMmyEa4nbj4IOQyuhc/wy9kY7/WVPcwIO9VA668Pu8RkO7+0G76SLROeyw9CpQ061i4mA==",
      "license": "MIT",
      "dependencies": {
        "ansi-styles": "^4.1.0",
        "supports-color": "^7.1.0"
      },
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/chalk/chalk?sponsor=1"
      }
    },
    "node_modules/color-convert": {
      "version": "2.0.1",
      "resolved": "https://registry.npmjs.org/color-convert/-/color-convert-2.0.1.tgz",
      "integrity": "sha512-RRECPsj7iu/xb5oKYcsFHSppFNnsj/52OVTRKb4zP5onXwVF3zVmmToNcOfGC+CRDpfK/U584fMg38ZHCaElKQ==",
      "license": "MIT",
      "dependencies": {
        "color-name": "~1.1.4"
      },
      "engines": {
        "node": ">=7.0.0"
      }
    },
    "node_modules/color-name": {
      "version": "1.1.4",
      "resolved": "https://registry.npmjs.org/color-name/-/color-name-1.1.4.tgz",
      "integrity": "sha512-dOy+3AuW3a2wNbZHIuMZpTcgjGuLU/uBL/ubcZF9OXbDo8ff4O8yVp5Bf0efS8uEoYo5q4Fx7dY9OgQGXgAsQA==",
      "license": "MIT"
    },
    "node_modules/debug": {
      "version": "4.3.7",
      "resolved": "https://registry.npmjs.org/debug/-/debug-4.3.7.tgz",
      "integrity": "sha512-Er2nc/H7RrMXZBFCEim6TCmMk02Z8vLC2Rbi1KEBggpo0fS6l0S1nnapwmIi3yW/+GOJap1Krg4w0Hg80oCqgQ==",
      "license": "MIT",
      "dependencies": {
        "ms": "^2.1.3"
      },
      "engines": {
        "node": ">=6.0"
      },
      "peerDependenciesMeta": {
        "supports-color": {
          "optional": true
        }
      }
    },
    "node_modules/debug/node_modules/ms": {
      "version": "2.1.3",
      "resolved": "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz",
      "integrity": "sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==",
      "license": "MIT"
    },
    "node_modules/has-flag": {
      "version": "4.0.0",
      "resolved": "https://registry.npmjs.org/has-flag/-/has-flag-4.0.0.tgz",
      "integrity": "sha512-EykJT/Q1KjTWctppgIAgfSO0tKVuZUjhgMr17kqTumMl6Afv3EISleU7qZUzoXDFTAHTDC4NOoG/ZxU3EvlMPQ==",
      "license": "MIT",
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/is-number": {
      "version": "6.0.0",
      "resolved": "https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz",
      "integrity": "sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==",
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/js-tokens": {
      "version": "4.0.0",
      "resolved": "https://registry.npmjs.org/js-tokens/-/js-tokens-4.0.0.tgz",
      "integrity": "sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ==",
      "license": "MIT"
    },
    "node_modules/left-pad": {
      "version": "1.3.0",
      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      "integrity": "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==",
      "deprecated": "use String.prototype.padStart()",
      "dev": true,
      "license": "WTFPL"
    },
    "node_modules/loose-envify": {
      "version": "1.4.0",
      "resolved": "https://registry.npmjs.org/loose-envify/-/loose-envify-1.4.0.tgz",
      "integrity": "sha512-lyuxPGr/Wfhrlem2CL/UcnUc1zcqKAImBDzukY7Y5F/yQiNdko6+fRLevlw1HgMySw7f611UIY408EtxRSoK3Q==",
      "license": "MIT",
      "dependencies": {
        "js-tokens": "^3.0.0 || ^4.0.0"
      },
      "bin": {
        "loose-envify": "cli.js"
      }
    },
    "node_modules/ms": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/ms/-/ms-2.0.0.tgz",
      "integrity": "sha512-Tpp60P6IUJDTuOq/5Z8cdskzJujfwqfOTkrwIwj7IRISpnkJnT6SyJ4PCPnGMoFjC9ddhal5KVIYtAt97ix05A==",
      "license": "MIT"
    },
    "node_modules/react": {
      "version": "18.3.1",
      "resolved": "https://registry.npmjs.org/react/-/react-18.3.1.tgz",
      "integrity": "sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ==",
      "license": "MIT",
      "dependencies": {
        "loose-envify": "^1.1.0"
      },
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/react-dom": {
      "version": "18.3.1",
      "resolved": "https://registry.npmjs.org/react-dom/-/react-dom-18.3.1.tgz",
      "integrity": "sha512-5m4nQKp+rZRb09LNH59GM4BxTh9251/ylbKIbpe7TpGxfJ+9kv6BLkLBXIjjspbgbnIBNqlI23tRnTWT0snUIw==",
      "license": "MIT",
      "dependencies": {
        "loose-envify": "^1.1.0",
        "scheduler": "^0.23.2"
      },
      "peerDependencies": {
        "react": "^18.3.1"
      }
    },
    "node_modules/scheduler": {
      "version": "0.23.2",
      "resolved": "https://registry.npmjs.org/scheduler/-/scheduler-0.23.2.tgz",
      "integrity": "sha512-UOShsPwz7NrMUqhR6t0hWjFduvOzbtv7toDH1/hIrfRNIDBnnBWd0CwJTGvTpngVlmwGCdP9/Zl/tVrDqcuYzQ==",
      "license": "MIT",
      "dependencies": {
        "loose-envify": "^1.1.0"
      }
    },
    "node_modules/supports-color": {
      "version": "7.2.0",
      "resolved": "https://registry.npmjs.org/supports-color/-/supports-color-7.2.0.tgz",
      "integrity": "sha512-qpCAvRl9stuOHveKsn7HncJRvv501qIacKzQlO/+Lwxc9+0q2wLyv4Dfvt80/DPn2pqOBsJdDiogXGR9+OvwRw==",
      "license": "MIT",
      "dependencies": {
        "has-flag": "^4.0.0"
      },
      "engines": {
        "node": ">=8"
      }
    }
  }
}
`,
  },
  rootManifest: {
    name: 'acme-app',
    private: true,
    workspaces: ['apps/*'],
    dependencies: {
      'is-number': '6.0.0',
    },
    devDependencies: {
      'left-pad': '1.3.0',
    },
  },
  packManifest: {
    name: '@acme/support',
    version: '0.1.0',
    private: true,
    dependencies: {
      chalk: '^4.1.2',
      debug: '4.3.7',
      ms: '2.0.0',
      react: '18.3.1',
      'react-dom': '18.3.1',
      'is-number': '7.0.0',
    },
    devDependencies: {
      'left-pad': '1.3.0',
    },
  },
};

/** yarn 1.22: a workspace; the lockfile has no peers. */
export const YARN_CLASSIC_WORKSPACE: LockFixture = {
  manager: 'yarn',
  packRel: 'apps/support',
  files: ['package.json', 'yarn.lock', 'apps/support/package.json'],
  lockfile: {
    name: 'yarn.lock',
    text: `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


ansi-styles@^4.1.0:
  version "4.3.0"
  resolved "https://registry.yarnpkg.com/ansi-styles/-/ansi-styles-4.3.0.tgz#edd803628ae71c04c85ae7a0906edad34b648937"
  integrity sha512-zbB9rCJAT1rbjiVDb2hqKFHNYLxgtk8NURxZ3IZwD3F6NtxbXZQCnnSi1Lkx+IDohdPlFp222wVALIheZJQSEg==
  dependencies:
    color-convert "^2.0.1"

chalk@^4.1.2:
  version "4.1.2"
  resolved "https://registry.yarnpkg.com/chalk/-/chalk-4.1.2.tgz#aac4e2b7734a740867aeb16bf02aad556a1e7a01"
  integrity sha512-oKnbhFyRIXpUuez8iBMmyEa4nbj4IOQyuhc/wy9kY7/WVPcwIO9VA668Pu8RkO7+0G76SLROeyw9CpQ061i4mA==
  dependencies:
    ansi-styles "^4.1.0"
    supports-color "^7.1.0"

color-convert@^2.0.1:
  version "2.0.1"
  resolved "https://registry.yarnpkg.com/color-convert/-/color-convert-2.0.1.tgz#72d3a68d598c9bdb3af2ad1e84f21d896abd4de3"
  integrity sha512-RRECPsj7iu/xb5oKYcsFHSppFNnsj/52OVTRKb4zP5onXwVF3zVmmToNcOfGC+CRDpfK/U584fMg38ZHCaElKQ==
  dependencies:
    color-name "~1.1.4"

color-name@~1.1.4:
  version "1.1.4"
  resolved "https://registry.yarnpkg.com/color-name/-/color-name-1.1.4.tgz#c2a09a87acbde69543de6f63fa3995c826c536a2"
  integrity sha512-dOy+3AuW3a2wNbZHIuMZpTcgjGuLU/uBL/ubcZF9OXbDo8ff4O8yVp5Bf0efS8uEoYo5q4Fx7dY9OgQGXgAsQA==

debug@4.3.7:
  version "4.3.7"
  resolved "https://registry.yarnpkg.com/debug/-/debug-4.3.7.tgz#87945b4151a011d76d95a198d7111c865c360a52"
  integrity sha512-Er2nc/H7RrMXZBFCEim6TCmMk02Z8vLC2Rbi1KEBggpo0fS6l0S1nnapwmIi3yW/+GOJap1Krg4w0Hg80oCqgQ==
  dependencies:
    ms "^2.1.3"

has-flag@^4.0.0:
  version "4.0.0"
  resolved "https://registry.yarnpkg.com/has-flag/-/has-flag-4.0.0.tgz#944771fd9c81c81265c4d6941860da06bb59479b"
  integrity sha512-EykJT/Q1KjTWctppgIAgfSO0tKVuZUjhgMr17kqTumMl6Afv3EISleU7qZUzoXDFTAHTDC4NOoG/ZxU3EvlMPQ==

is-number@6.0.0:
  version "6.0.0"
  resolved "https://registry.yarnpkg.com/is-number/-/is-number-6.0.0.tgz#e6d15ad31fc262887cccf217ae5f9316f81b1995"
  integrity sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==

is-number@7.0.0:
  version "7.0.0"
  resolved "https://registry.yarnpkg.com/is-number/-/is-number-7.0.0.tgz#7535345b896734d5f80c4d06c50955527a14f12b"
  integrity sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==

"js-tokens@^3.0.0 || ^4.0.0":
  version "4.0.0"
  resolved "https://registry.yarnpkg.com/js-tokens/-/js-tokens-4.0.0.tgz#19203fb59991df98e3a287050d4647cdeaf32499"
  integrity sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ==

left-pad@1.3.0:
  version "1.3.0"
  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz#5b8a3a7765dfe001261dde915589e782f8c94d1e"
  integrity sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==

loose-envify@^1.1.0:
  version "1.4.0"
  resolved "https://registry.yarnpkg.com/loose-envify/-/loose-envify-1.4.0.tgz#71ee51fa7be4caec1a63839f7e682d8132d30caf"
  integrity sha512-lyuxPGr/Wfhrlem2CL/UcnUc1zcqKAImBDzukY7Y5F/yQiNdko6+fRLevlw1HgMySw7f611UIY408EtxRSoK3Q==
  dependencies:
    js-tokens "^3.0.0 || ^4.0.0"

ms@2.0.0:
  version "2.0.0"
  resolved "https://registry.yarnpkg.com/ms/-/ms-2.0.0.tgz#5608aeadfc00be6c2901df5f9861788de0d597c8"
  integrity sha512-Tpp60P6IUJDTuOq/5Z8cdskzJujfwqfOTkrwIwj7IRISpnkJnT6SyJ4PCPnGMoFjC9ddhal5KVIYtAt97ix05A==

ms@^2.1.3:
  version "2.1.3"
  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#574c8138ce1d2b5861f0b44579dbadd60c6615b2"
  integrity sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==

react-dom@18.3.1:
  version "18.3.1"
  resolved "https://registry.yarnpkg.com/react-dom/-/react-dom-18.3.1.tgz#c2265d79511b57d479b3dd3fdfa51536494c5cb4"
  integrity sha512-5m4nQKp+rZRb09LNH59GM4BxTh9251/ylbKIbpe7TpGxfJ+9kv6BLkLBXIjjspbgbnIBNqlI23tRnTWT0snUIw==
  dependencies:
    loose-envify "^1.1.0"
    scheduler "^0.23.2"

react@18.3.1:
  version "18.3.1"
  resolved "https://registry.yarnpkg.com/react/-/react-18.3.1.tgz#49ab892009c53933625bd16b2533fc754cab2891"
  integrity sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ==
  dependencies:
    loose-envify "^1.1.0"

scheduler@^0.23.2:
  version "0.23.2"
  resolved "https://registry.yarnpkg.com/scheduler/-/scheduler-0.23.2.tgz#414ba64a3b282892e944cf2108ecc078d115cdc3"
  integrity sha512-UOShsPwz7NrMUqhR6t0hWjFduvOzbtv7toDH1/hIrfRNIDBnnBWd0CwJTGvTpngVlmwGCdP9/Zl/tVrDqcuYzQ==
  dependencies:
    loose-envify "^1.1.0"

supports-color@^7.1.0:
  version "7.2.0"
  resolved "https://registry.yarnpkg.com/supports-color/-/supports-color-7.2.0.tgz#1b7dcdcb32b8138801b3e478ba6a51caa89648da"
  integrity sha512-qpCAvRl9stuOHveKsn7HncJRvv501qIacKzQlO/+Lwxc9+0q2wLyv4Dfvt80/DPn2pqOBsJdDiogXGR9+OvwRw==
  dependencies:
    has-flag "^4.0.0"
`,
  },
  rootManifest: {
    name: 'acme-app',
    private: true,
    packageManager: 'yarn@1.22.22',
    workspaces: ['apps/*'],
    dependencies: {
      'is-number': '6.0.0',
    },
    devDependencies: {
      'left-pad': '1.3.0',
    },
  },
  packManifest: {
    name: '@acme/support',
    version: '0.1.0',
    private: true,
    dependencies: {
      chalk: '^4.1.2',
      debug: '4.3.7',
      ms: '2.0.0',
      react: '18.3.1',
      'react-dom': '18.3.1',
      'is-number': '7.0.0',
    },
    devDependencies: {
      'left-pad': '1.3.0',
    },
  },
};
