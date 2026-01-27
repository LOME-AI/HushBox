# Authentication & E2E Encryption Implementation Plan

## Summary

Replace Better Auth with a custom OPAQUE-based authentication system featuring end-to-end encryption where the server never sees passwords or plaintext content.

## Decisions Made

| Decision              | Choice                                                                   |
| --------------------- | ------------------------------------------------------------------------ |
| Scope                 | Full implementation (all 11 phases)                                      |
| OPAQUE library        | `@cloudflare/opaque-ts`                                                  |
| Data migration        | Clean break — drop Better Auth tables, fresh start                       |
| Crypto package        | New `packages/crypto` package                                            |
| OPAQUE server secrets | KMS derivation — single `OPAQUE_MASTER_SECRET` derives all keys via HKDF |
| TOTP secrets          | Encrypted at rest with server-side key derived from master secret        |
| DEK persistence       | sessionStorage (encrypted password), re-derive on page refresh           |
| Compression           | Always try gzip, use smaller result (no threshold)                       |

---

## Phase 0: Human Actions (Secrets Setup)

Before implementation begins, the following secrets must be configured:

### Local Development

Add to `apps/api/.dev.vars`:

```
OPAQUE_MASTER_SECRET="development-master-secret-minimum-32-bytes-long"
IRON_SESSION_SECRET="development-session-secret-32-bytes"
```

Add to `.env.development`:

```
UPSTASH_REDIS_REST_URL=http://localhost:8079
UPSTASH_REDIS_REST_TOKEN=local_dev_token
```

### Production (Cloudflare Workers)

```bash
# Generate cryptographically secure secrets
openssl rand -base64 32  # For OPAQUE_MASTER_SECRET
openssl rand -base64 32  # For IRON_SESSION_SECRET

# Set in Cloudflare Workers
wrangler secret put OPAQUE_MASTER_SECRET
wrangler secret put IRON_SESSION_SECRET
wrangler secret put UPSTASH_REDIS_REST_URL
wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

### Upstash Redis Setup (Production)

1. Create Upstash account at https://upstash.com
2. Create new Redis database (choose region closest to Cloudflare Workers)
3. Copy REST URL and Token to Cloudflare secrets

---

## Phase 1: Infrastructure — Redis Setup

### 1.1 Docker Compose Update

Add to `docker-compose.yml`:

```yaml
redis:
  image: redis:7-alpine
  ports:
    - '6379:6379'
  healthcheck:
    test: ['CMD', 'redis-cli', 'ping']
    interval: 5s
    timeout: 3s
    retries: 5

serverless-redis-http:
  image: hiett/serverless-redis-http:latest
  ports:
    - '8079:80'
  environment:
    SRH_MODE: env
    SRH_TOKEN: local_dev_token
    SRH_CONNECTION_STRING: 'redis://redis:6379'
  depends_on:
    redis:
      condition: service_healthy
```

### 1.2 Environment Configuration

Update `packages/shared/src/env.config.ts` to include:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

### 1.3 Redis Client Utility

Create `apps/api/src/lib/redis.ts`:

```typescript
import { Redis } from '@upstash/redis';

export function createRedisClient(url: string, token: string): Redis {
  return new Redis({ url, token });
}
```

### 1.4 Redis Middleware

Create `apps/api/src/middleware/redis.ts`:

```typescript
export function redisMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const redis = createRedisClient(c.env.UPSTASH_REDIS_REST_URL, c.env.UPSTASH_REDIS_REST_TOKEN);
    c.set('redis', redis);
    await next();
  };
}
```

### 1.5 Packages to Install

```bash
pnpm --filter @lome-chat/api add @upstash/redis
```

---

## Phase 2: Database Schema Migration

### 2.1 Drop Better Auth Tables

Create migration `0008_remove_better_auth.sql`:

```sql
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS verifications;
```

### 2.2 Modify Users Table

Create migration `0009_auth_encryption_schema.sql`:

```sql
-- Remove old column
ALTER TABLE users DROP COLUMN IF EXISTS "emailVerified";

