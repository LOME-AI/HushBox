# Execution Plan: E2EE Architecture Overhaul

## Context

Replace the current DEK-based encryption system with an ECIES/epoch-based architecture. Remove the finalize queue. Migrate REST to tRPC. Add Durable Objects for real-time. Implement group conversations, shared links, message sharing, and budget system. No existing users — clean slate, delete all backwards compatibility.

The plan document (provided by user) is the authoritative specification for algorithms, data flows, and threat model. This execution plan maps that specification onto the codebase.

---

## Phase 1: Crypto Package Overhaul

**Goal:** Rewrite `packages/crypto` to expose use-case-named functions backed by a single ECIES primitive (X25519 + HKDF + XChaCha20-Poly1305).

### No dependency version changes needed
- `@noble/ciphers@^1.2.1` resolves to 1.3.0 which already has `xchacha20poly1305` from `@noble/ciphers/chacha`
- `@noble/hashes@^1.7.1` resolves to 1.8.0 which has `hkdf` and `sha256`
- `@noble/curves@^2.0.1` has `x25519.keygen(seed?)` and `x25519.getPublicKey`
- Remove `@noble/ciphers` and `@noble/hashes` from `apps/api/package.json` after moving TOTP encryption to crypto package
- The v2 mismatch in `apps/api` resolves naturally since those deps are removed entirely

### Compression note
The plan document says "Deflate" but the existing code uses gzip (`gzipSync`/`gunzipSync` from fflate). These are different formats. We keep gzip exactly as-is — `compression.ts` and `message-codec.ts` are unchanged.

### Auth session persistence
The OPAQUE export key replaces the current KEK for "keep me signed in" localStorage persistence. On page reload: read stored export key → derive wrapping key pair via HKDF → fetch `/me` → unwrap account private key. Same security posture as today's KEK storage.

### Files to DELETE
- `packages/crypto/src/encryption.ts` + test (AES-256-GCM + AES-KW — replaced by ECIES)

### Files to KEEP UNCHANGED
- `compression.ts` + test (gzip via fflate — exact same logic)
- `message-codec.ts` + test (encodeForEncryption/decodeFromDecryption with flag byte 0x00/0x01)
- `serialization.ts` + test (toBase64/fromBase64)
- `constant-time.ts` + test
- `opaque-client.ts` + test

### Files to REWRITE
- **`ecies.ts`** — New ECIES primitive: X25519 DH → HKDF(salt=ephemeral_pub||recipient_pub, info="ecies-xchacha20-v1") → XChaCha20-Poly1305(zero nonce). Single blob output: `0x01 || ephemeral_pub(32B) || ciphertext+tag`. 49 bytes overhead. Decrypt derives recipient_pub from private key via `x25519.getPublicKey()`.
- **`sharing.ts`** — Keep `generateKeyPair()`. Add `deriveKeyPairFromSeed(seed, info)` using HKDF → x25519.keygen. Remove `deriveSharedSecret` from public API (now internal to ECIES).
- **`key-derivation.ts`** — Remove `derivePasswordKEK`, `deriveConversationKey`, `deriveMessageKey`. Add `deriveWrappingKeyPair(opaqueExportKey)` → HKDF(exportKey, info="account-wrap-v1") → x25519 keypair. Add `deriveRecoveryKeyPair(seed)` → Argon2id(seed, salt="recovery-kek-v1") → HKDF(result, info="recovery-wrap-v1") → x25519 keypair. Keep `generateSalt`, `KDF_PARAMS`.
- **`recovery-phrase.ts`** — Remove `computePhraseVerifier`, `verifyPhraseVerifier`. Keep `generateRecoveryPhrase`, `validatePhrase`, `phraseToSeed`, `MNEMONIC_STRENGTH`.
- **`index.ts`** — Complete rewrite of export surface.

