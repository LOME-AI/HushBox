# Execution Plan: Full E2EE Architecture Transition

## Context

Complete transition of LOME-CHAT from current DEK-based encryption + REST API to the new epoch-based E2EE architecture with tRPC, Durable Objects, group conversations, shared links, budget system, and wallet-based billing. No existing users — clean slate. The authoritative specification is the design document provided by the user (Parts 1–17).

This change is needed because the current architecture uses a Data Encryption Key (DEK) model that doesn't support group conversations, public link sharing, or server-side encryption of AI responses. The new epoch-based ECIES system enables all of these while maintaining the guarantee that the server can encrypt but never decrypt message content.

---

## Decision Log

| # | Decision | Chosen | Rationale |
|---|----------|--------|-----------|
| 1 | Guest systems | Keep both: `trial` (anonymous) + `linkGuest` (shared link) | Anonymous trial for marketing, link-based for conversations |
| 2 | Migration strategy | Single clean migration (delete 0008–0012) | No users, clean slate |
| 3 | Crypto package | Audit & fix to match design doc | Info strings, compression, version alignment needed |
| 4 | PostgreSQL version | PG18 ready, use native `uuidv7()` | Design doc requires it |
| 5 | HKDF info strings | Match design doc exactly | `"shared-link-v1"` → `"link-keypair-v1"`, `"message-share-v1"` → `"share-msg-v1"` |
| 6 | Compression | Switch gzip → raw deflate | Saves ~18B/msg, matches design doc |
| 7 | Drizzle enums | All text columns | More flexible, no migration needed for new values |
| 8 | Guest naming | `trial` / `linkGuest` | Clear code separation |
| 9 | Link expiry | No expiry (removed requirement 24) | Links valid until explicitly revoked |
| 10 | Auth in tRPC | OPAQUE stays as Hono routes | Set-Cookie, multi-step protocol, complex rate limiting |
| 11 | Naming convention | camelCase throughout plan | Matches TypeScript/Drizzle. Actual SQL migration uses snake_case; Drizzle auto-maps. |

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

---

## Phase Dependency Graph

```
Phase 0 (Crypto Fixes) ──→ Phase 1 (DB Schema)
                                    │
Phase 2 (tRPC Infra) ──┬──→ Phase 3 (Auth) ──→ Phase 4 (Billing) ──→ Phase 5 (Conversations)
                        │                                                       │
                        │                                                       ├──→ Phase 8 (Groups) ──→ Phase 9 (Sharing)
                        │                                                       │
                        └──→ Phase 6 (DO/Real-time) ────────────────────────────┘
                        │
                        └──→ Phase 7 (Route Migration)

All ──→ Phase 10 (Frontend) ──→ Phase 11 (Cleanup)
```

Phases 1 and 2 can proceed in parallel. Phase 3 depends on 1. Phase 4 depends on 1+3. Phase 5 depends on 1+2+3+4. Phase 6 depends on 2. Phases 7, 8, 9 depend on 5+6. Phase 10 depends on all prior. Phase 11 is cleanup.

---

## Phase 0: Crypto Package Fixes

**Goal:** Fix `@noble/*` version mismatch, update HKDF info strings, switch compression to raw deflate, clean up exports.

### 0A — Version Alignment

| Package | Current | Target | Action |
|---------|---------|--------|--------|
| `packages/crypto` → `@noble/ciphers` | `^1.2.1` | `^2.1.1` | Update + fix import paths |
| `packages/crypto` → `@noble/hashes` | `^1.7.1` | `^2.0.1` | Update + fix import paths |
| `apps/api` → `@noble/ciphers` | `^2.1.1` | REMOVE | All crypto via `@lome-chat/crypto` |
| `apps/api` → `@noble/hashes` | `^2.0.1` | REMOVE | All crypto via `@lome-chat/crypto` |

The v2 APIs changed import paths (e.g., `@noble/ciphers/aead` → `@noble/ciphers`). Update all imports in `packages/crypto/src/`.

### 0B — HKDF Info String Fixes

| File | Current | New |
|------|---------|-----|
| `packages/crypto/src/link.ts` | `"shared-link-v1"` | `"link-keypair-v1"` |
| `packages/crypto/src/message-share.ts` | `"message-share-v1"` | `"share-msg-v1"` |

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
- DROP: role, iv, model, balanceTransactionId, cost, sharingKeyWrapped, contentType, pendingReEncryption, ephemeralPublicKey
- RENAME: content → `encryptedBlob`
- ADD: `senderType` (text NOT NULL), `senderId` (text nullable), `senderDisplayName` (text nullable), `payerId` (text nullable), `epochNumber` (int NOT NULL), `sequenceNumber` (int NOT NULL)
- CHECK: `senderType IN ('user', 'ai')`
- DROP OLD INDEX on conversationId
- ADD INDEX: (conversationId, sequenceNumber)
- Change `id` default to `uuidv7()`