-- Add new auth columns
ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN email_verify_token TEXT;
ALTER TABLE users ADD COLUMN email_verify_expires TIMESTAMPTZ;

-- OPAQUE Authentication
ALTER TABLE users ADD COLUMN opaque_registration BYTEA;

-- 2FA (encrypted at rest)
ALTER TABLE users ADD COLUMN totp_secret_encrypted BYTEA;
ALTER TABLE users ADD COLUMN totp_iv BYTEA;
ALTER TABLE users ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- E2E Encryption - Password Path
ALTER TABLE users ADD COLUMN password_salt BYTEA;
ALTER TABLE users ADD COLUMN encrypted_dek_password BYTEA;

-- E2E Encryption - Recovery Path
ALTER TABLE users ADD COLUMN phrase_salt BYTEA;
ALTER TABLE users ADD COLUMN encrypted_dek_phrase BYTEA;
ALTER TABLE users ADD COLUMN phrase_verifier BYTEA;
ALTER TABLE users ADD COLUMN has_acknowledged_phrase BOOLEAN NOT NULL DEFAULT FALSE;

-- Sharing Keys (X25519)
ALTER TABLE users ADD COLUMN public_key BYTEA;
ALTER TABLE users ADD COLUMN private_key_wrapped BYTEA;

-- Versioning
ALTER TABLE users ADD COLUMN encryption_version INTEGER NOT NULL DEFAULT 1;

-- Indexes
CREATE INDEX idx_users_email_verify_token ON users(email_verify_token) WHERE email_verify_token IS NOT NULL;
```

### 2.3 Modify Messages Table

```sql
-- Add encryption columns
ALTER TABLE messages ADD COLUMN content_encrypted BYTEA;
ALTER TABLE messages ADD COLUMN iv BYTEA;
ALTER TABLE messages ADD COLUMN sharing_key_wrapped BYTEA;
ALTER TABLE messages ADD COLUMN content_type TEXT NOT NULL DEFAULT 'text';

-- Will migrate content → content_encrypted later, then drop content
```

### 2.4 Modify Conversations Table

```sql
ALTER TABLE conversations ADD COLUMN title_encrypted BYTEA;
ALTER TABLE conversations ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE conversations ADD COLUMN public_share_id TEXT UNIQUE;
ALTER TABLE conversations ADD COLUMN public_share_expires TIMESTAMPTZ;
```

### 2.5 Create Sharing Tables

```sql
CREATE TABLE conversation_shares (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  shared_with_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped_key BYTEA NOT NULL,
  permissions TEXT NOT NULL DEFAULT 'read',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(conversation_id, shared_with_user_id)
);

CREATE TABLE message_shares (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  shared_with_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped_key BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(message_id, shared_with_user_id)
);
```

### 2.6 Update Drizzle Schema Files

- `packages/db/src/schema/users.ts` — Add new columns
- `packages/db/src/schema/sessions.ts` — DELETE entire file
- `packages/db/src/schema/accounts.ts` — DELETE entire file
- `packages/db/src/schema/verifications.ts` — DELETE entire file
- `packages/db/src/schema/messages.ts` — Add encryption columns
- `packages/db/src/schema/conversations.ts` — Add sharing columns
- Create `packages/db/src/schema/conversation-shares.ts`
- Create `packages/db/src/schema/message-shares.ts`

---

## Phase 3: New `packages/crypto` Package

### 3.1 Package Setup

```bash
mkdir -p packages/crypto/src
```

Create `packages/crypto/package.json`:

```json
{
  "name": "@lome-chat/crypto",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@cloudflare/opaque-ts": "^0.x.x",
    "@noble/ciphers": "^1.x.x",
    "@noble/curves": "^1.x.x",
    "@noble/hashes": "^1.x.x",
    "@scure/bip39": "^1.x.x",
    "hash-wasm": "^4.x.x"
  }
}
```

### 3.2 File Structure

```
packages/crypto/src/
├── index.ts                → Re-exports
├── opaque-client.ts        → OpaqueClient wrapper for registration & login
├── key-derivation.ts       → Argon2id (hash-wasm), HKDF (@noble/hashes)
├── encryption.ts           → AES-256-GCM encrypt/decrypt (@noble/ciphers)
├── recovery-phrase.ts      → BIP39 mnemonic generation (@scure/bip39)
├── compression.ts          → gzip compress/decompress (native CompressionStream)
├── sharing.ts              → ECDH X25519 key agreement (@noble/curves)
├── serialization.ts        → Base64 encode/decode utilities
└── types.ts                → TypeScript types for all crypto operations
```

### 3.3 Key Derivation (`key-derivation.ts`)

```typescript
import { argon2id } from 'hash-wasm';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