### Files to CREATE
| File | Functions |
|------|-----------|
| `account.ts` | `createAccount(exportKey)`, `unwrapAccountKeyWithPassword(exportKey, blob)`, `recoverAccountFromMnemonic(mnemonic, blob)`, `rewrapAccountKeyForPasswordChange(privKey, newExportKey)`, `regenerateRecoveryPhrase(privKey)` |
| `epoch.ts` | `createFirstEpoch(memberPubKeys[])`, `performEpochRotation(oldPrivKey, memberPubKeys[])`, `unwrapEpochKey(accountPrivKey, wrap)`, `traverseChainLink(newerPrivKey, chainLink)`, `verifyEpochKeyConfirmation(privKey, hash)` |
| `message-encrypt.ts` | `encryptMessageForStorage(epochPubKey, plaintext)` (calls encodeForEncryption internally), `decryptMessage(epochPrivKey, blob)` (calls decodeFromDecryption internally) |
| `member.ts` | `wrapEpochKeyForNewMember(epochPrivKey, memberPubKey)` |
| `link.ts` | `createSharedLink(epochPrivKey)`, `deriveKeysFromLinkSecret(secret)` |
| `message-share.ts` | `createMessageShare(plaintext)`, `decryptMessageShare(secret, blob)` |
| `symmetric.ts` | `symmetricEncrypt(key, plaintext)`, `symmetricDecrypt(key, blob)` — XChaCha20-Poly1305 with random 24-byte nonce prepended (192-bit nonce space eliminates collision risk with reused keys). For server-side TOTP encryption. |
| `hash.ts` | `sha256Hash(data)` |
| `errors.ts` | `CryptoError`, `DecryptionError`, `InvalidBlobError`, `KeyDerivationError` |

### TDD order (bottom-up)
1. errors.ts, hash.ts (no deps)
2. sharing.ts modifications (deriveKeyPairFromSeed)
3. recovery-phrase.ts modifications (remove verifier functions)
4. key-derivation.ts rewrite
5. ecies.ts rewrite (core primitive — tests: blob format, round-trips, wrong key, tampered, truncated, version byte)
6. symmetric.ts
7. account.ts (depends on ecies + key-derivation + recovery-phrase)
8. epoch.ts (depends on ecies + sharing + hash)
9. message-encrypt.ts (depends on ecies + message-codec)
10. member.ts, link.ts, message-share.ts (depend on ecies)
11. Integration tests: full pipeline, epoch rotation, chain traversal
12. index.ts barrel rewrite

---

## Phase 2: Database Schema

**Goal:** New schema matching plan Part 14. Single migration since no users exist.

### Migration: `packages/db/drizzle/0013_epoch_encryption_overhaul.sql`

**DROP tables:** `conversation_shares`, `message_shares`

**ALTER `users`:**
- DROP: `password_salt`, `encrypted_dek_password`, `encrypted_dek_phrase`, `phrase_salt`, `phrase_verifier`, `private_key_wrapped`, `encryption_version`
- ADD: `password_wrapped_private_key BYTEA NOT NULL`, `recovery_wrapped_private_key BYTEA NOT NULL` (both wraps generated atomically during registration — no legitimate state where this should be null)
- KEEP: `public_key`, `opaque_registration`, TOTP fields, email fields, billing fields, `username`

**ALTER `conversations`:**
- ADD: `current_epoch INTEGER NOT NULL DEFAULT 1`, `rotation_pending BOOLEAN NOT NULL DEFAULT FALSE`, `pending_removals TEXT[]`, `per_person_budget NUMERIC(20,8)`, `conversation_budget NUMERIC(20,8)`