**Step 5 — ALTER `projects`:**
- DROP: name, description
- ADD: `encryptedName` (bytea NOT NULL), `encryptedDescription` (bytea nullable)
- Change `id` default to `uuidv7()`

**Step 6 — ALTER `payments`:**
- Make userId nullable
- Change FK from ON DELETE CASCADE to ON DELETE SET NULL
- Change status from enum to text
- CHECK: `status IN ('pending', 'completed', 'failed', 'refunded')` (design doc values; `awaiting_webhook` state is inferrable from `helcimTransactionId IS NOT NULL AND status = 'pending'`)
- Change `id` default to `uuidv7()`

**Step 7 — CREATE new tables** (in FK dependency order):

| Table | Key Columns | Notes |
|-------|-------------|-------|
| `wallets` | id, userId FK→users SET NULL, type (text), balance (numeric 20,8 default 0), priority (int), createdAt | Index on userId |
| `usage_records` | id, userId FK→users SET NULL, type (text), status (text default 'pending'), cost (numeric 20,8), sourceType, sourceId, createdAt, completedAt | CHECK: `status IN ('pending', 'completed', 'failed')`. Indexes: (userId, type, createdAt), (sourceType, sourceId) |
| `ledger_entries` | id, walletId FK CASCADE, amount, balanceAfter, entryType (text), paymentId FK SET NULL, usageRecordId FK SET NULL, sourceWalletId FK SET NULL, createdAt | CHECK: `entryType IN ('deposit', 'usage_charge', 'refund', 'adjustment', 'renewal', 'welcome_credit')`. CHECK: exactly one of (paymentId, usageRecordId, sourceWalletId) IS NOT NULL. Indexes: (walletId, createdAt), (usageRecordId) WHERE usageRecordId IS NOT NULL |
| `llm_completions` | id, usageRecordId FK CASCADE UNIQUE, model, provider, inputTokens, outputTokens, cachedTokens (default 0) | Index on model |
| `shared_links` | id, conversationId FK CASCADE, linkPublicKey (bytea), privilege (text default 'read'), visibleFromEpoch (int), revokedAt, createdAt | CHECK: `privilege IN ('read', 'write')`. Index: (conversationId) WHERE revokedAt IS NULL |
| `conversation_members` | id, conversationId FK CASCADE, userId FK SET NULL, linkId FK→sharedLinks SET NULL, privilege (text default 'write'), visibleFromEpoch (int), joinedAt, leftAt | CHECK: `privilege IN ('read', 'write', 'admin', 'owner')`. CHECK: `(userId IS NOT NULL) OR (linkId IS NOT NULL)`. UNIQUE: (conversationId, userId) WHERE leftAt IS NULL. UNIQUE: (conversationId, linkId) WHERE leftAt IS NULL. Indexes: (conversationId) WHERE leftAt IS NULL, (userId) WHERE leftAt IS NULL |
| `epochs` | id, conversationId FK CASCADE, epochNumber, epochPublicKey (bytea), confirmationHash (bytea), chainLink (bytea nullable), createdAt | UNIQUE (conversationId, epochNumber) |
| `epoch_members` | id, epochId FK CASCADE, memberPublicKey (bytea), wrap (bytea), privilege (text), visibleFromEpoch (int), createdAt | CHECK: `privilege IN ('read', 'write', 'admin', 'owner')`. UNIQUE (epochId, memberPublicKey). Index on memberPublicKey |
| `pending_removals` | id, conversationId FK CASCADE, memberId FK→conversationMembers CASCADE, requestedBy FK→users SET NULL, createdAt | Index on conversationId |
| `shared_messages` | id, messageId FK→messages CASCADE, shareBlob (bytea), createdAt | |
| `member_budgets` | id, memberId FK→conversationMembers CASCADE UNIQUE, budget (numeric 20,8), spent (numeric 20,8 default 0), createdAt | |
| `conversation_spending` | id, conversationId FK CASCADE UNIQUE, totalSpent (numeric 20,8 default 0), updatedAt | `totalSpent` only increments when the owner is charged on behalf of a non-owner member — not when the owner sends their own messages |

All new table IDs use `DEFAULT uuidv7()`.

**Step 8 — All CHECK constraints summary** (explicit SQL for every CHECK in the migration):

