# Execution Plan: Full E2EE Architecture Transition

## Context

Complete transition of HushBox from current DEK-based encryption + REST API to the new epoch-based E2EE architecture with Hono RPC, Durable Objects, group conversations, shared links, budget system, and wallet-based billing. No existing users — clean slate. The authoritative specification is the design document provided by the user (Parts 1–17).

This change is needed because the current architecture uses a Data Encryption Key (DEK) model that doesn't support group conversations, public link sharing, or server-side encryption of AI responses. The new epoch-based ECIES system enables all of these while maintaining the guarantee that the server can encrypt but never decrypt message content.

---

## Decision Log

| #   | Decision                   | Chosen                                                                                       | Rationale                                                                                                                                                                                                             |
| --- | -------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Guest systems              | Keep both: `trial` (anonymous) + `linkGuest` (shared link)                                   | Anonymous trial for marketing, link-based for conversations                                                                                                                                                           |
| 2   | Migration strategy         | Single clean migration (delete 0008–0012)                                                    | No users, clean slate                                                                                                                                                                                                 |
| 3   | Crypto package             | Audit & fix to match design doc                                                              | Info strings, compression, version alignment needed                                                                                                                                                                   |
| 4   | PostgreSQL version         | PG18 ready, use native `uuidv7()`                                                            | Design doc requires it                                                                                                                                                                                                |
| 5   | HKDF info strings          | Match design doc exactly                                                                     | `"shared-link-v1"` → `"link-keypair-v1"`, `"message-share-v1"` → `"share-msg-v1"`                                                                                                                                     |
| 6   | Compression                | Switch gzip → raw deflate                                                                    | Saves ~18B/msg, matches design doc                                                                                                                                                                                    |
| 7   | Drizzle enums              | All text columns                                                                             | More flexible, no migration needed for new values                                                                                                                                                                     |
| 8   | Guest naming               | `trial` / `linkGuest`                                                                        | Clear code separation                                                                                                                                                                                                 |
| 9   | Link expiry                | No expiry (removed requirement 24)                                                           | Links valid until explicitly revoked                                                                                                                                                                                  |
| 10  | API layer                  | All routes are Hono; typed client via `hc<AppType>()`; no separate RPC framework             | Single framework, type inference from chained route definitions                                                                                                                                                       |
| 11  | Naming convention          | camelCase throughout plan                                                                    | Matches TypeScript/Drizzle. Actual SQL migration uses snake_case; Drizzle auto-maps.                                                                                                                                  |
| 12  | Messages column transition | DROP `content` + ADD `encryptedBlob` (not RENAME)                                            | AES-GCM and ECIES are fundamentally different formats; RENAME implies data continuity                                                                                                                                 |
| 13  | Payment status values      | 5 statuses: `pending`, `awaitingWebhook`, `completed`, `failed`, `refunded`                  | Explicit intermediate state for two-phase payment flow; supports idempotent webhook handler                                                                                                                           |
| 14  | Communication architecture | Hono RPC for request-response, SSE for chat streaming, WebSocket+DO for group broadcast only | SSE kept for `POST /api/chat` and `POST /api/trial`; DO only for multi-member conversations                                                                                                                           |
| 15  | All-in-one transaction     | User msg + AI msg + billing in one atomic transaction; no refund logic                       | On failure nothing is persisted or charged; eliminates need for refund path on message sends                                                                                                                          |
| 16  | Integrated rotation        | Lazy epoch rotation lives in `POST /api/chat` stream route, not a standalone endpoint        | Rotation always accompanies a message (that's what "lazy" means). Single atomic transaction: rotation + message + AI + billing. Standalone endpoint would either duplicate the streaming pipeline or break atomicity. |

---

## Ground Rules

- Run `pnpm lint` and `pnpm typecheck` after every batch of changes in the affected package
- TDD discipline: failing test first, always — follow AGENT-RULES.md strictly
- Zero code duplication — extract shared utilities into `packages/`
- Supreme code quality: small functions, clear separation, thorough error handling
- Keep cost calculation logic IDENTICAL (see Phase 4 preservation list)
- All IDs: PG18 native `DEFAULT uuidv7()` via `default(sql`uuidv7()`)` in Drizzle
- All monetary values: `numeric(20,8)`
- All binary columns: custom `bytea` type from `packages/db/src/schema/bytea.ts`
- All type/status columns: text (no Drizzle enums)
- Crypto boundary: `packages/crypto` is the ONLY package that imports `@noble/*`, `hash-wasm`, `@scure/bip39`, `fflate`, or `@cloudflare/opaque-ts` (client-side)
- `apps/api` imports `@cloudflare/opaque-ts` (server-side), `iron-session`, `otplib` — no other crypto libs
- Naming: camelCase for all column/table references in this plan (matching TypeScript/Drizzle). The actual SQL migration file uses snake_case; Drizzle maps between them automatically. No mixing.
- All API routes use Hono with chained syntax. Typed client via `hc<AppType>()` from `hono/client`. Input validation via `@hono/zod-validator`.

---

## Phase Dependency Graph

```
Phase 0 (Crypto Fixes) ──→ Phase 1 (DB Schema)
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    v               v               v
             Phase 3 (Auth)  Phase 2 (Hono RPC)  Phase 7 (Route Restructuring)
                    │               │
                    v               │
             Phase 4 (Billing) <────┘
                    │
                    v
             Phase 5 (Conversations)
                    │
          ┌─────────┴─────────┐
          │                   │
          v                   v
   Phase 6 (DO/Real-time)  Phase 8 (Groups)
          │                   │
          └────→ Phase 9 (Sharing) ←────┘
                      │
                      v
               Phase 10 (Frontend)
                      │
                      v
               Phase 11 (Cleanup)
```

- Phases 0 and 1 are sequential (0 before 1).
- After Phase 1: Phases 2, 3, and 7 can proceed in parallel.
  - Phase 2 (Hono RPC Infrastructure) sets up `@hono/zod-validator`, `api-client.ts`, and React Query patterns.
  - Phase 3 (Auth) updates auth routes for the new key hierarchy.
  - Phase 7 (Route Restructuring) converts existing route files to chained Hono syntax for type inference.
- Phase 4 (Billing) depends on Phase 1 + Phase 3.
- Phase 5 (Conversations) depends on Phase 1 + Phase 3 + Phase 4. Benefits from Phase 2 and 7 being complete.
- Phase 6 (DO/Real-time) depends on Phase 5.
- Phase 8 (Groups) depends on Phase 5.
- Phase 9 (Sharing) depends on Phase 5 + Phase 6 + Phase 8.
- Phase 10 (Frontend) depends on all prior phases.
- Phase 11 (Cleanup) is last.

---

## Phase 0: Crypto Package Fixes

**Goal:** Fix `@noble/*` version mismatch, update HKDF info strings, switch compression to raw deflate, clean up exports.

### 0A — Version Alignment

| Package                              | Current  | Target   | Action                           |
| ------------------------------------ | -------- | -------- | -------------------------------- |
| `packages/crypto` → `@noble/ciphers` | `^1.2.1` | `^2.1.1` | Update + fix import paths        |
| `packages/crypto` → `@noble/hashes`  | `^1.7.1` | `^2.0.1` | Update + fix import paths        |
| `apps/api` → `@noble/ciphers`        | `^2.1.1` | REMOVE   | All crypto via `@hushbox/crypto` |
| `apps/api` → `@noble/hashes`         | `^2.0.1` | REMOVE   | All crypto via `@hushbox/crypto` |

The v2 APIs changed import paths (e.g., `@noble/ciphers/aead` → `@noble/ciphers`). Update all imports in `packages/crypto/src/`.

### 0B — HKDF Info String Fixes

| File                                   | Current              | New                 |
| -------------------------------------- | -------------------- | ------------------- |
| `packages/crypto/src/link.ts`          | `"shared-link-v1"`   | `"link-keypair-v1"` |
| `packages/crypto/src/message-share.ts` | `"message-share-v1"` | `"share-msg-v1"`    |

Update in both the derivation functions and their tests.

### 0C — Compression: gzip → Raw Deflate

**File:** `packages/crypto/src/compression.ts`

- Change `gzipSync()` → `deflateSync()` from `fflate`
- Change `gunzipSync()` → `inflateSync()` from `fflate`
- Saves ~18 bytes per message (no gzip headers)
- Update `message-codec.ts` compression flag byte if it encodes format type (verify)

### 0D — Export Cleanup

- Verify `deriveSharedSecret` from `sharing.ts` is NOT exported from `index.ts` (internal only)
- Verify all exports in `index.ts` match the design doc Part 11 API surface

### Verification

```bash
cd packages/crypto && pnpm typecheck && pnpm lint && pnpm test
cd apps/api && pnpm typecheck && pnpm lint
```

---

## Phase 1: Database Schema Overhaul

**Goal:** Replace entire schema to match design doc Part 14. Single clean migration from the 0007 baseline.

### 1A — Delete Old Migrations

Delete migration files 0008–0012 and their journal entries:

- `packages/db/drizzle/0008_encryption_columns.sql`
- `packages/db/drizzle/0009_auth_columns_not_null.sql`
- `packages/db/drizzle/0010_drop_plaintext_columns.sql`
- `packages/db/drizzle/0011_drop_guest_usage.sql`
- `packages/db/drizzle/0012_rename_name_to_username.sql`
- Update `packages/db/drizzle/meta/_journal.json` to remove entries for idx 9–12

### 1B — Migration File: `packages/db/drizzle/0008_full_schema_overhaul.sql`

Hand-written SQL (snake_case in actual SQL file; camelCase used below for plan readability). Structured in dependency order:

**Step 1 — DROP old tables and enums:**

```sql
DROP TABLE IF EXISTS "message_shares";
DROP TABLE IF EXISTS "conversation_shares";
DROP TABLE IF EXISTS "balance_transactions";
DROP TABLE IF EXISTS "guest_usage";
DROP TYPE IF EXISTS "balance_transaction_type";
DROP TYPE IF EXISTS "deduction_source";
DROP TYPE IF EXISTS "message_role";
DROP TYPE IF EXISTS "payment_status";
```

**Step 2 — ALTER `users`:**

- DROP: balance, freeAllowanceCents, freeAllowanceResetAt, passwordSalt, encryptedDekPassword, phraseSalt, encryptedDekPhrase, phraseVerifier, encryptionVersion, totpIv, name, image, privateKeyWrapped
- ADD: `username` (text NOT NULL UNIQUE), `passwordWrappedPrivateKey` (bytea NOT NULL), `recoveryWrappedPrivateKey` (bytea NOT NULL)
- KEEP: id, email, emailVerified, emailVerifyToken, emailVerifyExpires, opaqueRegistration, publicKey, totpSecretEncrypted, totpEnabled, hasAcknowledgedPhrase, createdAt, updatedAt
- Change `id` default to `uuidv7()`

**Step 3 — ALTER `conversations`:**

- DROP: isPublic, publicShareId, publicShareExpires
- ADD: `projectId` (text FK→projects ON DELETE SET NULL), `titleEpochNumber` (int NOT NULL DEFAULT 1), `currentEpoch` (int NOT NULL DEFAULT 1), `nextSequence` (int NOT NULL DEFAULT 1), `rotationPending` (boolean NOT NULL DEFAULT false), `perPersonBudget` (numeric 20,8 nullable), `conversationBudget` (numeric 20,8 nullable)
- KEEP: title (bytea NOT NULL — now ECIES blob under epoch key instead of AES-GCM)
- Change `id` default to `uuidv7()`

**Step 4 — ALTER `messages`:**

- DROP columns: `role`, `iv`, `model`, `balanceTransactionId`, `cost`, `sharingKeyWrapped`, `contentType`, `pendingReEncryption`, `ephemeralPublicKey`, **`content`**
- ADD column: **`encryptedBlob`** (bytea NOT NULL)
- ADD columns: `senderType` (text NOT NULL), `senderId` (text nullable), `senderDisplayName` (text nullable), `payerId` (text nullable), `epochNumber` (int NOT NULL), `sequenceNumber` (int NOT NULL)
- CHECK: `senderType IN ('user', 'ai')`
- DROP OLD INDEX on conversationId
- ADD INDEX: (conversationId, sequenceNumber)
- Change `id` default to `uuidv7()`

**Why DROP + ADD instead of RENAME:** The old `content` column stores AES-GCM ciphertext (DEK-encrypted by the client, with a separate `iv` column). The new `encryptedBlob` stores ECIES blobs: version byte (1B) + ephemeral X25519 public key (32B) + XChaCha20-Poly1305 ciphertext + Poly1305 tag (16B). These are completely different encryption formats. `RENAME` would falsely suggest data continuity. Since there are no existing users (clean slate), a clean `DROP` + `ADD` makes the break explicit.

**Step 5 — ALTER `projects`:**

- DROP: name, description
- ADD: `encryptedName` (bytea NOT NULL), `encryptedDescription` (bytea nullable)
- Change `id` default to `uuidv7()`

**Step 6 — ALTER `payments`:**

- Make userId nullable
- Change FK from ON DELETE CASCADE to ON DELETE SET NULL
- Change status from enum to text
- CHECK: `status IN ('pending', 'awaitingWebhook', 'completed', 'failed', 'refunded')`
- Change `id` default to `uuidv7()`

**Status flow:**

```
pending → awaitingWebhook → completed (happy path)
pending → failed (pre-processing failure)
awaitingWebhook → failed (webhook reports failure)
completed → refunded (admin action or dispute)
```

**Rationale:** The current codebase uses `awaitingWebhook` as an intermediate state between Helcim's synchronous approval and the webhook callback (which credits the balance). The `processWebhookCredit()` function relies on an atomic `UPDATE payments SET status = 'completed' WHERE helcimTransactionId = ? AND status = 'awaitingWebhook'` — this conditional update is the idempotency mechanism. Without the explicit status, `pending` would be overloaded (meaning both "not submitted" and "approved but unconfirmed"), and the idempotent conditional update pattern would need reworking.

**Step 7 — CREATE new tables** (in FK dependency order):

| Table                   | Key Columns                                                                                                                                                   | Notes                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wallets`               | id, userId FK→users SET NULL, type (text), balance (numeric 20,8 default 0), priority (int), createdAt                                                        | Index on userId                                                                                                                                                                                                                                                                                               |
| `usage_records`         | id, userId FK→users SET NULL, type (text), status (text default 'pending'), cost (numeric 20,8), sourceType, sourceId, createdAt, completedAt                 | CHECK: `status IN ('pending', 'completed', 'failed')`. Indexes: (userId, type, createdAt), (sourceType, sourceId)                                                                                                                                                                                             |
| `ledger_entries`        | id, walletId FK CASCADE, amount, balanceAfter, entryType (text), paymentId FK SET NULL, usageRecordId FK SET NULL, sourceWalletId FK SET NULL, createdAt      | CHECK: `entryType IN ('deposit', 'usage_charge', 'refund', 'adjustment', 'renewal', 'welcome_credit')`. CHECK: exactly one of (paymentId, usageRecordId, sourceWalletId) IS NOT NULL. Indexes: (walletId, createdAt), (usageRecordId) WHERE usageRecordId IS NOT NULL                                         |
| `llm_completions`       | id, usageRecordId FK CASCADE UNIQUE, model, provider, inputTokens, outputTokens, cachedTokens (default 0)                                                     | Index on model                                                                                                                                                                                                                                                                                                |
| `shared_links`          | id, conversationId FK CASCADE, linkPublicKey (bytea), privilege (text default 'read'), visibleFromEpoch (int), revokedAt, createdAt                           | CHECK: `privilege IN ('read', 'write')`. Index: (conversationId) WHERE revokedAt IS NULL                                                                                                                                                                                                                      |
| `conversation_members`  | id, conversationId FK CASCADE, userId FK SET NULL, linkId FK→sharedLinks SET NULL, privilege (text default 'write'), visibleFromEpoch (int), joinedAt, leftAt | CHECK: `privilege IN ('read', 'write', 'admin', 'owner')`. CHECK: `(userId IS NOT NULL) OR (linkId IS NOT NULL)`. UNIQUE: (conversationId, userId) WHERE leftAt IS NULL. UNIQUE: (conversationId, linkId) WHERE leftAt IS NULL. Indexes: (conversationId) WHERE leftAt IS NULL, (userId) WHERE leftAt IS NULL |
| `epochs`                | id, conversationId FK CASCADE, epochNumber, epochPublicKey (bytea), confirmationHash (bytea), chainLink (bytea nullable), createdAt                           | UNIQUE (conversationId, epochNumber)                                                                                                                                                                                                                                                                          |
| `epoch_members`         | id, epochId FK CASCADE, memberPublicKey (bytea), wrap (bytea), privilege (text), visibleFromEpoch (int), createdAt                                            | CHECK: `privilege IN ('read', 'write', 'admin', 'owner')`. UNIQUE (epochId, memberPublicKey). Index on memberPublicKey                                                                                                                                                                                        |
| `pending_removals`      | id, conversationId FK CASCADE, memberId FK→conversationMembers CASCADE, requestedBy FK→users SET NULL, createdAt                                              | Index on conversationId                                                                                                                                                                                                                                                                                       |
| `shared_messages`       | id, messageId FK→messages CASCADE, shareBlob (bytea), createdAt                                                                                               |                                                                                                                                                                                                                                                                                                               |
| `member_budgets`        | id, memberId FK→conversationMembers CASCADE UNIQUE, budget (numeric 20,8), spent (numeric 20,8 default 0), createdAt                                          |                                                                                                                                                                                                                                                                                                               |
| `conversation_spending` | id, conversationId FK CASCADE UNIQUE, totalSpent (numeric 20,8 default 0), updatedAt                                                                          | `totalSpent` only increments when the owner is charged on behalf of a non-owner member — not when the owner sends their own messages                                                                                                                                                                          |

All new table IDs use `DEFAULT uuidv7()`.

**Step 8 — All CHECK constraints summary (camelCase for plan readability):**

```
-- messages
CHECK (senderType IN ('user', 'ai'))

-- payments (altered in Step 6)
CHECK (status IN ('pending', 'awaitingWebhook', 'completed', 'failed', 'refunded'))

-- usageRecords
CHECK (status IN ('pending', 'completed', 'failed'))

-- ledgerEntries (exactly one FK non-null)
CHECK (
  (paymentId IS NOT NULL)::int +
  (usageRecordId IS NOT NULL)::int +
  (sourceWalletId IS NOT NULL)::int = 1
)
CHECK (entryType IN ('deposit', 'usage_charge', 'refund', 'adjustment', 'renewal', 'welcome_credit'))

-- sharedLinks
CHECK (privilege IN ('read', 'write'))

-- conversationMembers
CHECK ((userId IS NOT NULL) OR (linkId IS NOT NULL))
CHECK (privilege IN ('read', 'write', 'admin', 'owner'))

-- epochMembers
CHECK (privilege IN ('read', 'write', 'admin', 'owner'))
```

Note: `entryType` string values use snake_case (`usage_charge`, `welcome_credit`) because these are stored data values, not column names. Drizzle auto-maps column names (camelCase → snake_case) but does NOT transform string values. The design doc uses snake_case for multi-word enum values.

**Step 9 — All partial unique indexes** (explicit SQL):

```sql
-- conversation_members: prevent duplicate active members
CREATE UNIQUE INDEX conversation_members_user_active
  ON conversation_members (conversation_id, user_id) WHERE left_at IS NULL;
CREATE UNIQUE INDEX conversation_members_link_active
  ON conversation_members (conversation_id, link_id) WHERE left_at IS NULL;

-- conversation_members: fast active member lookups
CREATE INDEX conversation_members_active
  ON conversation_members (conversation_id) WHERE left_at IS NULL;
CREATE INDEX conversation_members_user_active_lookup
  ON conversation_members (user_id) WHERE left_at IS NULL;
```

### 1C — Drizzle Schema Files

**DELETE:**

- `packages/db/src/schema/balance-transactions.ts`
- `packages/db/src/schema/conversation-shares.ts`
- `packages/db/src/schema/message-shares.ts`
- `packages/db/src/schema/guest-usage.ts` (if remnant exists)
- `packages/db/src/schema/sessions.ts` (if remnant exists)
- `packages/db/src/schema/accounts.ts` (if remnant exists)
- `packages/db/src/schema/verifications.ts` (if remnant exists)

**KEEP:**

- `bytea.ts` — used by all bytea columns
- `service-evidence.ts` — testing/audit log, unchanged

**CREATE** (new files):

1. `wallets.ts`
2. `usage-records.ts`
3. `llm-completions.ts`
4. `ledger-entries.ts`
5. `shared-links.ts`
6. `conversation-members.ts`
7. `epochs.ts`
8. `epoch-members.ts`
9. `pending-removals.ts`
10. `shared-messages.ts`
11. `member-budgets.ts`
12. `conversation-spending.ts`

**MODIFY:**

- `users.ts` — drop old columns, add `passwordWrappedPrivateKey` (bytea NOT NULL), `recoveryWrappedPrivateKey` (bytea NOT NULL), `username` (text NOT NULL UNIQUE). Remove all DEK/balance/phrase columns. Change ID default to `sql`uuidv7()``
- `conversations.ts` — drop isPublic/publicShareId/publicShareExpires, add projectId/titleEpochNumber/currentEpoch/nextSequence/rotationPending/perPersonBudget/conversationBudget
- `messages.ts` — drop role/iv/model/balanceTransactionId/cost/sharingKeyWrapped/contentType/pendingReEncryption/ephemeralPublicKey, **drop content, add encryptedBlob** (bytea NOT NULL), add senderType/senderId/senderDisplayName/payerId/epochNumber/sequenceNumber
- `projects.ts` — replace name→encryptedName (bytea NOT NULL), description→encryptedDescription (bytea nullable)
- `payments.ts` — make userId nullable, FK ON DELETE SET NULL, status as text (not enum)
- `index.ts` — update barrel exports

### 1D — Factories

**MODIFY:**

- `user.ts` — remove DEK/balance fields, add passwordWrappedPrivateKey, recoveryWrappedPrivateKey (use crypto `createAccount()` for realistic test data)
- `conversation.ts` — remove isPublic/publicShareId, add currentEpoch/titleEpochNumber/nextSequence/rotationPending/budget fields
- `message.ts` — remove role/iv/model/cost/etc, drop content field, add encryptedBlob field, add senderType/senderId/payerId/epochNumber/sequenceNumber
- `payment.ts` — make userId nullable, status as string

**CREATE:**

- `wallet.ts`, `usage-record.ts`, `llm-completion.ts`, `ledger-entry.ts`, `epoch.ts`, `epoch-member.ts`, `conversation-member.ts`, `shared-link.ts`

**DELETE:** `balance-transaction.ts` factory (if exists)

### 1E — Zod Schemas (`packages/db/src/zod/`)

- Remove schemas for dropped tables
- Add select/insert schemas for all 12 new tables (with bytea → `instanceof Uint8Array` overrides)
- Update user, conversation, message, project, payment schemas for column changes

### Verification

```bash
cd packages/db && pnpm typecheck && pnpm lint && pnpm test
```

---

## Phase 2: Hono RPC Infrastructure

**Goal:** Set up the typed Hono RPC client infrastructure. Add `@hono/zod-validator`, create `api-client.ts` with `hc<AppType>()`, establish React Query wrapper patterns. This enables Phase 7 (Route Restructuring) and Phase 10 (Frontend).

### 2A — Install Dependencies

| Package               | Where      | Purpose                                                        |
| --------------------- | ---------- | -------------------------------------------------------------- |
| `@hono/zod-validator` | `apps/api` | Zod-based input validation middleware for chained route syntax |

`hono` is already installed. `hono/client` is a subpath export of the existing `hono` package (zero additional dependency). `@tanstack/react-query` is already in `apps/web`.

### 2B — Export AppType from API

In `apps/api/src/app.ts`, the app must use chained `.route()` calls so the inferred type captures all route definitions. Export `type AppType = typeof app`. The barrel export or a dedicated type file must expose `AppType` so `apps/web` can import it as `import type { AppType } from '@hushbox/api'`.

During this phase, only a minimal chained route (e.g., health) needs to demonstrate the pattern. Full conversion happens in Phase 7.

### 2C — Create `apps/web/src/lib/api-client.ts`

```typescript
/**
 * Single source for all typed API calls.
 * All server state hooks (useQuery/useMutation) import `client` from here.
 * Never use raw fetch() for endpoints covered by this client.
 */
import { hc } from 'hono/client';
import type { AppType } from '@hushbox/api';
export const client = hc<AppType>(getApiUrl(), { init: { credentials: 'include' } });
```

All frontend code imports from this file. The `client` object provides fully typed method calls. No separate example file — the CODE-RULES.md API Client pattern and this file's doc comment are the reference. React Query wrapping pattern is learned from the first hook written in Phase 10.

### 2D — What Stays vs. What Changes

| Aspect               | Before                            | After (Hono RPC)                                   |
| -------------------- | --------------------------------- | -------------------------------------------------- |
| Server handler logic | Same                              | Same                                               |
| Input validation     | `@hono/zod-openapi` `createRoute` | `@hono/zod-validator` `zValidator('json', schema)` |
| Response typing      | OpenAPI schema definitions        | Inferred from `c.json()` return type               |
| Client calls         | Manual `fetch()` + hand-typed     | `client.api.route.$method()` (inferred types)      |
| Error handling       | HTTP status codes                 | HTTP status codes (unchanged)                      |
| Auth middleware      | Hono middleware                   | Hono middleware (unchanged)                        |
| Streaming            | Hono SSE (`streamSSE`)            | Hono SSE (unchanged)                               |
| Webhook              | Plain Hono route                  | Plain Hono route (unchanged)                       |

### Verification

```bash
cd apps/api && pnpm typecheck && pnpm lint && pnpm test
cd apps/web && pnpm typecheck && pnpm lint
```

---

## Phase 3: Auth System Update

**Goal:** Update auth routes for new key hierarchy (ECIES-wrapped account keys, no DEK). Design doc Parts 3, 16.

### 3A — Registration Flow (`apps/api/src/routes/opaque-auth.ts`)

**`POST /register/finish` — New payload:**

```typescript
{
  (email,
    username,
    registrationRecord,
    accountPublicKey,
    passwordWrappedPrivateKey,
    recoveryWrappedPrivateKey);
}
```

Server stores atomically:

- `accountPublicKey` → `users.publicKey`
- `passwordWrappedPrivateKey` → `users.passwordWrappedPrivateKey`
- `recoveryWrappedPrivateKey` → `users.recoveryWrappedPrivateKey`
- Two wallets: `{ type: 'purchased', balance: WELCOME_CREDIT_BALANCE, priority: 0 }` + `{ type: 'free_tier', balance: FREE_ALLOWANCE_CENTS, priority: 1 }`
- Two ledger entries: welcome_credit for each wallet

### 3B — Login Flow

**`POST /login/finish` response:**

```typescript
{
  (success, userId, email, passwordWrappedPrivateKey);
}
```

Client: `unwrapAccountKeyWithPassword(opaqueExportKey, blob)` → account private key in memory.

### 3C — `/me` Response (`GET /api/auth/me`)

Stays as plain Hono route because it's called during session restoration before the typed client is initialized.

**New response:** `{ user, passwordWrappedPrivateKey, publicKey }`

### 3D — Password Change (`/change-password/finish`)

Client: `rewrapAccountKeyForPasswordChange(accountPrivateKey, newOpaqueExportKey)` → sends `newPasswordWrappedPrivateKey`. Server stores new blob + new OPAQUE registration atomically. Recovery blob unchanged.

### 3E — Recovery Flow

**DELETE old endpoints:** `recovery/request-salt`, `recovery/verify-phrase`

**New flow:**

1. Client enters 12-word mnemonic
2. Client: `recoverAccountFromMnemonic(mnemonic, recoveryWrappedBlob)` → account private key
3. Client performs OPAQUE re-registration → sends new `passwordWrappedPrivateKey`

**New endpoint:** `POST /recovery/reset` — receives newRegistrationRecord + newPasswordWrappedPrivateKey.

### 3F — Recovery Phrase Save (`/recovery/save`)

**New:** Saves `recoveryWrappedPrivateKey` (re-generated from new mnemonic). Sets `hasAcknowledgedPhrase = true`.

### 3G — TOTP Encryption (`apps/api/src/lib/totp.ts`)

- Import `symmetricEncrypt`/`symmetricDecrypt` from `@hushbox/crypto`
- Remove `totpIv` column usage — nonce prepended inside the symmetric blob
- `encryptTotpSecret(secret, key)` → single blob (nonce + ciphertext + tag)
- `decryptTotpSecret(blob, key)` → plaintext secret

### 3H — Frontend Auth Store (`apps/web/src/lib/auth.ts`)

- REMOVE: `dek: Uint8Array | null`, `setDEK()`
- KEEP: `privateKey: Uint8Array | null` (account X25519 private key)
- `clear()`: zero `privateKey`, clear state
- `signUpEmail()`: calls `createAccount(exportKey)` from crypto → sends accountPublicKey + wrappedBlobs
- `signInEmail()`: receives `passwordWrappedPrivateKey` → calls `unwrapAccountKeyWithPassword(exportKey, blob)` → sets `privateKey`

### 3I — Frontend Auth Client (`apps/web/src/lib/auth-client.ts`)

- `STORAGE_KEY` stays `'lome_auth_kek'` (still persists export key)
- `restoreSession()`: fetch `/api/auth/me` → receive `passwordWrappedPrivateKey` → unwrap with stored export key
- Rename `persistKEK` → `persistExportKey` (clearer name)

### 3J — Frontend Auth Routes

- Update signup to send new payload (accountPublicKey, passwordWrappedPrivateKey, recoveryWrappedPrivateKey)
- Update login to handle `passwordWrappedPrivateKey` response
- Update recovery flow: local mnemonic unwrap instead of server-side verify

### 3K — RecoveryPhraseModal Changes

- Remove `computePhraseVerifier` (no server-side verifier)
- Remove `wrapKey` usage → `regenerateRecoveryPhrase(accountPrivateKey)`
- Save: POST new `recoveryWrappedPrivateKey` to server

### Verification

```bash
cd apps/api && pnpm typecheck && pnpm lint && pnpm test
cd apps/web && pnpm typecheck && pnpm lint && pnpm test
```

---

## Phase 4: Billing System Transition

**Goal:** Migrate from user-column balances + balance_transactions to wallets + ledger_entries + usage_records + llm_completions. Design doc Part 9.

### Files That MUST NOT Change Their Algorithms

| File                                               | Functions to Preserve Exactly                                                                                                                                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/pricing.ts`                   | `estimateMessageCostDevelopment()`, `calculateMessageCostFromOpenRouter()`, `applyFees()`, `calculateTokenCostWithFees()`, `getModelCostPer1k()`, `isExpensiveModel()`, `estimateTokenCount()`                                                      |
| `packages/shared/src/constants.ts`                 | All fee rates (5%+4.5%+5.5%=15%), `STORAGE_COST_PER_CHARACTER`, `STORAGE_COST_PER_1K_CHARS`, `EXPENSIVE_MODEL_THRESHOLD_PER_1K`, `CHARS_PER_TOKEN_*`, `MAX_ALLOWED_NEGATIVE_BALANCE_CENTS`, `MAX_TRIAL_MESSAGE_COST_CENTS`, `MINIMUM_OUTPUT_TOKENS` |
| `packages/shared/src/budget.ts`                    | `calculateBudget()`, `estimateTokensForTier()`, `getEffectiveBalance()`, `generateBudgetErrors()`                                                                                                                                                   |
| `packages/shared/src/tiers.ts`                     | `getUserTier()`, `getDeductionSource()`, `canUseModel()`                                                                                                                                                                                            |
| `apps/api/src/services/billing/cost-calculator.ts` | `calculateMessageCost()` — 3 paths: OpenRouter exact, character estimate dev, character estimate fallback                                                                                                                                           |
| `apps/api/src/services/billing/can-send.ts`        | `canUserSendMessage()` — wraps `canUseModel()`                                                                                                                                                                                                      |
| `apps/api/src/services/billing/trial-usage.ts`     | `consumeTrialMessage()` — Redis dual-identity rate limiting                                                                                                                                                                                         |

### 4A — Tier System Adaptation

`getUserTier()` interface STAYS THE SAME: takes `{ balanceCents, freeAllowanceCents }`. Callers change how they compute values:

| Before                                          | After                                                         |
| ----------------------------------------------- | ------------------------------------------------------------- |
| `users.balance` → balanceCents                  | `SUM(wallets.balance) WHERE type='purchased'` → balanceCents  |
| `users.freeAllowanceCents` → freeAllowanceCents | `wallets.balance WHERE type='free_tier'` → freeAllowanceCents |

### 4B — Balance Service Changes (`apps/api/src/services/billing/balance.ts`)

**`getUserTierInfo()` — query changes only:**

- Before: `SELECT balance, freeAllowanceCents FROM users WHERE id = ?`
- After: `SELECT type, balance, createdAt FROM wallets WHERE userId = ?`
- Compute per-type sums, pass to `getUserTier()` unchanged
- Return type `UserTierInfo` unchanged

**Free tier lazy renewal (new logic):**

- No `freeAllowanceResetAt` column. No Redis state.
- On each `getUserTierInfo()` call, query: `SELECT MAX(createdAt) FROM ledgerEntries WHERE walletId = ? AND entryType = 'renewal'`
- If no renewal exists or last renewal is before today's UTC midnight: renew.
- Renewal (atomic): `UPDATE wallets SET balance = FREE_ALLOWANCE_CENTS WHERE userId = ? AND type = 'free_tier' AND balance < FREE_ALLOWANCE_CENTS` + INSERT ledgerEntries (entryType='renewal', sourceWalletId=walletId).
- The `WHERE balance < FREE_ALLOWANCE_CENTS` guard prevents double-top-up if two requests race.
- Idempotent, no Redis dependency, one extra query on the hot path (but only when renewal is needed — the MAX query is cheap with the (walletId, createdAt) index on ledgerEntries).

### 4C — Transaction Writer Changes (`apps/api/src/services/billing/transaction-writer.ts`)

**`creditUserBalance()` (payment deposits):**

- Before: `UPDATE users SET balance += amount` + `INSERT balance_transactions`
- After: `UPDATE wallets SET balance += amount WHERE userId = ? AND type = 'purchased'` + `INSERT ledger_entries (entryType='deposit', paymentId=..., walletId=...)`

**`processWebhookCredit()` (webhook deposits):** Same pattern change. Idempotency logic unchanged.

**NEW: `chargeForUsage()` — unified charging function:**

```typescript
export async function chargeForUsage(
  db: Database,
  params: {
    userId: string;
    cost: string; // numeric(20,8) string
    model: string;
    provider: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    sourceType: string; // 'message'
    sourceId: string; // message.id
  }
): Promise<ChargeResult>;
```

Atomic transaction:

1. INSERT `usage_records` (type='llm_completion', status='pending', cost)
2. INSERT `llm_completions` (model, provider, inputTokens, outputTokens, cachedTokens)
3. Query `wallets WHERE userId = ? ORDER BY priority`, find first with sufficient balance
4. `UPDATE wallets SET balance -= cost WHERE id = walletId`
5. INSERT `ledger_entries` (walletId, amount=-cost, balanceAfter, entryType='usage_charge', usageRecordId)
6. UPDATE `usage_records SET status='completed', completedAt=now()`
7. Return `{ usageRecordId, walletId, walletType, newBalance }`

### 4D — Speculative Balance Extension (`apps/api/src/lib/speculative-balance.ts`)

- KEEP existing: `reserveBudget(redis, userId, costCents)` / `releaseBudget()` / `getReservedTotal()`
- ADD: `reserveGroupBudget(redis, conversationId, memberId, costCents)` — reserves against per-member + conversation-wide caps
- ADD: `releaseGroupBudget(redis, conversationId, memberId, costCents)`
- New Redis keys: `chat:group-reserved:{conversationId}:{memberId}`, `chat:conversation-reserved:{conversationId}`

### 4E — Group Budget Payment Logic (New)

```
When member M sends in conversation C owned by O:
  0. Look up M's conversationMembers row.
  1. AI completes. Compute cost via calculateMessageCost() (UNCHANGED).
  2. If M == O:
       Debit O's wallets (priority order). payerId = O.
       Do NOT increment conversationSpending.totalSpent (owner's own usage doesn't count).
  3. Else:
       budget = conversations.perPersonBudget ?? memberBudgets[M].budget ?? 0
       spent = memberBudgets[M].spent ?? 0
       If budget > spent AND (conversationBudget IS NULL OR conversationSpending.totalSpent < conversationBudget):
         Debit O's wallets. payerId = O.
         Increment memberBudgets.spent AND conversationSpending.totalSpent.
         (totalSpent only tracks owner spending on behalf of OTHER members)
       Else if M is authenticated (not guest link):
         Debit M's wallets. payerId = M.
         Do NOT increment conversationSpending.totalSpent (M is paying for themselves).
       Else (guest link with exhausted budget):
         Reject.
  4. Create usageRecords + llmCompletions.
  5. Create ledgerEntries for wallet debited.
  6. Store payerId in message metadata.
  All in one database transaction (same transaction as AI message storage — see Phase 5B).
```

**Clarification on `conversationSpending.totalSpent`:** This counter only increments when the conversation owner is charged on behalf of a non-owner member. It does NOT increment when the owner sends their own messages or when a non-owner member pays from their own wallets. It answers the question "how much has the owner spent subsidizing other members?" and is checked against `conversations.conversationBudget`.

### 4F — Billing Hono Routes (`apps/api/src/routes/billing.ts`)

**Read routes (sessionRequired only — no phrase acknowledgment needed):**

- `GET /api/billing/balance` — sessionRequired → query wallets, compute tier info
- `GET /api/billing/transactions` — sessionRequired → query ledgerEntries JOIN wallets with cursor pagination
- `GET /api/billing/payment/:id/status` — sessionRequired → get payment status

**Purchase routes (sessionRequired + phraseRequired — financial action):**

- `POST /api/billing/payment` — sessionRequired + phraseRequired + helcimMiddleware → create payment
- `POST /api/billing/payment/:id/process` — sessionRequired + phraseRequired + helcimMiddleware → process payment

**Rationale:** Viewing your balance and transaction history is a read-only operation that should not be gated behind phrase acknowledgment. Only actions that spend or add money (creating/processing payments) require the phrase gate.

### Verification

```bash
cd packages/shared && pnpm typecheck && pnpm lint && pnpm test
cd apps/api && pnpm typecheck && pnpm lint && pnpm test
```

---

## Phase 5: Conversations & Epoch Management

**Goal:** Create conversations with epoch 1. Server-side message encryption. Remove finalize. Design doc Parts 4, 5.

### 5A — Conversation Creation (`POST /api/conversations`)

1. Client: `createFirstEpochForConversation([userAccountPublicKey])` → epochPublicKey, confirmationHash, memberWraps
2. Client encrypts title: `encryptMessageForStorage(epochPublicKey, "")` → ECIES blob for empty/placeholder title
3. Client sends: encryptedTitle, epochPublicKey, confirmationHash, memberWrap
4. Server creates in one transaction:
   - `conversations` row (currentEpoch=1, titleEpochNumber=1, nextSequence=1)
   - `epochs` row (epochNumber=1, epochPublicKey, confirmationHash, chainLink=null)
   - `epochMembers` row (wrap for owner)
   - `conversationMembers` row (privilege='owner', visibleFromEpoch=1)

### 5B — Message Send (`POST /api/chat` — SSE streaming)

1. Client sends: `{ conversationId, model, userMessage: { id, content (plaintext) }, messagesForInference, rotation? }`
2. Server validates: auth, write permission via conversationMembers, budget check
3. Server checks `rotationPending`:
   - If `true` and no `rotation` provided → return JSON error `{ rotationRequired: true, currentEpoch, pendingRemovalIds }`. Client fetches member keys, performs `performEpochRotation()`, re-sends with `rotation` field.
   - If `true` and `rotation` provided → proceed with rotation + message in unified flow.
   - If `false` and `rotation` provided → reject (stale client state).
4. Server determines epoch public key:
   - Normal path: fetches current epoch public key from DB.
   - Rotation path: uses the NEW epoch public key from `rotation.epochPublicKey` (decoded from base64).
5. Server encrypts user message: `encryptMessageForStorage(epochPublicKey, plaintext)` → userBlob
6. Server broadcasts ephemeral `message:new` to DO (user message preview — not yet persisted, clients show optimistically)
7. Server invokes AI with plaintext, streams tokens via SSE/DO
8. On AI completion — **single atomic transaction (all or nothing)**:
   a. **If rotation:** perform epoch rotation inside the same transaction (see 5E for details)
   b. Assign user message sequence: `UPDATE conversations SET nextSequence = nextSequence + 2 WHERE id = ? RETURNING nextSequence - 2 AS userSeq, nextSequence - 1 AS aiSeq`
   c. INSERT user message (senderType='user', senderId, epochNumber, sequenceNumber=userSeq, encryptedBlob=userBlob)
   d. Encrypt AI response: `encryptMessageForStorage(epochPublicKey, aiContent)` → aiBlob
   e. INSERT AI message (senderType='ai', epochNumber, sequenceNumber=aiSeq, encryptedBlob=aiBlob)
   f. `chargeForUsage()` — INSERT usageRecords + llmCompletions + UPDATE wallet + INSERT ledgerEntries
   g. Store payerId on AI message
   h. **All in ONE database transaction** — rotation (if any) + user message + AI message + billing commit together
9. Server broadcasts `message:complete` to DO (with both message IDs + encrypted blobs)
10. Server releases speculative budget reservation from Redis
11. **If AI fails or stream errors:** Nothing is persisted, no charge, no rotation applied, budget reservation released from Redis. No refund logic needed because we never charged. The `refund` entryType in ledgerEntries is for payment disputes/admin adjustments only, never for failed AI calls.

**NO finalize needed — single server-side encryption path.**

**Why all-in-one:** If user message stored separately and AI fails, you have orphaned user messages with no response and wasted sequence numbers. By committing everything atomically: either the full exchange (user message + AI response + billing) is persisted, or nothing is. Clients show the user message optimistically from the DO broadcast, then the committed data becomes authoritative.

### 5C — Conversation Titles

- Encrypted under epoch public key (ECIES blob)
- `titleEpochNumber` tracks which epoch key encrypts the title
- On epoch rotation: rotating client re-encrypts title under new epoch key, updates `titleEpochNumber`
- Conversation list page requires epoch key resolution per conversation

### 5D — Key Endpoints (Hono RPC routes under `/api/keys`)

| Route                                   | Method | Returns                                                                                     |
| --------------------------------------- | ------ | ------------------------------------------------------------------------------------------- |
| `/api/keys/:conversationId`             | GET    | Combined: epoch wraps + chain links for current user (single round-trip for full key chain) |
| `/api/keys/:conversationId/member-keys` | GET    | Public keys of all active members                                                           |

**Why combined wraps + chain links:** The client always needs both to build its epoch key chain — wraps to unwrap the current epoch key, then chain links to traverse backward for older epochs. Two separate requests would always be called together. The combined endpoint returns `{ wraps[], chainLinks[], currentEpoch }` in one round-trip.

**No standalone rotation endpoint.** Lazy epoch rotation is integrated into the `POST /api/chat` stream route (see 5E). The rotation always accompanies a message — making it a single atomic flow: rotation + message encryption + AI streaming + billing. A standalone `/api/keys/:conversationId/rotation` can be added later if explicit admin-triggered rotation (without a message) is needed.

### 5E — Epoch Rotation Protocol (Integrated into Stream Route)

Lazy rotation is embedded in the `POST /api/chat` stream route (see 5B). The rotation data arrives as an optional `rotation` field on the stream request — there is no standalone rotation endpoint. This guarantees rotation, message encryption, AI streaming, and billing are always a single atomic flow.

**Rotation request schema** (the `rotation` field on `streamChatRequestSchema`):

```typescript
rotation: z.object({
  expectedEpoch: z.number(), // current epoch the client is rotating FROM (concurrency guard)
  epochPublicKey: z.string(), // base64 — new epoch's public key
  confirmationHash: z.string(), // base64 — SHA-256(epochPrivateKey)
  chainLink: z.string(), // base64 — ECIES(newEpochPubKey, oldEpochPrivKey)
  memberWraps: z.array(
    z.object({
      // one per remaining active member
      memberPublicKey: z.string(), // base64
      wrap: z.string(), // base64 — ECIES(memberPubKey, newEpochPrivKey)
      privilege: z.string(),
      visibleFromEpoch: z.number(),
    })
  ),
  encryptedTitle: z.string(), // base64 — REQUIRED: title re-encrypted under new epoch key
}).optional();
```

**`encryptedTitle` is required** (not optional) within the rotation object. When rotating, the old epoch key is considered compromised for the removed member. The client already has the old epoch private key (needed for the chain link), so it decrypts the title and re-encrypts under the new epoch key. This is deterministic, not a branch.

**Rotation steps within the atomic transaction** (step 8a of 5B):

1. **First-write-wins concurrency guard:** `UPDATE conversations SET currentEpoch = expectedEpoch + 1, rotationPending = false WHERE id = ? AND currentEpoch = expectedEpoch`. Check rows affected — if 0, another client already rotated. Return `409 Conflict` with current epoch. Rejected client re-fetches keys + member list, re-encrypts, and re-submits.
2. INSERT new `epochs` row (epochNumber = expectedEpoch + 1, epochPublicKey, confirmationHash, chainLink)
3. INSERT new `epochMembers` rows — one per remaining member with their ECIES-wrapped epoch key
4. DELETE old epoch's `epochMembers` wraps (replaced by new wraps)
5. DELETE `pendingRemovals` rows for this conversation
6. SET `leftAt = NOW()` on removed `conversationMembers` rows
7. UPDATE conversation title: `title = encryptedTitle, titleEpochNumber = expectedEpoch + 1`
8. Messages (user + AI) are encrypted with the NEW epoch public key and stored with the new epoch number

**Client-side flow when `rotationRequired` is returned:**

1. Server returns JSON error: `{ rotationRequired: true, currentEpoch, pendingRemovalIds }`
2. Client fetches member keys via `GET /api/keys/:conversationId/member-keys`
3. Client performs `performEpochRotation(oldEpochPrivKey, remainingMemberPubKeys[])` — produces new epoch keypair, chain link, member wraps
4. Client decrypts current title, re-encrypts under new epoch key
5. Client re-sends the original message to `POST /api/chat` with the `rotation` field populated
6. Server processes rotation + message + AI + billing in one atomic transaction

### 5F — Files to DELETE

- Finalize endpoint from conversations routes
- All `pendingReEncryption` / `ephemeralPublicKey` / `iv` handling
- `apps/web/src/lib/encrypt-content.ts` + test
- `apps/web/src/stores/finalize-queue.ts` + tests

### Verification

```bash
cd apps/api && pnpm typecheck && pnpm lint && pnpm test
cd apps/web && pnpm typecheck && pnpm lint && pnpm test
```

---

## Phase 6: Durable Objects & Real-Time

**Goal:** WebSocket-based real-time messaging via per-conversation Durable Objects. Design doc Parts 10, 13.

### 6A — Create `packages/realtime/`

```
packages/realtime/
  package.json       (@cloudflare/workers-types devDep)
  tsconfig.json
  src/
    index.ts                    (barrel: ConversationRoom, event types)
    conversation-room.ts        (DO class)
    conversation-room.test.ts
    events.ts                   (typed event definitions)
    events.test.ts
```

### 6B — ConversationRoom DO

- Pure broadcast hub: NO crypto, NO DB, NO business logic
- Uses Durable Object Hibernation API (`state.acceptWebSocket`, `state.getWebSockets`)
- `Map<WebSocket, ConnectionMeta>` tracking connected members
- Routes:
  - `/websocket?userId=xxx` or `/websocket?guest=true&name=xxx` — WebSocket upgrade
  - `/broadcast` — POST from API Worker with event payload
- Dead socket cleanup via `webSocketClose(ws)` and `webSocketError(ws)` handlers
- On wake: re-hydrate Map from `state.getWebSockets()` via `ws.deserializeAttachment()`

### 6C — Events Broadcast

| Event               | Payload                              | Trigger                        |
| ------------------- | ------------------------------------ | ------------------------------ |
| `message:new`       | messageId, metadata                  | User message stored            |
| `message:stream`    | messageId, token (batched ~50ms)     | AI generating                  |
| `message:complete`  | messageId, encrypted blob + metadata | AI response stored             |
| `message:deleted`   | messageId                            | Hard-delete                    |
| `member:added`      | userId/linkId, privilege             | New member                     |
| `member:removed`    | userId/linkId                        | Member removed                 |
| `rotation:pending`  | conversationId                       | Tells next sender to rotate    |
| `rotation:complete` | conversationId, newEpochNumber       | Clients re-fetch keys          |
| `typing:start/stop` | userId                               | Ephemeral, client→DO→broadcast |
| `presence:update`   | members[]                            | Connection state change        |

### 6D — API Worker → DO Communication

```typescript
// apps/api/src/lib/broadcast.ts (NEW)
export async function broadcastToRoom(
  env: Bindings,
  conversationId: string,
  event: RealtimeEvent
): Promise<void> {
  const id = env.CONVERSATION_ROOM.idFromName(conversationId);
  const stub = env.CONVERSATION_ROOM.get(id);
  await stub.fetch(
    new Request('http://internal/broadcast', {
      method: 'POST',
      body: JSON.stringify(event),
    })
  );
}
```

### 6E — WebSocket Route (`apps/api/src/routes/ws.ts` — NEW)

Hono route. Two auth paths:

**Authenticated:** `GET /api/ws/:conversationId`

1. Validate session → verify user is active member
2. Forward to DO with `?userId=xxx`

**Link guests:** `GET /api/ws/:conversationId?linkToken=xxx`

1. Validate `linkToken` against Redis (short-lived, single-use)
2. Forward to DO with `?guest=true&name=xxx`

### 6F — Wrangler Config (`apps/api/wrangler.toml`)

```toml
[durable_objects]
bindings = [{ name = "CONVERSATION_ROOM", class_name = "ConversationRoom" }]
[[migrations]]
tag = "v1"
new_classes = ["ConversationRoom"]
```

Add to Bindings type in `types.ts`: `CONVERSATION_ROOM: DurableObjectNamespace;`

Worker entry point re-export: `export { ConversationRoom } from '@hushbox/realtime';`

### 6G — Frontend WebSocket Client (`apps/web/src/lib/ws-client.ts` — NEW)

- `ConversationWebSocket` class: per-conversation connection
- Auto-reconnect with exponential backoff (1s initial, 30s max)
- Typed event handlers matching DO event types

### 6H — Vite WebSocket Proxy (Local Dev)

```typescript
// apps/web/vite.config.ts
server: {
  proxy: {
    '/api/ws': { target: 'ws://localhost:8787', ws: true },
  }
}
```

### 6I — MODIFY (Not DELETE)

| File                                 | Change                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/lib/sse-client.ts`     | UPDATE event types: remove `ephemeralPublicKey`, add `messageId`, `sequenceNumber`, `cost`. Keep SSE parsing logic.           |
| `apps/api/src/lib/stream-handler.ts` | UPDATE event types: remove `ephemeralPublicKey` from `DoneEventData`, add committed message metadata. Keep SSE writing logic. |

**ADD:**

- `apps/web/src/lib/ws-client.ts` — NEW WebSocket client for group chat DO connections only

**Rationale:** SSE is still the streaming mechanism for `POST /api/chat` (authed + link guest) and `POST /api/trial` (anonymous). WebSocket + DO is only for broadcasting to OTHER members in group chats. The sending client always uses SSE.

### Verification

```bash
cd packages/realtime && pnpm typecheck && pnpm lint && pnpm test
cd apps/api && pnpm typecheck && pnpm lint && pnpm test
```

---

## Phase 7: Route Restructuring

**Goal:** Restructure all Hono route files to use chained syntax for type inference via `hc<AppType>()`. Handler logic stays identical — only the route definition pattern changes.

### 7A — Why This Phase Exists

Hono RPC infers client types from the chained `.get()/.post()` calls. The current codebase uses `OpenAPIHono` with `createRoute()`, which does not produce the chained type signature that `hc` needs. Each route file must be converted from `OpenAPIHono` + `createRoute` pattern to chained `Hono` + `zValidator` pattern.

### 7B — Migration Order

1. Health (trivial, proves the pattern)
2. Models (simple, no auth)
3. Conversations CRUD
4. Billing
5. Dev
6. Trial chat (rate limiting patterns)
7. Chat (SSE streaming — most complex)

### 7C — Pattern Per Route File

1. Replace `OpenAPIHono` with `Hono`
2. Replace `@hono/zod-openapi` with `@hono/zod-validator`
3. Convert from `app.openapi(route, handler)` to chained `new Hono<AppEnv>().get(...).post(...)`
4. Input: `zValidator('json', schema)` / `zValidator('param', schema)` / `zValidator('query', schema)`
5. Response: `c.json(data)` directly (type inferred)
6. Export the chained Hono instance

### 7D — App-Level Chaining

Main `app.ts` chains all `.route()` calls:

```
const app = new Hono<AppEnv>()
  .use('*', ...)
  .route('/api/auth', auth)
  .route('/api/conversations', conversations)
  .route('/api/members', members)
  .route('/api/keys', keys)
  .route('/api/messages', messages)
  .route('/api/links', links)
  .route('/api/budget', budget)
  .route('/api/billing', billing)
  .route('/api/account', account)
  .route('/api/projects', projects)
  .route('/api/link-guest', linkGuest)
  .post('/api/chat', sessionRequired, chatHandler)
  .post('/api/trial', rateLimited(...), trialHandler)
  .get('/api/ws/:conversationId', wsUpgradeHandler)
  .post('/api/webhooks/payments', webhookHandler)

export type AppType = typeof app
```

### 7E — Complete Route Structure

```
/api
  /auth — OPAQUE multi-step, Set-Cookie, rate limiting
    POST /register/init, /register/finish
    POST /login/init, /login/finish
    POST /verify-2fa, /logout
    GET  /me
    POST /recovery/*, /change-password/*
  /account
    GET, PATCH /profile
    POST /regenerate-recovery, /delete
  /conversations
    GET / (list), POST / (create)
    GET /:id, DELETE /:id
    PATCH /:id/settings, /:id/project
  /projects
    GET / (list), POST / (create)
    PATCH /:id, DELETE /:id
  /members
    GET /:conversationId (list)
    POST /:conversationId/add, /remove, /leave
    PATCH /:conversationId/privilege
  /links
    GET /:conversationId (list), POST /:conversationId (create)
    POST /:conversationId/revoke
  /keys
    GET /:conversationId (wraps + chain links combined)
    GET /:conversationId/member-keys
  /messages
    GET /:conversationId (history)
    POST /:conversationId/delete
    POST /share (create), GET /share/:shareId
  /budget
    GET /:conversationId, PATCH /:conversationId
  /billing
    GET /balance, /transactions
    POST /payment, /payment/:id/process
    GET /payment/:id/status
  /link-guest
    POST /access — validate link by linkPublicKey lookup, return epoch wraps + messages + wsToken
    POST /send — send via link with owner's budget
  POST /chat — authenticated + linkGuest SSE streaming
  POST /trial — anonymous SSE streaming, no persistence
  GET /ws/:conversationId — WebSocket upgrade to DO
  POST /webhooks/payments — Helcim callback
```

### 7F — Trial Chat (`POST /api/trial`)

Plain Hono route with SSE streaming + rate limiting middleware:

- Input: `{ messages, model }` — no auth, no persistence
- Rejects authenticated users
- Uses existing `consumeTrialMessage()` for dual-identity Redis rate limiting
- Streams AI response as SSE events
- No message storage, no billing

### 7G — Link Guest Access (Explicit `linkPublicKey` Lookup)

**`POST /api/link-guest/access`:**

Input: `{ conversationId, linkPublicKey (base64) }`

Server validation:

1. Query `sharedLinks WHERE conversationId = ? AND linkPublicKey = ? AND revokedAt IS NULL`
2. If no row found: return 404 (link not found or revoked)
3. Look up `conversationMembers` row via `linkId = sharedLinks.id`
4. Extract `visibleFromEpoch` from the conversationMembers row
5. Return: epoch member wraps for this linkPublicKey (from `epochMembers WHERE memberPublicKey = ?`), chain links (respecting visibleFromEpoch), encrypted messages (respecting visibleFromEpoch), wsToken (Redis, 5min TTL, single-use)

The lookup is **by `sharedLinks.linkPublicKey`**, not by link ID or any other identifier. The client derives the public key from the URL fragment secret via `HKDF(linkSecret, info="link-keypair-v1")` and sends the public half.

**`POST /api/link-guest/send`:**

Input: `{ conversationId, linkPublicKey (base64), content, model, displayName, messagesForInference }`

Server validation:

1. Query `sharedLinks WHERE conversationId = ? AND linkPublicKey = ? AND revokedAt IS NULL`
2. Verify link has `write` privilege
3. Look up conversationMembers row via linkId, verify budget
4. Proceed with message send flow (encrypt, AI, atomic transaction — charges owner)

### 7H — OpenAPI Removal

After all routes are converted, remove `@hono/zod-openapi` from `apps/api/package.json`.

### 7I — Routes Not in Typed Client

These routes are still Hono but not called via `hc<AppType>()`:

| Route                         | Reason                                       |
| ----------------------------- | -------------------------------------------- |
| `POST /api/webhooks/payments` | Called by Helcim, not by `apps/web`          |
| `GET /api/ws/:conversationId` | WebSocket upgrade, dedicated client class    |
| `POST /api/chat`              | SSE streaming, consumed by custom SSE parser |
| `POST /api/trial`             | SSE streaming, same reason                   |

### Verification

```bash
cd apps/api && pnpm typecheck && pnpm lint && pnpm test
cd apps/web && pnpm typecheck && pnpm lint
```

---

## Phase 8: Group Conversations

**Goal:** Multi-member conversations with privileges and lazy epoch rotation. Design doc Parts 4, 6.

### 8A — Member Management (Hono routes under `/api/members/:conversationId/*`)

**`add`:** Admin/owner client:

1. Fetches new member's publicKey from server
2. Decrypts current epoch private key
3. `wrapEpochKeyForNewMember(epochPrivKey, memberPubKey)` → wrap
4. Sends: member ID, wrap, privilege, visibleFromEpoch
5. Server creates `conversationMembers` + `epochMembers` in one transaction
6. NO rotation needed (adding doesn't require new epoch)

**`remove`:** Server:

1. Sets `rotationPending = true`
2. Inserts `pendingRemovals` row
3. Immediately sets `leftAt` on `conversationMembers` (server-side access revoked)
4. Broadcasts `member:removed` + `rotation:pending` via DO

**`leave`:** Same as remove but self-initiated.

**`updatePrivilege`:** Server-side column update only, no crypto changes.

### 8B — Privilege Levels (Server-Enforced)

| Level | Decrypt | Send | Add Members | Remove Members  | Manage Links | Rotate     |
| ----- | ------- | ---- | ----------- | --------------- | ------------ | ---------- |
| Read  | Yes     | No   | No          | No              | No           | No         |
| Write | Yes     | Yes  | No          | No              | No           | Yes (lazy) |
| Admin | Yes     | Yes  | Yes         | Yes (not owner) | Yes          | Yes        |
| Owner | Yes     | Yes  | Yes         | Yes             | Yes          | Yes        |

### 8C — Lazy Epoch Rotation

1. On trigger (remove/link revocation): server sets `rotationPending = true`, records `pendingRemovals`
2. On next message send by write-capable member:
   - Server detects `rotationPending` and no `rotation` field → returns `{ rotationRequired: true, currentEpoch, pendingRemovalIds }` (JSON error, not SSE)
   - Client fetches remaining member public keys via `GET /api/keys/:conversationId/member-keys`
   - Client: `performEpochRotation(oldEpochPrivKey, remainingMemberPubKeys[])` → new epoch keypair, chain link, member wraps
   - Client decrypts current title, re-encrypts under new epoch public key
   - Client re-sends message to `POST /api/chat` with `rotation` field populated
   - Server processes rotation + user message + AI response + billing in single atomic transaction (Phase 5E protocol)

### 8D — Owner Lifecycle

- Owner leaving → deletes entire conversation (CASCADE)
- Account deletion → leave all groups first (trigger lazy rotations), then delete owned conversations
- Financial records preserved (userId SET NULL on wallets, ledger_entries, usage_records, payments)

### 8E — History Visibility

Controlled by `visibleFromEpoch` on `conversationMembers`:

- Server refuses messages/chain links from before that epoch
- Server-enforced, not cryptographic (design doc rationale: no major protocol solves this cryptographically)
- New member with history: `visibleFromEpoch = 1` (chains backward to all)
- New member without history: `visibleFromEpoch = currentEpoch`

### Verification

```bash
cd apps/api && pnpm typecheck && pnpm lint && pnpm test
```

---

## Phase 9: Sharing System

**Goal:** Public link sharing and individual message sharing. Design doc Parts 7, 8.

### 9A — Public Link Sharing (Hono routes under `/api/links/:conversationId/*`)

**Create:**

1. Owner/admin: `createSharedLink(epochPrivKey)` → linkSecret, linkPublicKey, memberWrap
2. Send to server: linkPublicKey, memberWrap, privilege, visibleFromEpoch
3. Server creates **three rows in one transaction**:
   a. `sharedLinks` row — linkPublicKey, privilege, visibleFromEpoch, conversationId
   b. `epochMembers` row — wrap stored uniformly alongside account member wraps (epochId for current epoch, memberPublicKey=linkPublicKey, wrap=memberWrap)
   c. `conversationMembers` row — linkId set to the new sharedLinks.id, userId null, privilege, visibleFromEpoch
4. URL: `https://app.com/c/{conversationId}#{linkSecretBase64url}` (fragment never sent to server)

**Access (`POST /api/link-guest/access` — already defined in Phase 7G):**

1. Visitor extracts linkSecret from URL fragment
2. `deriveKeysFromLinkSecret(linkSecret)` → linkKeyPair
3. Sends conversationId + linkPublicKey to server
4. Server returns epoch wraps + chain links + messages
5. Client decrypts via link private key → epoch key → messages

**Revocation:** Sets `revokedAt` on sharedLinks, `leftAt` on conversationMembers, inserts `pendingRemovals`, sets `rotationPending`. Triggers lazy epoch rotation.

### 9B — Individual Message Sharing

- `POST /api/messages/share` — create a share
- `GET /api/messages/share/:shareId` — access a shared message

Flow:

1. Client decrypts target message → `createMessageShare(plaintext)` → shareSecret + shareBlob
2. Server stores shareBlob in `sharedMessages`, returns shareId
3. URL: `https://app.com/m/{shareId}#{shareSecretBase64url}`
4. Access: `decryptMessageShare(shareSecret, shareBlob)` → plaintext
5. Cryptographically isolated — random secret per share, unrelated to conversation keys

### Verification

```bash
cd apps/api && pnpm typecheck && pnpm lint && pnpm test
```

---

## Phase 10: Frontend Overhaul

**Goal:** Update all frontend code for epoch-based E2EE, Hono RPC typed client, React Query hooks, SSE for streaming, WebSocket for group broadcast.

### 10A — DELETE Entirely

| File                                                     | Reason                            |
| -------------------------------------------------------- | --------------------------------- |
| `apps/web/src/stores/finalize-queue.ts` + tests          | No finalize with epoch encryption |
| `apps/web/src/stores/finalize-queue.compression.test.ts` | Same                              |
| `apps/web/src/lib/encrypt-content.ts` + test             | Server encrypts now               |

**NOT deleted:** `apps/web/src/lib/sse-client.ts` — KEPT and updated (SSE used for chat streaming)

### 10B — Message Decryption Rewrite

Uses Hono RPC client:

1. Fetch key chain: `client.api.keys[':conversationId'].$get(...)` wrapped in `useQuery` — returns wraps + chain links in one round-trip
2. `unwrapEpochKey(accountPrivKey, wrap)` — cache in singleton Map
3. Chain link traversal to derive older epoch keys from current
4. `decryptMessage(epochPrivKey, blob)` for each message
5. Epoch key cache: `apps/web/src/lib/epoch-key-cache.ts` singleton, cleared on logout

### 10C — Chat Hooks Rewrite

- `use-authenticated-chat.ts`: Send plaintext via `client.api.chat.$post(...)`. Parse SSE stream from the Response. No finalize.
- `use-chat-stream.ts`: Update SSE event handling for new format. Keep SSE parsing.
- NEW `use-conversation-ws.ts`: React hook wrapping `ConversationWebSocket` for group broadcast

### 10D — New Hooks

| Hook                          | Purpose                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `use-epoch-keys.ts`           | Fetches + caches epoch key wraps via Hono RPC + React Query |
| `use-conversation-ws.ts`      | React hook for group chat WebSocket broadcast               |
| `use-message-replay-guard.ts` | Tracks received messageId in Set, rejects duplicates        |

### 10E — Replace Manual Fetch Hooks with Hono RPC + React Query

| Current                            | Replacement                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `useConversations()` manual fetch  | `useQuery({ queryKey: ['conversations'], queryFn: () => client.api.conversations.$get().then(r => r.json()) })`                            |
| `useConversation(id)` manual fetch | `useQuery({ queryKey: ['conversation', id], queryFn: () => client.api.conversations[':id'].$get({ param: { id } }).then(r => r.json()) })` |
| `useBalance()` manual fetch        | `useQuery({ queryKey: ['balance'], queryFn: () => client.api.billing.balance.$get().then(r => r.json()) })`                                |
| manual `fetch` for mutations       | `useMutation({ mutationFn: ... })`                                                                                                         |

The `QueryClientProvider` from `@tanstack/react-query` is the only data layer provider.

### 10F-10G — Shared Schemas + New UI Components

**10F — Shared Schemas Update (`packages/shared/`):**

- REMOVE: finalize-related schemas
- UPDATE: message response schema (encryptedBlob, epochNumber, senderType, senderId, senderDisplayName, payerId, sequenceNumber)
- UPDATE: chat request schema (content is plaintext string, not encrypted)
- UPDATE: conversation response schema (epoch/budget fields)
- ADD: schemas for epochs, members, links, budgets, key operations

**10G — New UI Components:**

| Component                | Purpose                                       |
| ------------------------ | --------------------------------------------- |
| Group chat header        | Member avatars, count, add member button      |
| Member list panel        | Privileges, online status, remove button      |
| Add member modal         | Search users, set privilege, visibleFromEpoch |
| Budget settings modal    | Per-conversation + per-person budget          |
| Share conversation modal | Generate link, set privilege/visibility       |
| Share message modal      | Generate isolated share URL                   |
| Shared conversation view | Public route, key from URL fragment           |
| Shared message view      | Public route, single message display          |
| Settings page updates    | Recovery phrase regen, password change, 2FA   |
| Encryption badge         | Visual E2EE status indicator                  |

### Verification

```bash
cd apps/web && pnpm typecheck && pnpm lint && pnpm test
```

---

## Phase 11: Cleanup & Final Verification

### 11A — Delete from `apps/api`

- `@noble/ciphers` and `@noble/hashes` from package.json (moved to crypto package)
- `@hono/zod-openapi` from package.json (replaced by `@hono/zod-validator`)
- Old route files using `OpenAPIHono` + `createRoute` pattern
- Unused middleware from old flows
- **DO NOT delete `stream-handler.ts`** — still used for SSE streaming
- **DO NOT delete `sse-client.ts`** — still used for SSE parsing

### 11B — Delete from DB schema

- Verify no remnant files for dropped tables
- Remove superseded migration comments

### 11C — Delete from frontend

- Dead code from old DEK encryption flow
- Unused imports and types
- Old `lib/chat-messages.ts` if fully replaced

### 11D — Full Verification

```bash
pnpm typecheck     # No TypeScript errors
pnpm lint          # No ESLint errors
pnpm test          # All tests pass
pnpm test:coverage # Coverage targets met
pnpm dev           # Local dev starts
```

### 11E — E2E Flow Verification

1. Signup → create conversation → send message → verify encrypted storage → decrypt → display
2. Group conversation → add member → both see messages → remove member → lazy rotation → forward secrecy
3. Shared link → access without account → read messages
4. Guest messaging via write-enabled link → owner budget charged
5. Individual message share → access via share URL
6. Payment → wallet credit → send message → usage record + ledger entry
7. Password change → re-wrap account key → existing sessions work
8. Recovery phrase → recover account → decrypt all conversations
9. 2FA enable/disable → login with 2FA → verify TOTP
10. Anonymous trial chat → rate limited → no persistence

---

## Critical File Reference

### Crypto Package (Phase 0)

- `packages/crypto/src/` — ecies, account, epoch, message-encrypt, member, link, message-share, symmetric, key-derivation, sharing, hash, errors, compression, message-codec, constant-time, serialization, opaque-client

### Database (Phase 1)

- `packages/db/src/schema/` — users, conversations, messages, projects, payments (MODIFY) + 12 new tables (CREATE)
- `packages/db/src/schema/bytea.ts` — KEEP (custom Uint8Array↔hex type)
- `packages/db/src/factories/` — update existing + create new
- `packages/db/src/zod/` — update all schemas

### API (Phases 2–9)

- `apps/api/src/app.ts` — chained Hono routes + `export type AppType` + DO binding + WebSocket route
- `apps/api/src/types.ts` — add CONVERSATION_ROOM to Bindings
- `apps/api/src/routes/*.ts` — all routes restructured with chained syntax + `zValidator`
- `apps/api/src/routes/opaque-auth.ts` — auth flow changes
- `apps/api/src/routes/ws.ts` — NEW (WebSocket upgrade)
- `apps/api/src/services/chat/message-persistence.ts` — epoch encryption
- `apps/api/src/services/billing/balance.ts` — wallet queries
- `apps/api/src/services/billing/transaction-writer.ts` — chargeForUsage
- `apps/api/src/lib/totp.ts` — crypto package import
- `apps/api/src/lib/broadcast.ts` — NEW (API→DO)
- `apps/api/src/lib/speculative-balance.ts` — group budget reservation
- `apps/web/src/lib/api-client.ts` — NEW Hono RPC client (`hc<AppType>()`)

### Preserved Billing Logic (UNCHANGED algorithms)

- `packages/shared/src/pricing.ts`
- `packages/shared/src/constants.ts`
- `packages/shared/src/budget.ts`
- `packages/shared/src/tiers.ts`
- `apps/api/src/services/billing/cost-calculator.ts`
- `apps/api/src/services/billing/can-send.ts`
- `apps/api/src/services/billing/trial-usage.ts`

### Real-time (Phase 6)

- `packages/realtime/src/conversation-room.ts` — NEW DO class
- `packages/realtime/src/events.ts` — NEW typed events

### Frontend (Phase 10)

- `apps/web/src/lib/auth.ts` — remove DEK
- `apps/web/src/lib/auth-client.ts` — new key hierarchy
- `apps/web/src/lib/api-client.ts` — NEW Hono RPC client
- `apps/web/src/lib/ws-client.ts` — NEW WebSocket client
- `apps/web/src/lib/sse-client.ts` — KEPT (updated event types)
- `apps/web/src/hooks/use-decrypted-messages.ts` — epoch rewrite
- `apps/web/src/hooks/use-authenticated-chat.ts` — send plaintext, no finalize
- `apps/web/src/hooks/use-chat-stream.ts` — SSE event handling updated

---

## Cascade Map (from Design Doc Part 14)

```
users (DELETE)
├── conversations (owned)               ON DELETE CASCADE
│   ├── messages                         ON DELETE CASCADE
│   │   └── sharedMessages               ON DELETE CASCADE
│   ├── epochs                           ON DELETE CASCADE
│   │   └── epochMembers                 ON DELETE CASCADE
│   ├── sharedLinks                      ON DELETE CASCADE
│   ├── conversationMembers              ON DELETE CASCADE
│   │   ├── memberBudgets                ON DELETE CASCADE
│   │   └── pendingRemovals (memberId)   ON DELETE CASCADE
│   ├── pendingRemovals (conversationId) ON DELETE CASCADE
│   └── conversationSpending             ON DELETE CASCADE
├── projects                             ON DELETE CASCADE
├── conversationMembers (as member)      ON DELETE SET NULL (userId nulled)
└── pendingRemovals (requestedBy)        ON DELETE SET NULL

Financial records (PRESERVED on user deletion):
├── wallets.userId                       ON DELETE SET NULL
│   └── ledger_entries.walletId          ON DELETE CASCADE
├── usage_records.userId                 ON DELETE SET NULL
│   └── llmCompletions.usageRecordId     ON DELETE CASCADE
└── payments.userId                      ON DELETE SET NULL
```
