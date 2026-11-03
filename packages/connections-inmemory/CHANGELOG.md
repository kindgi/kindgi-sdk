# @kindgi/connections-inmemory

## 0.4.0

### Patch Changes

- Updated dependencies [b25b82f]
- Updated dependencies [af2f8db]
- Updated dependencies [1e4dd72]
- Updated dependencies [265fffb]
- Updated dependencies [24c1f9d]
- Updated dependencies
- Updated dependencies [44f9726]
- Updated dependencies [d92355b]
- Updated dependencies [b9135f8]
- Updated dependencies [d6c9279]
- Updated dependencies [6380c49]
- Updated dependencies [d508659]
- Updated dependencies [265fffb]
- Updated dependencies [2afc071]
- Updated dependencies [f2adcc2]
- Updated dependencies [ae02280]
- Updated dependencies [e98d120]
- Updated dependencies [9106401]
- Updated dependencies [c9740c7]
- Updated dependencies [3a1502d]
- Updated dependencies [7bdd73e]
- Updated dependencies [a2f785f]
- Updated dependencies [d10dcc3]
- Updated dependencies [efa3cdb]
- Updated dependencies [9b015f7]
- Updated dependencies [334f7f9]
- Updated dependencies [038fbfb]
- Updated dependencies [9a8a294]
- Updated dependencies [5d28854]
- Updated dependencies [58ce994]
- Updated dependencies [6ab40e9]
- Updated dependencies [e9f223b]
- Updated dependencies [1bd877d]
- Updated dependencies [265fffb]
- Updated dependencies [12830e8]
- Updated dependencies [59a1243]
- Updated dependencies [bd3817f]
- Updated dependencies [d779ec5]
- Updated dependencies [156abe4]
- Updated dependencies [b4e208f]
- Updated dependencies [dff9515]
- Updated dependencies [fbb40b7]
- Updated dependencies [00c0b51]
- Updated dependencies [023f556]
- Updated dependencies [9346681]
- Updated dependencies [1131ec3]
- Updated dependencies [9faeb00]
- Updated dependencies [d576ff4]
- Updated dependencies [fdbd8cc]
  - @kindgi/types@0.4.0
  - @kindgi/agents@0.4.0
  - @kindgi/api@0.4.0
  - @kindgi/tools@0.4.0
  - @kindgi/connections@0.4.0
  - @kindgi/authz@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [4beb42c]
- Updated dependencies [4beb42c]
- Updated dependencies [4beb42c]
  - @kindgi/api@0.3.1
  - @kindgi/agents@0.3.1
  - @kindgi/tools@0.3.1
  - @kindgi/authz@0.3.1
  - @kindgi/connections@0.3.1
  - @kindgi/types@0.3.1

## 0.3.1-rc.1

### Patch Changes

- @kindgi/agents@0.3.1-rc.1
  - @kindgi/api@0.3.1-rc.1
  - @kindgi/authz@0.3.1-rc.1
  - @kindgi/connections@0.3.1-rc.1
  - @kindgi/tools@0.3.1-rc.1
  - @kindgi/types@0.3.1-rc.1

## 0.3.1-rc.0

### Patch Changes

- Updated dependencies [4beb42c]
- Updated dependencies [4beb42c]
- Updated dependencies [4beb42c]
  - @kindgi/api@0.3.1-rc.0
  - @kindgi/agents@0.3.1-rc.0
  - @kindgi/tools@0.3.1-rc.0
  - @kindgi/authz@0.3.1-rc.0
  - @kindgi/connections@0.3.1-rc.0
  - @kindgi/types@0.3.1-rc.0

## 0.3.0

### Patch Changes

- Updated dependencies [8dd91b0]
- Updated dependencies [77de8bd]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [1a36b1f]
- Updated dependencies [06ae9b6]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [ea16d4e]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [5022734]
- Updated dependencies [29b60dd]
- Updated dependencies [e8baad5]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [03a715d]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [52d0759]
- Updated dependencies [8dd91b0]
  - @kindgi/api@0.3.0
  - @kindgi/agents@0.3.0
  - @kindgi/tools@0.3.0
  - @kindgi/authz@0.3.0
  - @kindgi/types@0.3.0
  - @kindgi/connections@0.3.0

## 0.3.0-rc.0

### Patch Changes

- Updated dependencies [8dd91b0]
- Updated dependencies [77de8bd]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [1a36b1f]
- Updated dependencies [06ae9b6]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [ea16d4e]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [5022734]
- Updated dependencies [29b60dd]
- Updated dependencies [e8baad5]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [03a715d]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [8dd91b0]
- Updated dependencies [52d0759]
- Updated dependencies [8dd91b0]
  - @kindgi/api@0.3.0-rc.0
  - @kindgi/agents@0.3.0-rc.0
  - @kindgi/tools@0.3.0-rc.0
  - @kindgi/authz@0.3.0-rc.0
  - @kindgi/types@0.3.0-rc.0
  - @kindgi/connections@0.3.0-rc.0

## 0.2.0

### Patch Changes

- 08dedca: **A registration names its app's directory: `oauth2.tenant`.** For an app whose sign-in happens in a directory of its own (Microsoft's tenant), `POST /v1/connection-apps` and `PATCH /v1/connection-apps/{appId}` take `oauth2.tenant`: Microsoft's tenant id or domain for a single-tenant app, or `organizations`, `common` or `consumers` for a multi-tenant one. The registration's answer shows it. The route checks that it's a string of 1 to 253 characters; the server's binding answers `connection-app-invalid` (`details.field` `oauth2.tenant`) when the app needs one and it's missing (Microsoft's always does), when the app has no directory, or when it isn't a directory's name. A `PATCH` that gives `oauth2` gives the whole of it, the tenant included. Changing the directory while the registration has live connections is refused as a client id change is (`connection-app-invalid`, `details.field` `oauth2.tenant`): their refresh tokens belong to it. It's compared as the sign-in uses it, so leaving `tenant` out of an app with a default directory counts as that default. `ConnectionOAuth2App` in the OpenAPI document, and the TypeScript and Python clients, have the optional `tenant`.
  - `@kindgi/connections-inmemory` checks it the same way, and its consent page is in the registration's directory, asking for the sign-in's and the account lookup's scopes too.