// Password → KEK (for wrapping DEK)
export async function derivePasswordKEK(
  password: Uint8Array,
  salt: Uint8Array
): Promise<Uint8Array> {
  const hash = await argon2id({
    password,
    salt,
    parallelism: 4,
    memorySize: 65536, // 64MB
    iterations: 3,
    hashLength: 32,
    outputType: 'binary',
  });
  return hash;
}

// Recovery phrase → KEK
export function deriveRecoveryKEK(seed: Uint8Array, salt: Uint8Array): Uint8Array {
  return hkdf(sha256, seed, salt, 'recovery-kek-v1', 32);
}

// Conversation key from DEK
export function deriveConversationKey(dek: Uint8Array, conversationId: string): Uint8Array {
  return hkdf(sha256, dek, 'conversation', `conv:${conversationId}`, 32);
}

// Message key from conversation key
export function deriveMessageKey(conversationKey: Uint8Array, messageId: string): Uint8Array {
  return hkdf(sha256, conversationKey, 'message', `msg:${messageId}`, 32);
}
```

### 3.4 Encryption (`encryption.ts`)

```typescript
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';

export function encrypt(
  key: Uint8Array,
  plaintext: Uint8Array
): { ciphertext: Uint8Array; iv: Uint8Array } {
  const iv = randomBytes(12);
  const cipher = gcm(key, iv);
  const ciphertext = cipher.encrypt(plaintext);
  return { ciphertext, iv };
}

export function decrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const cipher = gcm(key, iv);
  return cipher.decrypt(ciphertext);
}

// AES-KW for key wrapping
export async function wrapKey(kek: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', kek, 'AES-KW', false, ['wrapKey']);
  const keyToWrap = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt']
  );
  const wrapped = await crypto.subtle.wrapKey('raw', keyToWrap, cryptoKey, 'AES-KW');
  return new Uint8Array(wrapped);
}

export async function unwrapKey(kek: Uint8Array, wrappedKey: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', kek, 'AES-KW', false, ['unwrapKey']);
  const unwrapped = await crypto.subtle.unwrapKey(
    'raw',
    wrappedKey,
    cryptoKey,
    'AES-KW',
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt']
  );
  const exported = await crypto.subtle.exportKey('raw', unwrapped);
  return new Uint8Array(exported);
}
```

### 3.5 Compression (`compression.ts`)

```typescript
export async function compressIfSmaller(
  data: Uint8Array
): Promise<{ result: Uint8Array; compressed: boolean }> {
  const compressed = await compress(data);
  if (compressed.length < data.length) {
    return { result: compressed, compressed: true };
  }
  return { result: data, compressed: false };
}

async function compress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new CompressionStream('gzip');
  const writer = stream.writable.getWriter();
  writer.write(data);
  writer.close();

  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function decompress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('gzip');
  // ... similar to compress
}
```

### 3.6 Recovery Phrase (`recovery-phrase.ts`)

```typescript
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 128); // 12 words
}

