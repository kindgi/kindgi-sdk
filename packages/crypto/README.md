# `@kindgi/crypto`

Cryptographic primitives for Kindgi. Two algorithms, one package:

- **Ed25519** — asymmetric signatures. The signer holds a private key; verifiers hold only the public key. Used by signed audit-bundle exports, signed provenance exports, and any consumer that needs "prove this came from the party holding the private key" without trusting the verifier.
- **HMAC-SHA256** — symmetric authentication. Sender and receiver share a secret. Suited to webhook-style payload signing: a lowercase hex HMAC over the raw payload bytes, and [Standard Webhooks](#webhook-signatures-standard-webhooks) signatures.

Zero runtime dependencies beyond Node built-ins (`node:crypto`, `node:buffer`). Portable to Bun / Deno; browser use is possible but the current implementation targets Node's `crypto` module.

## Design

- **Uint8Array on internal APIs.** Wire formats (PEM, base64) are serialization helpers. Keys and signatures move around as raw bytes end-to-end so downstream code isn't forced to speak PEM.
- **No key persistence.** The framework never persists or generates key material on your behalf. Callers plug in via [`SigningKeyBinding`](#signingkeybinding) — a caller-provided key store (KMS, env-var-backed, in-memory-for-tests).
- **Typed errors for caller-recoverable failures.** Malformed keys, wrong-length signatures, and unrecognized PEM labels return `Result<T, CryptoError>`. Only system-level primitive failures throw.

## Ed25519

```ts
import {
  generateEd25519KeyPair,
  signEd25519,
  verifyEd25519,
} from '@kindgi/crypto';

const { publicKey, privateKey } = generateEd25519KeyPair();
const message = new TextEncoder().encode('the payload to sign');

const sig = signEd25519(privateKey, message);
if (sig.kind !== 'ok') throw sig.error;

const verified = verifyEd25519(publicKey, message, sig.value);
if (verified.kind === 'ok' && verified.value) {
  // authentic
}
```

Serialization helpers speak DER SPKI (public) and DER PKCS8 (private) — interoperable with OpenSSL and any consumer that speaks RFC 5280 / RFC 5958:

- `serializePublicKeyPem` / `parsePublicKeyPem` — `-----BEGIN PUBLIC KEY-----` envelope.
- `serializePrivateKeyPem` / `parsePrivateKeyPem` — `-----BEGIN PRIVATE KEY-----` envelope.
- `serializePublicKeyBase64` / `parsePublicKeyBase64` — compact JSON-wire form (base64 of DER SPKI).
- `serializePrivateKeyBase64` / `parsePrivateKeyBase64` — same for private keys.

## HMAC-SHA256

```ts
import { hmacSha256Sign, hmacSha256Verify } from '@kindgi/crypto';

const secret = process.env.WEBHOOK_SIGNING_SECRET!;
const payload = JSON.stringify({ event: 'payment.succeeded' });

const sig = hmacSha256Sign(secret, payload); // 64-char lowercase hex

// Receiver:
if (!hmacSha256Verify(secret, payload, sig)) {
  // reject request
}
```

Verify uses `crypto.timingSafeEqual` — the comparison time does not vary with the mismatch position, so a signature-probing attacker cannot recover a valid signature byte-by-byte.

## Webhook signatures (Standard Webhooks)

Kindgi signs outbound webhooks in the [Standard Webhooks](https://www.standardwebhooks.com) format: headers `webhook-id`, `webhook-timestamp` and `webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">`, with a `whsec_…` secret per endpoint.

```ts
import { verifyWebhook } from '@kindgi/crypto';

// In the receiver, with the raw request body (before JSON parsing):
const result = verifyWebhook({ secret, headers: request.headers, body: rawBody });
if (result.kind !== 'ok') {
  // reject: result.reason is 'missing-headers' | 'invalid-timestamp' |
  // 'timestamp-out-of-tolerance' | 'invalid-secret' | 'no-matching-signature'
}
// result.id is the event id: deduplicate on it (delivery is at least once).
```

- `verifyWebhook` accepts a `Headers` object or a plain record, rejects timestamps more than 5 minutes off (`toleranceSeconds`), accepts any matching signature when several are present (secret rotation), and compares in constant time.
- Senders use `signWebhook` / `webhookHeaders` (pass `[newSecret, previousSecret]` during a rotation) and `generateWebhookSecret`.
- Interoperable with the reference Standard Webhooks libraries in both directions.

## SigningKeyBinding

The framework does not own key persistence. Consumers implement `SigningKeyBinding` against whatever store they run:

```ts
import type { SigningKeyBinding } from '@kindgi/crypto';
import { createInMemorySigningKeyBinding, generateEd25519KeyPair } from '@kindgi/crypto';
import type { SigningKeyId } from '@kindgi/types';

const { publicKey, privateKey } = generateEd25519KeyPair();
const binding: SigningKeyBinding = createInMemorySigningKeyBinding([
  {
    keyId: 'audit-bundle-v1' as SigningKeyId,
    algorithm: 'ed25519',
    publicKey,
    privateKey,
  },
]);

// Later, in a consumer:
const priv = binding.getPrivateKey('audit-bundle-v1' as SigningKeyId);
if (priv === null) throw new Error('key not provisioned');
```

`createInMemorySigningKeyBinding` is for tests and local development. Production deployments implement the interface against their own key store (a cloud KMS, a secrets vault, an HSM). This package never persists key material.

## ExportSigningBinding

The key a deployment signs its exports with (audit bundles, provenance, compliance evidence). It's async, so a KMS that never hands out its private key can implement it, as well as a key file can:

```ts
import { createExportSignerFromPem } from '@kindgi/crypto';

// An Ed25519 key signs `ed25519`; an EC P-256 key signs `ecdsa-p256-sha256`.
const made = createExportSignerFromPem(await readFile(keyPath, 'utf8'));
if (made.kind === 'err') throw new Error(made.error.message);
const signer = made.value;

signer.activeKey(); // { keyId: 'ex_…', algorithm: 'ed25519', publicKeyPem, fingerprint: 'sha256:…' }
const signed = await signer.sign(bytes); // the active key, or { keyId }
```

- **Key ids are derived from the public key** (`exportSigningKey`), so the same key keeps its id.
- **`listKeys()`** is every key a verifier should trust, active first.
- **Two algorithms, chosen per key:** `ed25519` (the default) and `ecdsa-p256-sha256`, for a KMS without Ed25519. An ECDSA signature is IEEE P1363 `r‖s`, 64 bytes. A KMS binding that gets DER back (Cloud KMS, AWS KMS) converts with `ecdsaDerToP1363`.
- **Test vectors** for both are in `@kindgi/specs` (`test-vectors/signed-export/`).

`@kindgi/api` takes one as `createApp({ exportSigning })`. To verify an export, use `verifySignedExport` from `@kindgi/client` (Web Crypto, so it runs in a browser too).

## Security notes

- **Never log private keys or shared secrets.** Journals, provenance blobs, structured logs, and wire payloads must not contain key material except by explicit caller intent.
- **`SigningKeyBinding.listKeys()` returns descriptors only** — key IDs and metadata, never the bytes.
- **Constant-time verify only.** HMAC uses `timingSafeEqual`; Ed25519 uses Node's underlying primitive which itself is constant-time.
- **Rotation and revocation are out of scope for this package**. Callers who need rotation should treat a `SigningKeyId` as a specific key version — issue a new ID when rotating, keep the old one for verifying earlier signatures.