```sql
-- messages
CHECK (sender_type IN ('user', 'ai'))

-- payments (altered in Step 6)
CHECK (status IN ('pending', 'completed', 'failed', 'refunded'))

-- usage_records
CHECK (status IN ('pending', 'completed', 'failed'))

-- ledger_entries (exactly one FK non-null)
CHECK (
  (payment_id IS NOT NULL)::int +
  (usage_record_id IS NOT NULL)::int +
  (source_wallet_id IS NOT NULL)::int = 1
)
CHECK (entry_type IN ('deposit', 'usage_charge', 'refund', 'adjustment', 'renewal', 'welcome_credit'))

-- shared_links
CHECK (privilege IN ('read', 'write'))

-- conversation_members
CHECK ((user_id IS NOT NULL) OR (link_id IS NOT NULL))
CHECK (privilege IN ('read', 'write', 'admin', 'owner'))

-- epoch_members
CHECK (privilege IN ('read', 'write', 'admin', 'owner'))
```

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
- `messages.ts` — drop role/iv/model/balanceTransactionId/cost/sharingKeyWrapped/contentType/pendingReEncryption/ephemeralPublicKey, rename content→encryptedBlob, add senderType/senderId/senderDisplayName/payerId/epochNumber/sequenceNumber
- `projects.ts` — replace name→encryptedName (bytea NOT NULL), description→encryptedDescription (bytea nullable)
- `payments.ts` — make userId nullable, FK ON DELETE SET NULL, status as text (not enum)
- `index.ts` — update barrel exports

### 1D — Factories

**MODIFY:**
- `user.ts` — remove DEK/balance fields, add passwordWrappedPrivateKey, recoveryWrappedPrivateKey (use crypto `createAccount()` for realistic test data)
- `conversation.ts` — remove isPublic/publicShareId, add currentEpoch/titleEpochNumber/nextSequence/rotationPending/budget fields
- `message.ts` — remove role/iv/model/cost/etc, rename content→encryptedBlob, add senderType/senderId/payerId/epochNumber/sequenceNumber
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

## Phase 2: tRPC Infrastructure

**Goal:** Set up tRPC alongside existing Hono routes. Both coexist during migration.

### 2A — Install Dependencies

| Package | Where | Purpose |
|---------|-------|---------|
| `@trpc/server` | `apps/api` | Server routers + fetch adapter |
| `@trpc/client` | `apps/web` | Typed vanilla client |
| `@trpc/react-query` | `apps/web` | React hooks wrapping TanStack Query |

`@tanstack/react-query` is already in `apps/web`.

### 2B — Create `apps/api/src/trpc/`

| File | Purpose |
|------|---------|
| `context.ts` | `createTRPCContext(c: HonoContext<AppEnv>)` → extracts db, redis, user, session, envUtils, env, executionCtx from Hono context. Exports `TRPCContext` type |
| `trpc.ts` | `initTRPC.context<TRPCContext>().create()`. Exports: `router`, `middleware`, `publicProcedure`, `protectedProcedure`, `phraseRequiredProcedure`, `chatProcedure`, `billingProcedure`, `rateLimited(key, config)` middleware factory |
| `routers/index.ts` | Root `appRouter` combining sub-routers. Export `type AppRouter` |
| `test-utils.ts` | `createCallerFactory(appRouter)` for unit tests + `createTestContext()` factory |
| `index.ts` | Barrel: `appRouter`, `AppRouter`, `createTRPCContext` |

### 2C — TRPCContext Type

```typescript
interface TRPCContext {
    db: Database;
    redis: Redis;
    envUtils: EnvUtilities;
    env: Bindings;
    executionCtx: ExecutionContext;
    user: AppEnv['Variables']['user'];  // nullable
    session: SessionData | null;
    openrouter?: OpenRouterClient;      // lazy via chatProcedure middleware
    helcim?: HelcimClient;              // lazy via billingProcedure middleware
    honoContext?: Context<AppEnv>;      // for Set-Cookie (auth-adjacent only)
}
```

### 2D — Procedure Hierarchy

```
publicProcedure           — no auth required
  └─ protectedProcedure   — requires authenticated user (throws UNAUTHORIZED)
       └─ phraseRequiredProcedure — requires hasAcknowledgedPhrase
            └─ billingProcedure   — lazy Helcim client init
       └─ chatProcedure          — lazy OpenRouter client init
```

`rateLimited(key, config)` is a standalone middleware factory that wraps any procedure:
```typescript
export function rateLimited(key: string, config: { windowMs: number; max: number }) {
  return middleware(async ({ ctx, next }) => {
    const ip = getClientIP(ctx.honoContext);
    const result = await checkRateLimit(ctx.redis, key, ip, config);
    if (!result.allowed) throw new TRPCError({ code: 'TOO_MANY_REQUESTS' });
    return next();
  });
}
```

### 2E — Mount on Hono (`apps/api/src/app.ts`)

```
/trpc/* middleware chain:
  csrfProtection → dbMiddleware → redisMiddleware → ironSessionMiddleware
  → sessionMiddleware (non-rejecting, loads user if session exists)
  → fetchRequestHandler(@trpc/server/adapters/fetch)
```

Key: `sessionMiddleware` loads user from session if available but does NOT reject unauthenticated requests. `protectedProcedure` handles auth gating within tRPC. Use `fetchRequestHandler` with `c.req.raw`.

### 2F — Client Setup (`apps/web/src/lib/trpc.ts`)

- `createTRPCReact<AppRouter>()`
- `httpBatchLink` with `credentials: 'include'` and `url: ${getApiUrl()}/trpc`
- Provider: `TRPCProvider` wrapping existing `QueryClientProvider` (shared `queryClient` instance)

