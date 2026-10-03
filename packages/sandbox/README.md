# `@kindgi/sandbox`

Type contract and wire protocol for running handler code in a sandbox. A sandbox adapter (in-process, container, microVM) implements `SandboxProvider`; the Kindgi runtime dispatches handlers through it. The package also defines the newline-delimited JSON frames exchanged with a handler over stdio, with pure encode/parse functions. It holds no runtime state.

## Purpose

Give every sandbox adapter one seam to implement, so that handler dispatch does not depend on how isolation is enforced. The runtime states what a handler needs (`SandboxSpec`: isolation level, invocation mode, resource limits, network policy); the adapter enforces it or fails with a typed error. An adapter must not silently downgrade an isolation level it cannot provide. Optional features are negotiated rather than assumed: adapters advertise capability strings and may omit the lifecycle methods (`snapshot`, `restore`, `pause`, `resume`), which callers detect with `typeof sandbox.snapshot === 'function'`.

## Exports

- **Provider contract**
  - **`SandboxProvider`** — `create(spec, opts?)` returns a `Sandbox`; `opts.signal` aborts a slow cold start (adapters roll back partial resources, then fail with `create-cancelled`). `capabilities` lists the optional features the adapter supports.
  - **`SandboxCapabilities`** / **`KnownSandboxCapability`** — a read-only set of capability strings: `'preview-url'`, `'streaming'`, `'warm-pool'`, `'strict'`, `'context-isolated'`, `'network-allowlist'`, `'network-unrestricted'`, or any adapter-defined string.
  - **`Sandbox`** — `exec`, `writeFile`, `readFile`, `startProcess`, `destroy` (idempotent), plus optional `snapshot` / `restore` / `pause` / `resume`.
  - **`SnapshotHandle`** — opaque `{ v: 1, adapterId, doc }` envelope; only the adapter that produced it can restore it.
- **Dispatch spec**
  - **`SandboxSpec`** — `tenantId`, `runId`, `nodeId?`, `image?`, `limits`, `network`, `level`, `mode`, `invocation?`.
  - **`SandboxLevel`** — `'none' | 'context-isolated' | 'strict'`. Only `strict` is a security boundary against untrusted code.
  - **`HandlerInvocationMode`** — `'in-context' | 'json-stdio' | 'handler-image'`. The last two require `image`.
  - **`SandboxLimits`** (`memMB`, `cpuMs`, `diskMB?`, `maxProcesses?`), **`NetworkPolicy`** (`none` / `allowlist` with `hosts` / `unrestricted`; adapters fail closed).
  - **`SandboxInvocationContext`** — `dryRun`, `state`, `nodeOutputs`, and `resume` (`tokenId` + `value`) carried to a `json-stdio` handler.
  - **`HandlerRef`** — `artifactId`, `version`, `modulePath?`, `entrypointPath?`; **`DEFAULT_ENTRYPOINT_PATH`** is `/kindgi/handler-base/entrypoint.js`.
- **Process I/O** — **`ExecOpts`** (adds `timeoutMs`), **`ExecResult`** (`stdout`, `stderr`, `exitCode`, `usage`), **`ProcessOpts`** (`stdin`, `env`, `cwd`, `abortSignal`), **`ProcessHandle`** (`stdin`, `stdout`, `stderr`, `done`, `kill`), **`ProcessStdin`** (`write`, optional `close`), **`ResourceUsage`** (`cpuMs`, `wallMs`, `peakMemMB`; `0` means not measured).
- **Errors** — **`SandboxError`**, a closed union discriminated by **`SandboxErrorCode`**: `LevelNotSupportedError`, `LimitsExceededError`, `TimeoutError`, `CancelledError`, `CreateCancelledError`, `UnhandledWorkerError`, `ConfigInvalidError`, `OrphanedError`, `SnapshotNotSupportedError`, `RestoreNotSupportedError`, `PauseNotSupportedError`, `InvalidSnapshotHandleError`, `ProviderError` (catch-all; details go on `cause`). Constructors returning an `err` result: **`levelNotSupported(requested, supported, detail?)`**, **`providerError(message, cause?)`**, **`createCancelled(detail?)`**.
- **Invocation protocol** (`json-stdio` mode)
  - Frames: **`InvokeFrame`** and **`ResumeFrame`** (runtime to sandbox, union **`StdinFrame`**); **`OutputFrame`**, **`ErrorFrame`**, **`SuspendFrame`** (sandbox to runtime, union **`StdoutFrame`**); **`WireFrame`** is all of them. **`ProtocolContext`** is the run context carried on `InvokeFrame.ctx`.
  - **`encodeFrame(frame)`** — JSON plus trailing newline, as bytes.
  - **`parseFrame(line)`** / **`parseFrames(source)`** — parse one line, or a stream of chunks such as `ProcessHandle.stdout`, into `Result<WireFrame, ProtocolError>`. Payloads (`input`, `output`) are not validated.
  - **`PROTOCOL_VERSION`** (`1`, carried as `v` on every frame) and **`SUSPEND_EXIT_CODE`** (`42`).