export async function phraseToSeed(phrase: string): Promise<Uint8Array> {
  return mnemonicToSeed(phrase);
}

export function validatePhrase(phrase: string): boolean {
  return validateMnemonic(phrase, wordlist);
}
```

### 3.7 Sharing (`sharing.ts`)

```typescript
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

export function generateKeyPair(): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

export function deriveSharedSecret(
  myPrivateKey: Uint8Array,
  theirPublicKey: Uint8Array
): Uint8Array {
  const sharedPoint = x25519.getSharedSecret(myPrivateKey, theirPublicKey);
  return hkdf(sha256, sharedPoint, 'share-wrap-v1', '', 32);
}
```

---

## Phase 4: OPAQUE Implementation

### 4.1 Server-Side OPAQUE (`apps/api/src/lib/opaque-server.ts`)

```typescript
import { OpaqueServer, getOpaqueConfig, OpaqueID } from '@cloudflare/opaque-ts';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

export function createOpaqueServer(masterSecret: Uint8Array): OpaqueServer {
  // Derive OPRF seed and AKE keypair from master secret
  const oprfSeed = hkdf(sha256, masterSecret, 'opaque-oprf-seed-v1', '', 32);
  const akePrivateKey = hkdf(sha256, masterSecret, 'opaque-ake-private-v1', '', 32);

  const config = getOpaqueConfig(OpaqueID.OPAQUE_P256_SHA256);

  // Note: AKE public key derived from private key by the library
  return new OpaqueServer(
    config,
    Array.from(oprfSeed),
    { private_key: Array.from(akePrivateKey), public_key: [] }, // Library derives public
    'lome-chat.com'
  );
}
```

### 4.2 Client-Side OPAQUE (`packages/crypto/src/opaque-client.ts`)

```typescript
import { OpaqueClient, getOpaqueConfig, OpaqueID } from '@cloudflare/opaque-ts';

const config = getOpaqueConfig(OpaqueID.OPAQUE_P256_SHA256);

export function createOpaqueClient(): OpaqueClient {
  return new OpaqueClient(config);
}

// Registration
export async function startRegistration(client: OpaqueClient, password: Uint8Array) {
  return client.registerInit(password);
}

export async function finishRegistration(
  client: OpaqueClient,
  password: Uint8Array,
  blind: Uint8Array,
  serverResponse: Uint8Array
) {
  return client.registerFinish(password, blind, serverResponse);
}

// Login
export async function startLogin(client: OpaqueClient, password: Uint8Array) {
  return client.authInit(password);
}

export async function finishLogin(
  client: OpaqueClient,
  password: Uint8Array,
  state: Uint8Array,
  ke2: Uint8Array
) {
  return client.authFinish(password, state, ke2);
}
```

### 4.3 Auth Routes (`apps/api/src/routes/auth.ts`)

New endpoints:

- `POST /api/auth/register/init` — Start OPAQUE registration
- `POST /api/auth/register/finish` — Complete OPAQUE registration
- `POST /api/auth/login/init` — Start OPAQUE login (KE1)
- `POST /api/auth/login/challenge` — Server challenge (KE2)
- `POST /api/auth/login/finish` — Complete login (KE3)
- `POST /api/auth/2fa/verify` — Verify TOTP code
- `POST /api/auth/verify-email` — Verify email token
- `POST /api/auth/resend-verification` — Resend verification email
- `POST /api/auth/logout` — Clear session
- `POST /api/auth/password/change` — Change password (authenticated)
- `POST /api/auth/password/reset` — Reset password (via recovery phrase)
- `POST /api/auth/recovery/setup` — Setup recovery phrase
- `POST /api/auth/recovery/change` — Change recovery phrase
- `POST /api/auth/2fa/setup` — Setup 2FA
- `POST /api/auth/2fa/disable` — Disable 2FA

---

## Phase 5: TOTP Encryption (`apps/api/src/lib/totp.ts`)

```typescript
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { authenticator } from 'otplib';