### 2G — What Stays as Plain Hono (Forever)

| Route | Reason |
|-------|--------|
| `/api/auth/*` | OPAQUE multi-step protocol + Set-Cookie + complex rate limiting |
| `/api/webhooks/*` | External payment callbacks (Helcim), signature verification |
| `/api/ws/:conversationId` | WebSocket upgrade to Durable Object |

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
{ email, username, registrationRecord, accountPublicKey, passwordWrappedPrivateKey, recoveryWrappedPrivateKey }
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
{ success, userId, email, passwordWrappedPrivateKey }
```

Client: `unwrapAccountKeyWithPassword(opaqueExportKey, blob)` → account private key in memory.

### 3C — `/me` Response (Stays as Hono `GET /api/auth/me`)

Stays in Hono because it's called during session restoration before tRPC client init.

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

- Import `symmetricEncrypt`/`symmetricDecrypt` from `@lome-chat/crypto`
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

| File | Functions to Preserve Exactly |
|------|-------------------------------|
| `packages/shared/src/pricing.ts` | `estimateMessageCostDevelopment()`, `calculateMessageCostFromOpenRouter()`, `applyFees()`, `calculateTokenCostWithFees()`, `getModelCostPer1k()`, `isExpensiveModel()`, `estimateTokenCount()` |
| `packages/shared/src/constants.ts` | All fee rates (5%+4.5%+5.5%=15%), `STORAGE_COST_PER_CHARACTER`, `STORAGE_COST_PER_1K_CHARS`, `EXPENSIVE_MODEL_THRESHOLD_PER_1K`, `CHARS_PER_TOKEN_*`, `MAX_ALLOWED_NEGATIVE_BALANCE_CENTS`, `MAX_GUEST_MESSAGE_COST_CENTS`, `MINIMUM_OUTPUT_TOKENS` |
| `packages/shared/src/budget.ts` | `calculateBudget()`, `estimateTokensForTier()`, `getEffectiveBalance()`, `generateBudgetErrors()` |
| `packages/shared/src/tiers.ts` | `getUserTier()`, `getDeductionSource()`, `canUseModel()` |
| `apps/api/src/services/billing/cost-calculator.ts` | `calculateMessageCost()` — 3 paths: OpenRouter exact, character estimate dev, character estimate fallback |
| `apps/api/src/services/billing/can-send.ts` | `canUserSendMessage()` — wraps `canUseModel()` |
| `apps/api/src/services/billing/guest-usage.ts` | `consumeGuestMessage()` — Redis dual-identity rate limiting |

### 4A — Tier System Adaptation

`getUserTier()` interface STAYS THE SAME: takes `{ balanceCents, freeAllowanceCents }`. Callers change how they compute values:

| Before | After |
|--------|-------|
| `users.balance` → balanceCents | `SUM(wallets.balance) WHERE type='purchased'` → balanceCents |
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
export async function chargeForUsage(db: Database, params: {
  userId: string;
  cost: string;          // numeric(20,8) string
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  sourceType: string;    // 'message'
  sourceId: string;      // message.id
}): Promise<ChargeResult>
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

### 4F — Billing tRPC Router (`apps/api/src/trpc/routers/billing.ts`)

- `getBalance`: phraseRequiredProcedure → query wallets, compute tier info
- `listTransactions`: phraseRequiredProcedure → query ledger_entries JOIN wallets with cursor pagination
- `createPayment`, `processPayment`, `getPaymentStatus`: billingProcedure (lazy Helcim) → reuse existing Helcim logic

### Verification

```bash
cd packages/shared && pnpm typecheck && pnpm lint && pnpm test
cd apps/api && pnpm typecheck && pnpm lint && pnpm test
```

---

## Phase 5: Conversations & Epoch Management

**Goal:** Create conversations with epoch 1. Server-side message encryption. Remove finalize. Design doc Parts 4, 5.

### 5A — Conversation Creation (tRPC `conversations.create`)

1. Client: `createFirstEpochForConversation([userAccountPublicKey])` → epochPublicKey, confirmationHash, memberWraps
2. Client encrypts title: `encryptMessageForStorage(epochPublicKey, "")` → ECIES blob for empty/placeholder title
3. Client sends: encryptedTitle, epochPublicKey, confirmationHash, memberWrap
4. Server creates in one transaction:
    - `conversations` row (currentEpoch=1, titleEpochNumber=1, nextSequence=1)
    - `epochs` row (epochNumber=1, epochPublicKey, confirmationHash, chainLink=null)
    - `epochMembers` row (wrap for owner)
    - `conversationMembers` row (privilege='owner', visibleFromEpoch=1)

### 5B — Message Send (tRPC `messages.send`)

1. Client sends: `{ conversationId, model, content (plaintext), messagesForInference }`
2. Server validates: auth, write permission via conversationMembers, budget check
3. Server checks `rotationPending`. If true → return `{ rotationRequired: true, currentEpoch, pendingRemovalIds }`. Client performs rotation, resubmits via `keys.submitRotation`.
4. Server fetches current epoch public key
5. Server encrypts user message: `encryptMessageForStorage(epochPublicKey, plaintext)` → userBlob
6. Server broadcasts ephemeral `message:new` to DO (user message preview — not yet persisted, clients show optimistically)
7. Server invokes AI with plaintext, streams tokens via SSE/DO
8. On AI completion — **single atomic transaction (all or nothing)**:
   a. Assign user message sequence: `UPDATE conversations SET nextSequence = nextSequence + 2 WHERE id = ? RETURNING nextSequence - 2 AS userSeq, nextSequence - 1 AS aiSeq`
   b. INSERT user message (senderType='user', senderId, epochNumber, sequenceNumber=userSeq, encryptedBlob=userBlob)
   c. Encrypt AI response: `encryptMessageForStorage(epochPublicKey, aiContent)` → aiBlob
   d. INSERT AI message (senderType='ai', epochNumber, sequenceNumber=aiSeq, encryptedBlob=aiBlob)
   e. `chargeForUsage()` — INSERT usageRecords + llmCompletions + UPDATE wallet + INSERT ledgerEntries
   f. Store payerId on AI message
   g. **All in ONE database transaction** — user message, AI message, and billing commit together
9. Server broadcasts `message:complete` to DO (with both message IDs + encrypted blobs)
10. Server releases speculative budget reservation from Redis
11. If AI fails: **nothing persisted**, no charge, budget released. Client discards the optimistic user message preview.

**NO finalize needed — single server-side encryption path.**

**Why all-in-one:** If user message stored separately and AI fails, you have orphaned user messages with no response and wasted sequence numbers. By committing everything atomically: either the full exchange (user message + AI response + billing) is persisted, or nothing is. Clients show the user message optimistically from the DO broadcast, then the committed data becomes authoritative.

### 5C — Conversation Titles

- Encrypted under epoch public key (ECIES blob)
- `titleEpochNumber` tracks which epoch key encrypts the title
- On epoch rotation: rotating client re-encrypts title under new epoch key, updates `titleEpochNumber`
- Conversation list page requires epoch key resolution per conversation

### 5D — Key Endpoints (tRPC `keys.*`)

| Procedure | Type | Input | Returns |
|-----------|------|-------|---------|
| `getEpochWraps` | query | `{ conversationId }` | All epoch member wraps for current user's publicKey |
| `getChainLinks` | query | `{ conversationId }` | Chain links for backward traversal |
| `submitRotation` | mutation | `{ conversationId, newEpochPublicKey, confirmationHash, memberWraps[], chainLink, removedMemberIds[], encryptedTitle?, message? }` | Atomic rotation + optional message |
| `getMemberPublicKeys` | query | `{ conversationId }` | Public keys of all active members |

### 5E — Epoch Rotation Protocol (Atomic Server Transaction)

When `submitRotation` is called:
1. Create new `epochs` row (epochNumber = currentEpoch + 1)
2. Store all member wraps in `epochMembers`
3. Store chain link on new epoch row
4. DELETE old epoch's `epochMembers` wraps
5. DELETE `pendingRemovals` rows
6. Set `leftAt = NOW()` on removed `conversationMembers` rows
7. UPDATE `conversations.currentEpoch += 1, rotationPending = false`
8. Re-encrypt title under new epoch key if provided, update `titleEpochNumber`
9. If message included: store with new epoch number

**Concurrency:** First-write-wins via `UPDATE conversations SET currentEpoch = ? WHERE id = ? AND currentEpoch = ? - 1`. Check rows affected. Rejected client re-fetches + re-encrypts.

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

| Event | Payload | Trigger |
|-------|---------|---------|
| `message:new` | messageId, metadata | User message stored |
| `message:stream` | messageId, token (batched ~50ms) | AI generating |
| `message:complete` | messageId, encrypted blob + metadata | AI response stored |
| `message:deleted` | messageId | Hard-delete |
| `member:added` | userId/linkId, privilege | New member |
| `member:removed` | userId/linkId | Member removed |
| `rotation:pending` | conversationId | Tells next sender to rotate |
| `rotation:complete` | conversationId, newEpochNumber | Clients re-fetch keys |
| `typing:start/stop` | userId | Ephemeral, client→DO→broadcast |
| `presence:update` | members[] | Connection state change |

### 6D — API Worker → DO Communication

```typescript
// apps/api/src/lib/broadcast.ts (NEW)
export async function broadcastToRoom(
  env: Bindings,
  conversationId: string,
  event: RealtimeEvent,
): Promise<void> {
  const id = env.CONVERSATION_ROOM.idFromName(conversationId);
  const stub = env.CONVERSATION_ROOM.get(id);
  await stub.fetch(new Request('http://internal/broadcast', {
    method: 'POST',
    body: JSON.stringify(event),
  }));
}
```

### 6E — WebSocket Route (`apps/api/src/routes/ws.ts` — NEW)

Hono route (NOT tRPC). Two auth paths:

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

Worker entry point re-export: `export { ConversationRoom } from '@lome-chat/realtime';`

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

### 6I — DELETE

- `apps/web/src/lib/sse-client.ts` (replaced by WebSocket)
- `apps/api/src/lib/stream-handler.ts` (SSE replaced by DO broadcast)

### Verification

```bash
cd packages/realtime && pnpm typecheck && pnpm lint && pnpm test
cd apps/api && pnpm typecheck && pnpm lint && pnpm test
```

---

## Phase 7: tRPC Route Migration

**Goal:** Migrate all remaining REST routes to tRPC. Design doc Part 12.

### 7A — Migration Order

1. **Models** — simplest, `publicProcedure`, no auth
2. **Conversations CRUD** — straightforward `protectedProcedure`
3. **Billing** — query-heavy, `billingProcedure`
4. **Messages** — send mutation + DO integration
5. **Trial chat** — `publicProcedure` with rate limiting (standalone anonymous, kept from current)
6. **Link guest** — `publicProcedure` with rate limiting (shared link based)
7. **Dev** — wrapped in env check middleware

### 7B — Pattern Per Route Migration

1. Create tRPC sub-router in `apps/api/src/trpc/routers/`
2. Move business logic from Hono handler into procedure body (service functions stay in `services/`)
3. Input: Zod schemas from `packages/shared` where possible
4. Errors: `throw new TRPCError({ code, message })`
5. Update client hooks to use `trpc.router.procedure.useQuery/useMutation()`
6. Delete old Hono route file
7. Testing: use `createCallerFactory`

### 7C — Complete tRPC Router Structure

```
appRouter
├── models
│   └── list (publicProcedure)
├── conversations
│   ├── create (protectedProcedure)
│   ├── list (protectedProcedure)
│   ├── get (protectedProcedure)
│   ├── delete (protectedProcedure)
│   ├── updateTitle (protectedProcedure)
│   ├── updateBudget (protectedProcedure) — owner only
│   └── assignProject (protectedProcedure) — owner only
├── projects
│   ├── create (protectedProcedure)
│   ├── list (protectedProcedure)
│   ├── update (protectedProcedure)
│   └── delete (protectedProcedure)
├── messages
│   ├── send (chatProcedure)
│   ├── delete (protectedProcedure)
│   ├── getHistory (protectedProcedure)
│   ├── createShare (protectedProcedure)
│   └── getShared (publicProcedure)
├── keys
│   ├── getEpochWraps (protectedProcedure)
│   ├── getChainLinks (protectedProcedure)
│   ├── submitRotation (protectedProcedure)
│   └── getMemberPublicKeys (protectedProcedure)
├── members
│   ├── add (protectedProcedure) — admin/owner
│   ├── remove (protectedProcedure) — admin/owner
│   ├── leave (protectedProcedure) — non-owner
│   ├── updatePrivilege (protectedProcedure) — admin/owner
│   └── list (protectedProcedure)
├── links
│   ├── create (protectedProcedure) — admin/owner
│   ├── revoke (protectedProcedure) — admin/owner
│   └── list (protectedProcedure)
├── budget
│   ├── get (protectedProcedure)
│   ├── setMemberBudget (protectedProcedure) — owner
│   └── removeMemberBudget (protectedProcedure) — owner
├── billing
│   ├── getBalance (phraseRequiredProcedure)
│   ├── listTransactions (phraseRequiredProcedure)
│   ├── createPayment (billingProcedure)
│   ├── processPayment (billingProcedure)
│   └── getPaymentStatus (billingProcedure)
├── account
│   ├── getProfile (protectedProcedure)
│   ├── updateProfile (protectedProcedure)
│   ├── regenerateRecovery (protectedProcedure)
│   └── deleteAccount (protectedProcedure)
├── trial
│   └── stream (publicProcedure + rateLimited) — anonymous trial chat (no account, no persistence)
├── linkGuest
│   ├── accessLink (publicProcedure + rateLimited) — validate link, return epoch wraps + messages + wsToken
│   └── sendMessage (publicProcedure + rateLimited) — send via link with owner's budget
└── dev
    ├── getPersonas (publicProcedure, dev-only)
    └── cleanup (publicProcedure, dev-only)