- **`SandboxSuspensionRequest`** — `Error` subclass with `tokenId`. Thrown inside the sandbox when a handler waits on a token; the handler-base entrypoint turns it into a `SuspendFrame` and exits with `SUSPEND_EXIT_CODE`.

## Example

```ts
import {
  DEFAULT_ENTRYPOINT_PATH,
  encodeFrame,
  parseFrames,
  PROTOCOL_VERSION,
  type SandboxProvider,
  type SandboxSpec,
} from '@kindgi/sandbox';
import type { RunId, TenantId } from '@kindgi/types';

type Outcome =
  | { readonly kind: 'output'; readonly value: unknown }
  | { readonly kind: 'suspended'; readonly tokenId: string };

async function invokeJsonStdio(
  provider: SandboxProvider,
  tenantId: TenantId,
  runId: RunId,
  input: unknown,
): Promise<Outcome> {
  const spec: SandboxSpec = {
    tenantId,
    runId,
    nodeId: 'summarize',
    image: 'registry.example.com/acme/summarize:1.4.0',
    limits: { memMB: 256, cpuMs: 10_000 },
    network: { kind: 'allowlist', hosts: ['api.acme.example'] },
    level: 'strict',
    mode: 'json-stdio',
  };

  // Abort a slow cold start; adapters roll back and fail with `create-cancelled`.
  const sandbox = await provider.create(spec, { signal: AbortSignal.timeout(5_000) });
  try {
    const proc = await sandbox.startProcess(['node', DEFAULT_ENTRYPOINT_PATH]);
    await proc.stdin.write(
      encodeFrame({
        v: PROTOCOL_VERSION,
        kind: 'invoke',
        input,
        ctx: { runId, tenantId, nodeId: 'summarize', dryRun: false, state: {}, nodeOutputs: {} },
      }),
    );
    await proc.stdin.close?.();

    for await (const frame of parseFrames(proc.stdout)) {
      if (frame.kind === 'err') throw new Error(`protocol error: ${frame.error.kind}`);
      const msg = frame.value;
      if (msg.kind === 'output') return { kind: 'output', value: msg.output };
      if (msg.kind === 'suspend') return { kind: 'suspended', tokenId: msg.tokenId };
      if (msg.kind === 'error') throw new Error(`${msg.error.code}: ${msg.error.message}`);
    }
    const { exitCode } = await proc.done;
    throw new Error(`handler exited with code ${exitCode} without an output frame`);
  } finally {
    await sandbox.destroy(); // idempotent
  }
}
```

## Non-goals

- **No sandbox implementation.** This package contains no adapter and no dispatch loop. Adapters implement `SandboxProvider`; the Kindgi runtime provides dispatch.
- **No wall-clock limit on `SandboxLimits`.** Wall-clock time is enforced outside the sandbox (from the flow edge's timeout), so a compromised sandbox cannot extend its own limit. `ExecOpts.timeoutMs` only narrows it for a single call.
- **No cross-adapter snapshots.** A `SnapshotHandle` is scoped to the adapter that produced it; restoring it elsewhere fails with `invalid-snapshot-handle`.
- **No adapter-defined frames or error codes.** Frame kinds and `SandboxErrorCode` are closed unions. Adapters treat process bytes as opaque and report anything else as `provider-error`.
- **No binary or bidirectional-streaming encodings.** The protocol is JSON lines only.

## Related

- [`@kindgi/handler-runtime`](../handler-runtime/) — dispatches tool handlers through a `SandboxProvider`.
- [`@kindgi/types`](../types/) — `TenantId`, `RunId`, `ArtifactId`, `Result`.