let totpEncryptionKey: Uint8Array | null = null;

export function initTotpEncryption(masterSecret: Uint8Array): void {
  totpEncryptionKey = hkdf(sha256, masterSecret, 'totp-encryption-v1', 'totp', 32);
}

export function encryptTotpSecret(secret: string): { encrypted: Uint8Array; iv: Uint8Array } {
  if (!totpEncryptionKey) throw new Error('TOTP encryption not initialized');
  const iv = randomBytes(12);
  const cipher = gcm(totpEncryptionKey, iv);
  const encrypted = cipher.encrypt(new TextEncoder().encode(secret));
  return { encrypted, iv };
}

export function decryptTotpSecret(encrypted: Uint8Array, iv: Uint8Array): string {
  if (!totpEncryptionKey) throw new Error('TOTP encryption not initialized');
  const cipher = gcm(totpEncryptionKey, iv);
  const decrypted = cipher.decrypt(encrypted);
  return new TextDecoder().decode(decrypted);
}

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function generateTotpUri(email: string, secret: string): string {
  return authenticator.keyuri(email, 'LOME-CHAT', secret);
}

export function verifyTotpCode(code: string, secret: string): boolean {
  return authenticator.check(code, secret);
}
```

---

## Phase 6: Session Management (iron-session)

### 6.1 Session Configuration (`apps/api/src/lib/session.ts`)

```typescript
import { getIronSession, SessionOptions } from 'iron-session';

export interface SessionData {
  userId: string;
  email: string;
  emailVerified: boolean;
  totpEnabled: boolean;
  hasAcknowledgedPhrase: boolean;
  createdAt: number;
}

export function getSessionOptions(secret: string): SessionOptions {
  return {
    password: secret,
    cookieName: 'lome_session',
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    },
  };
}
```

### 6.2 Session Middleware (`apps/api/src/middleware/session.ts`)

Replace Better Auth session extraction with iron-session.

---

## Phase 7: DEK Persistence in Client (`apps/web/src/lib/auth-client.ts`)

```typescript
// Store encrypted password in sessionStorage for DEK re-derivation
const SESSION_KEY = 'lome_auth_state';

interface AuthState {
  encryptedPassword: string; // Base64
  passwordSalt: string; // Base64
}

export function persistAuthState(password: Uint8Array, salt: Uint8Array): void {
  // Encrypt password with a session-specific key derived from crypto.getRandomValues
  const sessionKey = crypto.getRandomValues(new Uint8Array(32));
  const { ciphertext, iv } = encrypt(sessionKey, password);

  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      encryptedPassword: toBase64(ciphertext),
      iv: toBase64(iv),
      sessionKey: toBase64(sessionKey), // Stored alongside, cleared on tab close
      passwordSalt: toBase64(salt),
    })
  );
}