```

### 7D — Trial Chat (`trial.stream`)

This is the existing anonymous trial chat, kept as-is but moved to tRPC. `publicProcedure + rateLimited`:
- Input: `{ messages, model }` — no auth, no persistence
- Rejects authenticated users (they should use `messages.send`)
- Uses existing `consumeGuestMessage()` from guest-usage.ts for dual-identity Redis rate limiting
- Streams AI response back (via SSE or batched tRPC subscription — TBD based on tRPC streaming support)
- No message storage, no billing beyond rate limits

### 7E — Link Guest (`linkGuest.accessLink`, `linkGuest.sendMessage`)

**`accessLink`:** publicProcedure + rateLimited(30/hour per IP)
1. Input: `{ conversationId, linkPublicKey (base64) }`
2. Validates link exists + not revoked + has correct privilege
3. Returns epoch wraps + chain links + messages (respecting visibleFromEpoch) + wsToken (Redis, 5min TTL, single-use)

**`sendMessage`:** publicProcedure + rateLimited(10/min per IP)
1. Input: `{ conversationId, linkPublicKey, content, model, displayName, messagesForInference }`
2. Validates link + write privilege + owner budget
3. Encrypts + stores (senderType='user', senderId=null, senderDisplayName=displayName)
4. Invokes AI, streams via DO
5. Charges owner's wallets (payerId=owner)

### Verification

```bash
cd apps/api && pnpm typecheck && pnpm lint && pnpm test
cd apps/web && pnpm typecheck && pnpm lint && pnpm test
```

---

## Phase 8: Group Conversations

**Goal:** Multi-member conversations with privileges and lazy epoch rotation. Design doc Parts 4, 6.

### 8A — Member Management (tRPC `members.*`)

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

| Level | Decrypt | Send | Add Members | Remove Members | Manage Links | Rotate |
|-------|---------|------|-------------|----------------|--------------|--------|
| Read | Yes | No | No | No | No | No |
| Write | Yes | Yes | No | No | No | Yes (lazy) |
| Admin | Yes | Yes | Yes | Yes (not owner) | Yes | Yes |
| Owner | Yes | Yes | Yes | Yes | Yes | Yes |

### 8C — Lazy Epoch Rotation

1. On trigger (remove/link revocation): server sets `rotationPending = true`, records `pendingRemovals`
2. On next `messages.send` by write-capable member:
    - Client detects `rotationPending` in response
    - Client: `performEpochRotation(oldEpochPrivKey, remainingMemberPubKeys[])`
    - Client sends rotation data + message atomically via `keys.submitRotation`
    - Server processes in single transaction (Phase 5E protocol)

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

### 9A — Public Link Sharing (tRPC `links.*`)

**Create:**
1. Owner/admin: `createSharedLink(epochPrivKey)` → linkSecret, linkPublicKey, memberWrap
2. Send to server: linkPublicKey, memberWrap, privilege, visibleFromEpoch
3. Server creates **three rows in one transaction**:
   a. `sharedLinks` row — linkPublicKey, privilege, visibleFromEpoch, conversationId
   b. `epochMembers` row — wrap stored uniformly alongside account member wraps (epochId for current epoch, memberPublicKey=linkPublicKey, wrap=memberWrap)
   c. `conversationMembers` row — linkId set to the new sharedLinks.id, userId null, privilege, visibleFromEpoch
4. URL: `https://app.com/c/{conversationId}#{linkSecretBase64url}` (fragment never sent to server)

