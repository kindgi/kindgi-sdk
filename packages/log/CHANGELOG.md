# @kindgi/log

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