export async function restoreDEK(): Promise<Uint8Array | null> {
  const stored = sessionStorage.getItem(SESSION_KEY);
  if (!stored) return null;

  const { encryptedPassword, iv, sessionKey, passwordSalt } = JSON.parse(stored);
  const password = decrypt(fromBase64(sessionKey), fromBase64(iv), fromBase64(encryptedPassword));
  const kek = await derivePasswordKEK(password, fromBase64(passwordSalt));

  // Fetch wrapped DEK from server and unwrap
  const response = await fetch('/api/auth/wrapped-dek');
  const { encryptedDekPassword } = await response.json();
  return unwrapKey(kek, fromBase64(encryptedDekPassword));
}
```

---

## Phase 8: Frontend Components

### 8.1 New Components

- `apps/web/src/components/auth/RecoveryPhraseModal.tsx` — 12-word display, verification input
- `apps/web/src/components/auth/TwoFactorSetup.tsx` — QR code (react-qrcode-logo), OTP input (input-otp)
- `apps/web/src/components/auth/TwoFactorInput.tsx` — Login 2FA verification

### 8.2 Packages to Install

```bash
pnpm --filter @lome-chat/web add otplib input-otp react-qrcode-logo
```

---

## Phase 9: Delete Better Auth Code

### 9.1 Files to Delete

- `apps/api/src/auth/index.ts`
- `apps/api/src/auth/index.integration.test.ts`
- `apps/api/src/routes/auth.ts` (replace with new implementation)
- `apps/api/src/routes/auth.test.ts`
- `apps/web/src/lib/auth.ts` (replace with new implementation)
- `apps/web/src/lib/auth.test.ts`
- `packages/db/src/schema/sessions.ts`
- `packages/db/src/schema/accounts.ts`
- `packages/db/src/schema/verifications.ts`
- `packages/db/src/utils/password.ts` (no longer needed, using OPAQUE)

### 9.2 Packages to Remove

```bash
pnpm --filter @lome-chat/api remove better-auth
pnpm --filter @lome-chat/web remove better-auth
pnpm --filter @lome-chat/db remove better-auth
```

---

## Phase 10: Documentation Updates

### 10.1 README.md — Add Security Section (near top, after "The Solution")

```markdown
---
## True Privacy: End-to-End Encryption

ChatGPT, Claude, and Gemini can read your conversations. We can't.

**Your password never leaves your device.** We use the OPAQUE protocol — the same state-of-the-art cryptography used by Cloudflare — so your password is never transmitted to our servers. Not even as a hash.

**Your messages are encrypted before they leave your browser.** We store ciphertext. We can't decrypt it. Our database admins can't decrypt it. Even if our servers were breached, attackers would get meaningless encrypted blobs.

**Only you hold the keys.** Your encryption keys are derived from your password on your device. Without your password (or recovery phrase), your data is cryptographically inaccessible — to everyone, including us.

| | ChatGPT | Claude | Gemini | LOME-CHAT |
|---|:---:|:---:|:---:|:---:|
| E2E Encrypted | No | No | No | **Yes** |
| Password sent to server | Yes | Yes | Yes | **No** |
| Provider can read chats | Yes | Yes | Yes | **No** |

This isn't marketing. It's mathematics.
---
```

### 10.2 TECH-STACK.md Updates

Add to Authentication section:

```markdown
## Authentication

| Technology                | Purpose                                                    |
| ------------------------- | ---------------------------------------------------------- |
| **@cloudflare/opaque-ts** | OPAQUE PAKE protocol. Password never leaves client.        |
| **iron-session**          | Encrypted session cookies. No server-side session storage. |
| **otplib**                | TOTP generation and verification for 2FA.                  |
| **input-otp**             | Accessible OTP input component.                            |
| **react-qrcode-logo**     | QR code generation for 2FA setup.                          |
```

Add to Cache section:

```markdown
## Cache

| Technology                | Purpose                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| **Upstash Redis**         | Serverless Redis. OPAQUE challenge state, rate limiting, 2FA attempt tracking. |
| **Serverless Redis HTTP** | Local development proxy. Emulates Upstash REST API for local Redis.            |
```

Add new Cryptography section:

```markdown
## Cryptography

