# @kindgi/log

## 0.2.0-rc.0

No changes in this release.

## 0.1.10

No changes in this release.

## 0.1.10-rc.1

No changes in this release.

## 0.1.10-rc.0

No changes in this release.

## 0.1.9

### Patch Changes

- 3b90568: **An error whose cause is a plain object logs that cause's code and message, not `[object Object]`.** A storage error is a plain object (`{ code, message, cause }`), so a log line for an error caused by one read `caused by: [object Object]` and lost the storage code and message. A plain object in an error's place (as `err`, or as a cause) now logs its `name` when that's a non-empty string (else `Object`), its `code` and its scrubbed `message`, and nothing else: no other field, no stack, and its own `cause` isn't walked, since a storage error's is the database driver's, whose text can carry the query and the values bound to it. One with neither a code nor a message still logs as `String(err)`. Logging one never throws: a field that throws when read counts as missing, and an object that can't be made a string (no prototype, a revoked proxy) logs as its type tag or `[unreadable]`.

## 0.1.9-rc.1

No changes in this release.

## 0.1.9-rc.0

### Patch Changes

- 3b90568: **An error whose cause is a plain object logs that cause's code and message, not `[object Object]`.** A storage error is a plain object (`{ code, message, cause }`), so a log line for an error caused by one read `caused by: [object Object]` and lost the storage code and message. A plain object in an error's place (as `err`, or as a cause) now logs its `name` when that's a non-empty string (else `Object`), its `code` and its scrubbed `message`, and nothing else: no other field, no stack, and its own `cause` isn't walked, since a storage error's is the database driver's, whose text can carry the query and the values bound to it. One with neither a code nor a message still logs as `String(err)`. Logging one never throws: a field that throws when read counts as missing, and an object that can't be made a string (no prototype, a revoked proxy) logs as its type tag or `[unreadable]`.

## 0.1.8

### Patch Changes

- d92706f: **Security hardening: the license renewer's key is now masked in logs.** Redaction matched a Kindgi token's kind only when it had two letters, so the license renewer's private key (`kgi_lrk_…`) and public key (`kgi_lrp_…`) were written in full when they appeared in a log line. A kind may now have two or three letters, and those keys keep only their prefix and last four characters, like every other token. The Python (`kindgi.log`) and Java (`com.kindgi.log`) loggers change the same way. Ordinary text that contains `kgi_` is still left alone.

## 0.1.8-rc.0

### Patch Changes

- d92706f: **Security hardening: the license renewer's key is now masked in logs.** Redaction matched a Kindgi token's kind only when it had two letters, so the license renewer's private key (`kgi_lrk_…`) and public key (`kgi_lrp_…`) were written in full when they appeared in a log line. A kind may now have two or three letters, and those keys keep only their prefix and last four characters, like every other token. The Python (`kindgi.log`) and Java (`com.kindgi.log`) loggers change the same way. Ordinary text that contains `kgi_` is still left alone.

## 0.1.7

No changes in this release.

## 0.1.7-rc.0

No changes in this release.

## 0.1.6

No changes in this release.

## 0.1.6-rc.0

No changes in this release.

## 0.1.5

### Patch Changes

- b67c599: A record written with `inMessage` (the fields its message already states, like the request line's `method`, `route`, `status` and `durationMs`) names them in its JSON as `inMessage`, listing the ones the record has. A renderer may leave them out of a line. `formatPretty` does, so a record read back from JSON renders as it did at the source. A field an app itself calls `inMessage` is kept under `fields`, like one named after the fixed five. Python's `kindgi.log` does the same (`in_message=`).

## 0.1.5-rc.0

### Patch Changes

- b67c599: A record written with `inMessage` (the fields its message already states, like the request line's `method`, `route`, `status` and `durationMs`) names them in its JSON as `inMessage`, listing the ones the record has. A renderer may leave them out of a line. `formatPretty` does, so a record read back from JSON renders as it did at the source. A field an app itself calls `inMessage` is kept under `fields`, like one named after the fixed five. Python's `kindgi.log` does the same (`in_message=`).

## 0.1.4

### Patch Changes

- 9801f64: **`@kindgi/log`, a new package: Kindgi's structured logger.** The runtime and `@kindgi/api` write the same records. It has zero runtime dependencies.
  
  - **Levels:** `error`, `warn`, `info`, `debug` and `trace`, per subsystem. A dotted name inherits its parent's level: `kernel=debug` covers `kernel.sweeper`.
  - **Child loggers:** `log.child({ subsystem, runId, … })`, and errors passed as `{ err }`.
  - **`{ inMessage: [...] }`:** a third argument names the fields the message already states. The pretty format leaves them out, and JSON keeps them.
  - **Two formats:** JSON (`time`, `level`, `severity`, `subsystem`, `message`, then correlation ids, then fields, one record per line) and a pretty format for terminals.
  - **Redaction** on every record:
    - fields whose key looks secret (`authorization`, `…token`, `…password`, `…secret`, `apiKey`…) are redacted;
    - Kindgi tokens, `Bearer` values and URL passwords are scrubbed from every string.
  - **W3C Trace Context helpers:** `traceFromHeader`, `parseTraceparent`, `newTraceContext`, `childSpan`, `formatTraceparent`.
  - **`loggerFromEnv`:** reads `KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT` (`auto`, `json`, `pretty`). A bad value is refused, naming the variable; an unknown subsystem is reported.

## 0.1.4-rc.5

### Patch Changes

- 9801f64: **`@kindgi/log`, a new package: Kindgi's structured logger.** The runtime and `@kindgi/api` write the same records. It has zero runtime dependencies.
  
  - **Levels:** `error`, `warn`, `info`, `debug` and `trace`, per subsystem. A dotted name inherits its parent's level: `kernel=debug` covers `kernel.sweeper`.
  - **Child loggers:** `log.child({ subsystem, runId, … })`, and errors passed as `{ err }`.
  - **`{ inMessage: [...] }`:** a third argument names the fields the message already states. The pretty format leaves them out, and JSON keeps them.
  - **Two formats:** JSON (`time`, `level`, `severity`, `subsystem`, `message`, then correlation ids, then fields, one record per line) and a pretty format for terminals.
  - **Redaction** on every record:
    - fields whose key looks secret (`authorization`, `…token`, `…password`, `…secret`, `apiKey`…) are redacted;
    - Kindgi tokens, `Bearer` values and URL passwords are scrubbed from every string.
  - **W3C Trace Context helpers:** `traceFromHeader`, `parseTraceparent`, `newTraceContext`, `childSpan`, `formatTraceparent`.
  - **`loggerFromEnv`:** reads `KINDGI_LOG_LEVEL`, `KINDGI_LOG_LEVELS` and `KINDGI_LOG_FORMAT` (`auto`, `json`, `pretty`). A bad value is refused, naming the variable; an unknown subsystem is reported.