**Access (`linkGuest.accessLink` — already defined in Phase 7E):**
1. Visitor extracts linkSecret from URL fragment
2. `deriveKeysFromLinkSecret(linkSecret)` → linkKeyPair
3. Sends conversationId + linkPublicKey to server
4. Server returns epoch wraps + chain links + messages
5. Client decrypts via link private key → epoch key → messages

**Revocation:** Sets `revokedAt` on sharedLinks, `leftAt` on conversationMembers, inserts `pendingRemovals`, sets `rotationPending`. Triggers lazy epoch rotation.

### 9B — Individual Message Sharing (tRPC `messages.createShare`/`getShared`)

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

**Goal:** Update all frontend code for epoch-based E2EE, tRPC, WebSocket. Design doc Part 11.

### 10A — DELETE Entirely

| File | Reason |
|------|--------|
| `apps/web/src/stores/finalize-queue.ts` + tests | No finalize with epoch encryption |
| `apps/web/src/stores/finalize-queue.compression.test.ts` | Same |
| `apps/web/src/lib/encrypt-content.ts` + test | Server encrypts now |
| `apps/web/src/lib/sse-client.ts` | Replaced by WebSocket |

### 10B — Message Decryption Rewrite (`apps/web/src/hooks/use-decrypted-messages.ts`)