| Technology         | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| **@noble/ciphers** | AES-256-GCM encryption. Audited, no dependencies. |
| **@noble/curves**  | X25519 ECDH for sharing keys.                     |
| **@noble/hashes**  | SHA-256, HKDF for key derivation.                 |
| **@scure/bip39**   | BIP39 mnemonic generation for recovery phrases.   |
| **hash-wasm**      | Argon2id password hashing in WASM.                |
```

---

## Phase 11: Testing

### 11.1 Unit Tests (packages/crypto)

- `key-derivation.test.ts` — Argon2id, HKDF derivation
- `encryption.test.ts` — AES-GCM encrypt/decrypt, key wrap/unwrap
- `recovery-phrase.test.ts` — BIP39 generation, validation
- `compression.test.ts` — gzip compress/decompress, size comparison
- `sharing.test.ts` — X25519 key generation, shared secret derivation
- `opaque-client.test.ts` — OPAQUE client operations

### 11.2 Integration Tests (apps/api)

- `auth.integration.test.ts` — Full OPAQUE registration/login flow
- `totp.integration.test.ts` — 2FA setup/verification
- `email-verification.integration.test.ts` — Email verification flow
- `recovery.integration.test.ts` — Recovery phrase setup/reset

### 11.3 E2E Tests

- `auth.e2e.ts` — Signup, login, logout flows
- `2fa.e2e.ts` — 2FA setup and login
- `recovery.e2e.ts` — Recovery phrase setup and password reset

---

## Implementation Order

1. **Phase 1: Redis Setup** — Infrastructure foundation
2. **Phase 3: packages/crypto** — Crypto utilities (can be tested independently)
3. **Phase 2: Database Migration** — Schema changes
4. **Phase 4: OPAQUE Implementation** — Core auth
5. **Phase 6: Session Management** — iron-session
6. **Phase 5: TOTP Encryption** — 2FA support
7. **Phase 7: DEK Persistence** — Client-side auth state
8. **Phase 8: Frontend Components** — UI for auth flows
9. **Phase 9: Delete Better Auth** — Remove old code
10. **Phase 10: Documentation** — README and TECH-STACK updates
11. **Phase 11: Testing** — Comprehensive test coverage

---

## Critical Files Summary

### New Files to Create

| File                                                   | Purpose                       |
| ------------------------------------------------------ | ----------------------------- |
| `packages/crypto/src/*`                                | All crypto utilities          |
| `apps/api/src/lib/redis.ts`                            | Redis client                  |
| `apps/api/src/lib/opaque-server.ts`                    | OPAQUE server setup           |
| `apps/api/src/lib/totp.ts`                             | TOTP encryption/verification  |
| `apps/api/src/lib/session.ts`                          | iron-session configuration    |
| `apps/api/src/middleware/redis.ts`                     | Redis middleware              |
| `apps/api/src/routes/auth.ts`                          | New auth routes (replace old) |
| `apps/web/src/lib/auth-client.ts`                      | New auth client (replace old) |
| `apps/web/src/components/auth/RecoveryPhraseModal.tsx` | Recovery phrase UI            |
| `apps/web/src/components/auth/TwoFactorSetup.tsx`      | 2FA setup UI                  |
| `apps/web/src/components/auth/TwoFactorInput.tsx`      | 2FA input UI                  |
| `packages/db/src/schema/conversation-shares.ts`        | Sharing schema                |
| `packages/db/src/schema/message-shares.ts`             | Sharing schema                |

### Files to Modify

| File                                      | Changes                    |
| ----------------------------------------- | -------------------------- |
| `docker-compose.yml`                      | Add Redis + SRH services   |
| `packages/shared/src/env.config.ts`       | Add Redis env vars         |
| `packages/db/src/schema/users.ts`         | Add encryption columns     |
| `packages/db/src/schema/messages.ts`      | Add encryption columns     |
| `packages/db/src/schema/conversations.ts` | Add sharing columns        |
| `packages/db/src/schema/index.ts`         | Export new schemas         |
| `apps/api/src/types.ts`                   | Add Redis to AppEnv        |
| `apps/api/src/app.ts`                     | Add Redis middleware       |
| `README.md`                               | Add E2E encryption section |
| `docs/TECH-STACK.md`                      | Add new technologies       |

### Files to Delete

| File                                      | Reason             |
| ----------------------------------------- | ------------------ |
| `apps/api/src/auth/*`                     | Better Auth config |
| `packages/db/src/schema/sessions.ts`      | Better Auth table  |
| `packages/db/src/schema/accounts.ts`      | Better Auth table  |
| `packages/db/src/schema/verifications.ts` | Better Auth table  |
| `packages/db/src/utils/password.ts`       | No longer needed   |