**ALTER `messages`:**
- DROP: `iv`, `pending_reencryption`, `ephemeral_public_key`, `sharing_key_wrapped`
- RENAME: `content` → `encrypted_blob`
- DROP: `content_type` (no longer needed)
- CHANGE: `role` enum from (user, assistant, system) → `sender_type` (user, ai)
- ADD: `epoch_number INTEGER NOT NULL DEFAULT 1`, `sender_id TEXT`, `sender_display_name TEXT`, `payer_id TEXT`, `sequence_number INTEGER NOT NULL` (server-assigned, auto-incrementing per conversation for deterministic ordering)
- No `disappear_at` — only hard-delete is supported, no scheduled disappearance

**CREATE tables:** `epochs`, `epoch_members`, `shared_links`, `shared_messages`, `member_budgets`, `conversation_spending` (based on plan Part 14, minus `disappear_after`/`disappear_at` — no scheduled disappearance)

**Design notes:**
- No message signatures in v1. Server sets sender metadata in plaintext. Ed25519 can be added later (64 bytes inside encrypted blob) without architectural changes.
- No `disappear_at`/`disappear_after` — only hard-delete supported. No cleanup jobs or cron triggers.
- `sequence_number` assigned in same transaction as message insert (atomic).

### Drizzle schema files
- **DELETE:** `packages/db/src/schema/conversation-shares.ts`, `message-shares.ts`
- **CREATE:** `epochs.ts`, `epoch-members.ts`, `shared-links.ts`, `shared-messages.ts`, `member-budgets.ts`, `conversation-spending.ts`
- **MODIFY:** `users.ts`, `conversations.ts`, `messages.ts`, `index.ts`

### Factories update
- `user.ts`: Remove DEK fields, add `passwordWrappedPrivateKey`, `recoveryWrappedPrivateKey`
- `conversation.ts`: Add `currentEpoch`, `rotationPending`, budget fields
- `message.ts`: Remove `iv`, `pendingReEncryption`, `ephemeralPublicKey`, `contentType`. Add `epochNumber`, `senderType`, `senderId`, `payerId`, `sequenceNumber`. Rename `content` → `encryptedBlob`
- **CREATE:** `epoch.ts`, `epoch-member.ts`, `shared-link.ts` factories

### Zod schemas update (`packages/db/src/zod/`)
- Remove conversation-shares, message-shares schemas
- Add epochs, epoch-members, shared-links, shared-messages schemas
- Update user, conversation, message select/insert schemas

---

## Phase 3: tRPC Infrastructure