Epoch-based decryption:
1. Fetch epoch wraps from `trpc.keys.getEpochWraps.useQuery({ conversationId })`
2. `unwrapEpochKey(accountPrivKey, wrap)` → cache in session-scoped `Map<string, Uint8Array>` keyed by `convId:epochNum`
3. `decryptMessage(epochPrivKey, blob)` for each message
4. Chain link traversal for older epochs via `trpc.keys.getChainLinks`
5. Epoch key cache lives in a **module-scope Map or React context provider** — NOT `useRef`. This ensures navigating away from a conversation and back doesn't require re-fetching and re-unwrapping epoch keys. The cache persists for the entire session and is cleared on logout (subscribe to auth store changes). Create `apps/web/src/lib/epoch-key-cache.ts` as a singleton: `const epochKeyCache = new Map<string, Uint8Array>()` with `clearCache()` export wired to auth store's `clear()` method.

### 10C — Chat Hooks Rewrite

- `use-authenticated-chat.ts`: Send plaintext via `trpc.messages.send.useMutation()`, no finalize. Receive tokens via WebSocket, final blob via `message:complete`.
- `use-chat-stream.ts`: Rewrite to use WebSocket instead of SSE.

### 10D — New Hooks

| Hook | Purpose |
|------|---------|
| `use-epoch-keys.ts` | Fetches + caches epoch key wraps per conversation |
| `use-conversation-ws.ts` | React hook wrapping `ConversationWebSocket` |
| `use-message-replay-guard.ts` | Tracks received message_id in `Set<string>` via `useRef`, rejects duplicates |