- 08dedca: **A new package: `@kindgi/connections-inmemory`.** An in-memory `ConnectionBinding` and `ConnectionResolver`, sharing one store, with a fake app in place of Google's or GitHub's servers, for development and tests. A test connects without a browser (`code: 'ok'`), and hooks make the fake app refuse a code, give no refresh token, fail a renewal, withdraw a grant, offer several GitHub installations, or send a notice. A connection without a refresh token, connected or seeded, works until its token ends, with no call to the app. It refuses `NODE_ENV=production` unless `productionSafe`.
- Updated dependencies [68e0d57]
- Updated dependencies [bf30268]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [68e0d57]
- Updated dependencies [19b0a86]
- Updated dependencies [b6e20ca]
- Updated dependencies [6fc48e9]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [68e0d57]
- Updated dependencies [354c801]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [8564e06]
- Updated dependencies [bf30268]
- Updated dependencies [a458bf4]
- Updated dependencies [af37c1a]
- Updated dependencies [af2f5db]
- Updated dependencies [68e0d57]
- Updated dependencies [98104be]
- Updated dependencies [e019e64]
- Updated dependencies [68e0d57]
- Updated dependencies [b6e20ca]
- Updated dependencies [68e0d57]
- Updated dependencies [68e0d57]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [119ac78]
- Updated dependencies [fc7347c]
- Updated dependencies [b6e20ca]
- Updated dependencies [760acad]
- Updated dependencies [b6e20ca]
  - @kindgi/agents@0.2.0
  - @kindgi/api@0.2.0
  - @kindgi/connections@0.2.0
  - @kindgi/tools@0.2.0
  - @kindgi/authz@0.2.0
  - @kindgi/types@0.2.0

## 0.2.0-rc.1

### Patch Changes

- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
- Updated dependencies [b6e20ca]
  - @kindgi/api@0.2.0-rc.1
  - @kindgi/tools@0.2.0-rc.1
  - @kindgi/connections@0.2.0-rc.1
  - @kindgi/agents@0.2.0-rc.1
  - @kindgi/authz@0.2.0-rc.1
  - @kindgi/types@0.2.0-rc.1

## 0.2.0-rc.0

### Patch Changes

- 08dedca: **A registration names its app's directory: `oauth2.tenant`.** For an app whose sign-in happens in a directory of its own (Microsoft's tenant), `POST /v1/connection-apps` and `PATCH /v1/connection-apps/{appId}` take `oauth2.tenant`: Microsoft's tenant id or domain for a single-tenant app, or `organizations`, `common` or `consumers` for a multi-tenant one. The registration's answer shows it. The route checks that it's a string of 1 to 253 characters; the server's binding answers `connection-app-invalid` (`details.field` `oauth2.tenant`) when the app needs one and it's missing (Microsoft's always does), when the app has no directory, or when it isn't a directory's name. A `PATCH` that gives `oauth2` gives the whole of it, the tenant included. Changing the directory while the registration has live connections is refused as a client id change is (`connection-app-invalid`, `details.field` `oauth2.tenant`): their refresh tokens belong to it. It's compared as the sign-in uses it, so leaving `tenant` out of an app with a default directory counts as that default. `ConnectionOAuth2App` in the OpenAPI document, and the TypeScript and Python clients, have the optional `tenant`.
  - `@kindgi/connections-inmemory` checks it the same way, and its consent page is in the registration's directory, asking for the sign-in's and the account lookup's scopes too.
- 08dedca: **A new package: `@kindgi/connections-inmemory`.** An in-memory `ConnectionBinding` and `ConnectionResolver`, sharing one store, with a fake app in place of Google's or GitHub's servers, for development and tests. A test connects without a browser (`code: 'ok'`), and hooks make the fake app refuse a code, give no refresh token, fail a renewal, withdraw a grant, offer several GitHub installations, or send a notice. A connection without a refresh token, connected or seeded, works until its token ends, with no call to the app. It refuses `NODE_ENV=production` unless `productionSafe`.
- Updated dependencies [68e0d57]
- Updated dependencies [bf30268]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [08dedca]
- Updated dependencies [68e0d57]
- Updated dependencies [19b0a86]
- Updated dependencies [6fc48e9]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [68e0d57]
- Updated dependencies [354c801]
- Updated dependencies [bf30268]
- Updated dependencies [bf30268]
- Updated dependencies [8564e06]
- Updated dependencies [bf30268]
- Updated dependencies [a458bf4]
- Updated dependencies [af37c1a]
- Updated dependencies [af2f5db]
- Updated dependencies [68e0d57]
- Updated dependencies [98104be]
- Updated dependencies [e019e64]
- Updated dependencies [68e0d57]
- Updated dependencies [68e0d57]
- Updated dependencies [68e0d57]
- Updated dependencies [08dedca]
- Updated dependencies [119ac78]
- Updated dependencies [fc7347c]
- Updated dependencies [760acad]
  - @kindgi/agents@0.2.0-rc.0
  - @kindgi/api@0.2.0-rc.0
  - @kindgi/connections@0.2.0-rc.0
  - @kindgi/tools@0.2.0-rc.0
  - @kindgi/authz@0.2.0-rc.0
  - @kindgi/types@0.2.0-rc.0