**Goal:** Set up tRPC alongside existing Hono routes. Auth routes stay as Hono (OPAQUE multi-step + iron-session cookie manipulation doesn't fit tRPC cleanly).

### Install dependencies
- `apps/api`: `@trpc/server`
- `apps/web`: `@trpc/client`, `@trpc/react-query`

### Create `apps/api/src/trpc/`
| File | Purpose |
|------|---------|
| `context.ts` | `createTrpcContext(c: HonoContext)` → extracts db, redis, user, session, envUtils, env, executionCtx from Hono context |
| `trpc.ts` | `initTRPC.context<TrpcContext>().create()`, defines `publicProcedure`, `protectedProcedure` (throws UNAUTHORIZED if no user), `adminProcedure` (checks conversation ownership) |
| `router.ts` | Root `appRouter` combining sub-routers. Exports `type AppRouter` |
| `index.ts` | Barrel export |

### Mount on Hono (`apps/api/src/app.ts`)
- `/trpc/*` route with middleware: csrfProtection, dbMiddleware, redisMiddleware, ironSessionMiddleware, user-loading middleware (does NOT reject unauthenticated — tRPC protectedProcedure handles that)
- Use `fetchRequestHandler` from `@trpc/server/adapters/fetch`

### tRPC router structure (built incrementally in later phases)
```
appRouter
├── conversations (create, list, get, delete, updateSettings)
├── members (add, remove, leave, updatePrivilege, list)
├── links (create, revoke, list)
├── keys (getEpochWraps, getChainLinks, submitRotation, getMemberPublicKeys)
├── messages (send, delete, getHistory, createShare, getShared)
└── budget (get, update)
```

### What stays as plain Hono
- `/api/auth/*` — OPAQUE multi-step protocol + Set-Cookie (only OPAQUE auth routes)
- `/api/webhooks/*` — External payment callbacks (signature verified in handler)

Everything else moves to tRPC — including guest link access (as `publicProcedure`), `/me` (as tRPC `account.getSession` query), dev routes, billing, conversations, etc.

### Rate limiting in tRPC
Create a `rateLimitedProcedure` tRPC middleware that checks Redis. Replaces current Hono-level rate limiting for migrated routes. Configurable per-procedure (different limits for auth vs chat vs billing).

### Client setup (`apps/web/src/lib/trpc.ts`)
- `createTRPCReact<AppRouter>()`
- `httpBatchLink` with `credentials: 'include'`
- Wrap app in `trpc.Provider` + `QueryClientProvider`

---

## Phase 4: Auth System Update

**Goal:** Update auth routes for new key hierarchy. Keep as Hono routes but change what crypto material is exchanged.

### Registration flow changes (`apps/api/src/routes/opaque-auth.ts`)
- `POST /register/finish`: Client sends `accountPublicKey`, `passwordWrappedPrivateKey`, `recoveryWrappedPrivateKey` (instead of DEK fields). Server stores these in new user columns.
- Remove: `passwordSalt`, `encryptedDekPassword` from registration payload

### Login flow changes
- `POST /login/finish`: Server returns `passwordWrappedPrivateKey` (instead of `encryptedDekPassword` + `passwordSalt`). Client unwraps account private key using `unwrapAccountKeyWithPassword(opaqueExportKey, blob)`.

### `GET /me` changes
- Return `passwordWrappedPrivateKey` and `publicKey` (instead of `encryptedDekPassword`, `passwordSalt`, `privateKeyWrapped`)

### Password change
- Client calls `rewrapAccountKeyForPasswordChange(accountPrivateKey, newExportKey)` → sends new `passwordWrappedPrivateKey`

### Recovery
- Client calls `recoverAccountFromMnemonic(mnemonic, recoveryWrappedBlob)` → gets account private key → sets new password

### TOTP encryption changes (`apps/api/src/lib/totp.ts`)
- Import `symmetricEncrypt`/`symmetricDecrypt` from `@lome-chat/crypto` instead of `@noble/ciphers` directly
- Remove `@noble/ciphers` and `@noble/hashes` from `apps/api/package.json`

### Frontend auth store (`apps/web/src/lib/auth.ts`)
- Remove `dek: Uint8Array | null` from state
- Keep `privateKey: Uint8Array | null` (X25519 account private key)
- `clear()`: zero `privateKey`

### Frontend auth client (`apps/web/src/lib/auth-client.ts`)
- `restoreSession()`: Fetch `/me`, unwrap private key using stored KEK
- Sign-up: `createAccount(exportKey)` → send publicKey + wrappedBlobs to server
- Sign-in: `unwrapAccountKeyWithPassword(exportKey, blob)` → set privateKey in store

---

## Phase 5: Conversations & Epoch Management

**Goal:** Create conversations with epoch 1. Server-side message encryption. Remove finalize.

### Conversation creation flow (tRPC `conversations.create`)
1. Client calls `createFirstEpoch([userAccountPublicKey])` → gets epochPublicKey, confirmationHash, memberWrap
2. Client encrypts conversation title under epoch public key via `encryptMessageForStorage(epochPubKey, title)`
3. Client sends to server: encrypted title, epochPublicKey, confirmationHash, memberWrap
4. Server creates conversation row + epoch row + epoch_members row

### Conversation titles
Titles are encrypted under the epoch public key. The client decrypts them the same way as messages — fetch epoch wrap, unwrap, decrypt. This means the conversation list page requires epoch key resolution for each conversation. Security over convenience.

### Message send flow (tRPC `messages.send`)
1. Client sends plaintext + conversationId
2. Server validates auth, checks budget, checks `rotation_pending`
3. If `rotation_pending`: return signal to client → client calls `performEpochRotation()`, resubmits with rotation data + message
4. Server fetches current epoch public key
5. Server: `encryptMessageForStorage(epochPubKey, plaintext)` → stores blob
6. Server invokes AI, streams tokens
7. Server: `encryptMessageForStorage(epochPubKey, aiResponse)` → stores blob
8. No finalize needed

### Message retrieval (tRPC `messages.getHistory`)
- Return encrypted blobs + metadata (epochNumber, senderType, etc.)
- Client: fetch epoch member wrap → `unwrapEpochKey(accountPrivKey, wrap)` → `decryptMessage(epochPrivKey, blob)`
- Client caches epoch keys in memory (Map keyed by `convId:epochNum`)

### Epoch key endpoint (tRPC `keys.getEpochWraps`)
- Returns all epoch member wraps for the current user in a conversation
- Also returns chain links for backward traversal

### DELETE
- `/api/conversations/:id/messages/:id/finalize` endpoint
- `pendingReEncryption` / `ephemeralPublicKey` from message handling

---

## Phase 6: Durable Objects & Real-Time

**Goal:** WebSocket-based real-time messaging via per-conversation Durable Objects.

### Create `packages/realtime/`
```
packages/realtime/
  package.json          (minimal deps — only Workers types)
  tsconfig.json
  src/
    index.ts            (barrel export)
    conversation-room.ts (ConversationRoom DO class)
    events.ts           (typed event definitions)
```

### ConversationRoom DO
- Pure broadcast hub — no crypto, no DB, no business logic
- `Map<string, WebSocket>` tracking connected members
- Routes:
    - `/connect?userId=xxx` — WebSocket upgrade, add to connections
    - `/broadcast` — POST from API Worker, fan-out to all sockets (with optional exclude list)
- Handles: open, close, error, reconnect
- Dead WebSocket cleanup: `close` and `error` events prune stale connections from the map. Hibernation wake must correctly re-hydrate the connection map.
- Uses Durable Object Hibernation for cost efficiency

### Events broadcast by DO
`message:new`, `message:stream`, `message:complete`, `message:deleted`, `member:added`, `member:removed`, `rotation:pending`, `rotation:complete`, `typing:start`, `typing:stop`, `presence:update`

### Wrangler config (`apps/api/wrangler.toml`)
```toml
[durable_objects]
bindings = [{ name = "CONVERSATION_ROOM", class_name = "ConversationRoom" }]
[[migrations]]
tag = "v1"
new_classes = ["ConversationRoom"]
```

### API Worker entry point re-exports DO
```typescript
export { ConversationRoom } from '@lome-chat/realtime';
```

### WebSocket route (`apps/api/src/routes/ws.ts`)
- `GET /api/ws/:conversationId` — validates session, verifies conversation access, forwards to DO
- Authentication: session cookie validated by Hono middleware, userId passed to DO
- This stays as a Hono route (WebSocket upgrade doesn't fit tRPC)

### Broadcast utility (`apps/api/src/lib/broadcast.ts`)
```typescript
async function broadcastToRoom(env, conversationId, event, data, exclude?)
```
Called from message send, epoch rotation, member changes.

### Token streaming through DO
During AI inference, API Worker accumulates tokens for ~50ms windows, then calls `broadcastToRoom` with the batch. DO unpacks and sends individual WebSocket messages to connected clients. This reduces DO call overhead from one-per-token to ~20 calls/second.

### Add to AppEnv Bindings
`CONVERSATION_ROOM: DurableObjectNamespace`

---

## Phase 7: Group Conversations

**Goal:** Multi-member conversations with privileges and lazy epoch rotation.

### Member management (tRPC `members.*`)
- `add`: Admin fetches new member's publicKey, calls `wrapEpochKeyForNewMember(epochPrivKey, memberPubKey)`, sends wrap + privilege + visibleFromEpoch
- `remove`: Server marks `rotation_pending = true`, records pending removal. Immediately revokes server-side access. Actual rotation happens lazily on next message send.
- `leave`: Same as remove (triggers lazy rotation)
- `updatePrivilege`: Server-side only, no crypto changes
- `list`: Returns member info + privileges

### Lazy epoch rotation
On rotation-triggering event (remove, link revocation):
1. Server sets `rotation_pending = true`, records pending removals
2. Server immediately revokes server access for removed members
3. On next `messages.send` by any write-capable member:
    - Client detects `rotation_pending`
    - Client calls `performEpochRotation(oldEpochPrivKey, remainingMemberPubKeys[])`
    - Client sends rotation data + message atomically
    - Server: creates new epoch, stores wraps, stores chain link, deletes old wraps, clears pending, stores message — all in one transaction

### Concurrency
- No lock on normal message sends (ECIES generates fresh ephemeral key per operation)
- Lock only during epoch rotation: first-write-wins, rejected client re-fetches and re-encrypts

### Privilege levels (server-enforced)
| Level | Decrypt | Send | Add Members | Remove Members | Manage Links | Rotate |
|-------|---------|------|-------------|----------------|--------------|--------|
| Read | Yes | No | No | No | No | No |
| Write | Yes | Yes | No | No | No | Yes (lazy) |
| Admin | Yes | Yes | Yes | Yes (not owner) | Yes | Yes |
| Owner | Yes | Yes | Yes | Yes | Yes | Yes |

### Owner lifecycle
- Owner leaving: deletes entire conversation (cascade)
- Account deletion: leave all groups first

---

## Phase 8: Sharing

### Public link sharing (tRPC `links.*`)
- `create`: Owner/admin generates link via `createSharedLink(epochPrivKey)` → gets linkSecret, linkPublicKey, linkWrap. Sends to server: linkPublicKey, linkWrap, expiresAt, privilege, visibleFromEpoch. Constructs URL: `https://app.com/c/{convId}#{linkSecretBase64url}`. Fragment never sent to server.
- `revoke`: Triggers lazy epoch rotation (link is a virtual member)
- Link access: Visitor extracts linkSecret from fragment → `deriveKeysFromLinkSecret(secret)` → decrypt wrap → get epoch key → decrypt messages

### Guest messaging via links
- Write-privileged link + owner budget: guest sends plaintext → server charges owner → encrypts + stores
- `payer_id = owner`, `sender_id = null`, `sender_display_name = guest name`

### Individual message sharing (tRPC `messages.createShare`/`getShared`)
- Client decrypts target message → `createMessageShare(plaintext)` → gets shareSecret + shareBlob
- Server stores shareBlob in `shared_messages`, returns shareId
- URL: `https://app.com/m/{shareId}#{shareSecretBase64url}`
- Cryptographically isolated — unrelated to conversation keys

---

## Phase 9: Budget System

### Schema (already created in Phase 2)
- `conversations.per_person_budget` — nullable integer, applies to all non-owner members
- `member_budgets` table — per-user per-conversation budget + spent
- `conversation_spending` table — total conversation-wide spending

### Payment logic (tRPC `budget.*`)
```
When user U sends in conversation C owned by O:
  If U == O: charge O's balance, payer = O
  Else:
    budget = conversations.per_person_budget ?? member_budgets[U].budget ?? 0
    If budget > spent AND conversation_budget > total_spent:
      charge O's balance, payer = O, increment spent
    Else:
      charge U's balance, payer = U
  Store payer_id + cost in message metadata
```

### Display
Each message shows: content, sender, cost, "paid by [username]"

---

## Phase 10: tRPC Route Migration

**Goal:** Migrate remaining REST routes to tRPC procedures.

### Migration order
1. **conversations** — Simple CRUD, good proving ground
2. **billing** — Query-heavy, add `withHelcim` tRPC middleware
3. **messages** — Including send (with DO integration), delete, history
4. **members, links, keys, budget** — Group features

### Pattern per route
1. Create tRPC sub-router in `apps/api/src/trpc/routers/`
2. Move business logic into procedure body
3. Input: reuse Zod schemas from `packages/shared`
4. Errors: `throw new TRPCError({ code, message })` instead of `c.json({ error }, status)`
5. Update client hooks to use `trpc.router.procedure.useQuery/useMutation()`
6. Delete old Hono route

### Testing: Use `createCallerFactory` for unit tests (no HTTP)

---

## Phase 11: Frontend Overhaul

### DELETE entirely
- `apps/web/src/stores/finalize-queue.ts` + both test files
- `apps/web/src/lib/encrypt-content.ts` + test

### Auth store (`apps/web/src/lib/auth.ts`)
- Remove `dek` from state
- Keep `privateKey` (account X25519 private key)
- Update `clear()` to zero `privateKey` only

### Auth client (`apps/web/src/lib/auth-client.ts`)
- Signup: `createAccount(exportKey)` → send crypto material
- Login: `unwrapAccountKeyWithPassword(exportKey, blob)` → set privateKey
- Recovery: `recoverAccountFromMnemonic(mnemonic, blob)` → accountPrivateKey
- Session restore: fetch `/me` → unwrap with stored KEK

### Message decryption (`apps/web/src/hooks/use-decrypted-messages.ts`)
- Complete rewrite: epoch-based decryption
- Fetch epoch wraps from `trpc.keys.getEpochWraps`
- `unwrapEpochKey(accountPrivKey, wrap)` → cache in `Map<string, Uint8Array>`
- `decryptMessage(epochPrivKey, blob)` for each message
- Chain link traversal for older epochs
- Async-aware: loading state while fetching epoch keys

### Chat hooks
- `use-authenticated-chat.ts`: Send plaintext (no encryption), no finalize queue, receive via WebSocket
- Replace `use-chat-stream.ts` with WebSocket-based approach:
    - Connect WebSocket to conversation's DO
    - Call `trpc.messages.send.mutate()` (HTTP)
    - Receive tokens via WebSocket `message:stream` events
    - Receive final blob via `message:complete`

### WebSocket client (`apps/web/src/lib/ws-client.ts`)
- Per-conversation WebSocket connection
- Auto-reconnect with exponential backoff
- Typed event handlers matching DO event types

### Remove SSE client
- Delete `apps/web/src/lib/sse-client.ts` (replaced by WebSocket)

### Update message types
- Remove: `iv`, `pendingReEncryption`, `ephemeralPublicKey`, `contentType`
- Add: `epochNumber`, `senderType`, `senderId`, `senderDisplayName`, `payerId`, `sequenceNumber`
- Rename: `content` → `encryptedBlob`

### Shared schemas update (`packages/shared`)
- Remove: `finalizeMessageRequestSchema`
- Update: `messageResponseSchema` (new fields, remove old)
- Update: `streamChatRequestSchema` — `userMessage.content` is now plaintext (not encrypted)

### New UI components needed
- Group chat header (member avatars, add member button)
- Member list (privileges, online status, remove button)
- Add member modal (search users, set privilege, history visibility)
- Budget settings (per-conversation, per-person limits)
- Share conversation modal (generate link, set privilege/expiry)
- Share message modal (individual message sharing)
- Shared conversation view (public route, no auth, key from URL fragment)
- Settings page updates for recovery phrase management

### Replace TanStack Query manual hooks with tRPC hooks
- `trpc.conversations.list.useQuery()` instead of manual `useQuery` + `api.get`
- All query keys managed automatically

---

## Phase 12: Cleanup & Final Verification

### Delete from `apps/api`
- `@noble/ciphers` and `@noble/hashes` from package.json (all crypto through `@lome-chat/crypto`)
- Old REST route files that have been migrated to tRPC
- `stream-handler.ts` (SSE — replaced by DO WebSocket)
- `sse-client.ts` (frontend SSE parser)

### Delete from DB schema
- `conversation-shares.ts`, `message-shares.ts`
- `guest-usage.ts` (if unused)
- Old migration files that are superseded

### Run verification
1. `pnpm test` — all unit + integration tests pass
2. `pnpm test:coverage` — 100% coverage on new code
3. `pnpm typecheck` — no TypeScript errors
4. `pnpm lint` — no ESLint warnings
5. `pnpm dev` — local dev starts (Vite + Wrangler + Docker Compose)
6. E2E: signup → create conversation → send message → verify encrypted storage → decrypt → display
7. E2E: group conversation → add member → both members see messages → remove member → lazy rotation → new messages only for remaining members
8. E2E: shared link → access without account → read messages
9. E2E: individual message share → access via share URL

---

## Critical File Reference

### Crypto package (Phase 1)
- `packages/crypto/src/ecies.ts` — Core ECIES primitive, everything depends on this
- `packages/crypto/src/account.ts` — Account key lifecycle
- `packages/crypto/src/epoch.ts` — Epoch key management
- `packages/crypto/src/key-derivation.ts` — Wrapping/recovery key pair derivation
- `packages/crypto/src/message-encrypt.ts` — Server-side message encrypt/decrypt (integrates compression)

### Database (Phase 2)
- `packages/db/src/schema/users.ts` — Remove DEK columns, add wrapped private key
- `packages/db/src/schema/messages.ts` — Remove iv/ECIES columns, add epoch columns
- `packages/db/src/schema/epochs.ts` — New epoch table
- `packages/db/src/schema/epoch-members.ts` — New member wraps table

### API (Phases 3-10)
- `apps/api/src/app.ts` — Mount tRPC, add DO binding type
- `apps/api/src/trpc/trpc.ts` — tRPC initialization + procedure builders
- `apps/api/src/routes/opaque-auth.ts` — Auth flow changes for new key hierarchy
- `apps/api/src/services/chat/message-persistence.ts` — Replace ECIES with epoch encryption
- `apps/api/src/lib/totp.ts` — Move to crypto package's symmetricEncrypt
- `apps/api/wrangler.toml` — DO binding + migration

### Real-time (Phase 6)
- `packages/realtime/src/conversation-room.ts` — DO class (pure broadcast hub)
- `apps/api/src/routes/ws.ts` — WebSocket upgrade route
- `apps/api/src/lib/broadcast.ts` — API → DO notification utility

### Frontend (Phase 11)
- `apps/web/src/lib/auth.ts` — Remove DEK from Zustand store
- `apps/web/src/lib/auth-client.ts` — New key hierarchy auth flows
- `apps/web/src/hooks/use-decrypted-messages.ts` — Epoch-based decryption with caching
- `apps/web/src/hooks/use-authenticated-chat.ts` — Send plaintext, no finalize
- `apps/web/src/lib/ws-client.ts` — WebSocket client (new file)
- `apps/web/src/lib/trpc.ts` — tRPC client setup (new file)

### Reusable functions from existing code
- `encodeForEncryption` / `decodeFromDecryption` (packages/crypto/src/message-codec.ts) — called internally by encryptMessageForStorage/decryptMessage
- `compress` / `decompress` / `compressIfSmaller` (packages/crypto/src/compression.ts) — called by message-codec
- `toBase64` / `fromBase64` (packages/crypto/src/serialization.ts) — used throughout
- `constantTimeCompare` (packages/crypto/src/constant-time.ts) — used in epoch key confirmation
- All OPAQUE client helpers (packages/crypto/src/opaque-client.ts) — unchanged
- `generateRecoveryPhrase`, `validatePhrase`, `phraseToSeed` (packages/crypto/src/recovery-phrase.ts) — used in account operations