### 10E — Replace Manual Hooks with tRPC

| Current | tRPC Replacement |
|---------|------------------|
| `useConversations()` with manual fetch | `trpc.conversations.list.useQuery()` |
| `useConversation(id)` with manual fetch | `trpc.conversations.get.useQuery({ id })` |
| `useBalance()` with manual fetch | `trpc.billing.getBalance.useQuery()` |
| `useTransactions()` with manual fetch | `trpc.billing.listTransactions.useQuery()` |
| manual `fetch` for mutations | `trpc.*.useMutation()` |

### 10F — Shared Schemas Update (`packages/shared/`)

- REMOVE: finalize-related schemas
- UPDATE: message response schema (encryptedBlob, epochNumber, senderType, senderId, senderDisplayName, payerId, sequenceNumber)
- UPDATE: chat request schema (content is plaintext string, not encrypted)
- UPDATE: conversation response schema (epoch/budget fields)
- ADD: schemas for epochs, members, links, budgets, key operations

### 10G — New UI Components

| Component | Purpose |
|-----------|---------|
| Group chat header | Member avatars, count, add member button |
| Member list panel | Privileges, online status, remove button |
| Add member modal | Search users, set privilege, visibleFromEpoch |
| Budget settings modal | Per-conversation + per-person budget |
| Share conversation modal | Generate link, set privilege/visibility |
| Share message modal | Generate isolated share URL |
| Shared conversation view | Public route, key from URL fragment |
| Shared message view | Public route, single message display |
| Settings page updates | Recovery phrase regen, password change, 2FA |
| Encryption badge | Visual E2EE status indicator |

### Verification

```bash
cd apps/web && pnpm typecheck && pnpm lint && pnpm test
```

---

## Phase 11: Cleanup & Final Verification

### 11A — Delete from `apps/api`

- `@noble/ciphers` and `@noble/hashes` from package.json
- Old REST route files fully migrated to tRPC
- `stream-handler.ts` + test (SSE replaced by DO)
- Unused middleware from old flows

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
- `apps/api/src/app.ts` — tRPC mount + DO binding + WebSocket route
- `apps/api/src/types.ts` — add CONVERSATION_ROOM to Bindings
- `apps/api/src/trpc/` — all tRPC infrastructure
- `apps/api/src/routes/opaque-auth.ts` — auth flow changes
- `apps/api/src/routes/ws.ts` — NEW (WebSocket upgrade)
- `apps/api/src/services/chat/message-persistence.ts` — epoch encryption
- `apps/api/src/services/billing/balance.ts` — wallet queries
- `apps/api/src/services/billing/transaction-writer.ts` — chargeForUsage
- `apps/api/src/lib/totp.ts` — crypto package import
- `apps/api/src/lib/broadcast.ts` — NEW (API→DO)
- `apps/api/src/lib/speculative-balance.ts` — group budget reservation

### Preserved Billing Logic (UNCHANGED algorithms)
- `packages/shared/src/pricing.ts`
- `packages/shared/src/constants.ts`
- `packages/shared/src/budget.ts`
- `packages/shared/src/tiers.ts`
- `apps/api/src/services/billing/cost-calculator.ts`
- `apps/api/src/services/billing/can-send.ts`
- `apps/api/src/services/billing/guest-usage.ts`

### Real-time (Phase 6)
- `packages/realtime/src/conversation-room.ts` — NEW DO class
- `packages/realtime/src/events.ts` — NEW typed events

### Frontend (Phase 10)
- `apps/web/src/lib/auth.ts` — remove DEK
- `apps/web/src/lib/auth-client.ts` — new key hierarchy
- `apps/web/src/lib/trpc.ts` — NEW tRPC client
- `apps/web/src/lib/ws-client.ts` — NEW WebSocket client
- `apps/web/src/hooks/use-decrypted-messages.ts` — epoch rewrite
- `apps/web/src/hooks/use-authenticated-chat.ts` — send plaintext, no finalize
- `apps/web/src/hooks/use-chat-stream.ts` — WebSocket instead of SSE

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
