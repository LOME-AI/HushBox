# Final Plan: E2EE AI Chat Application — Auth, Crypto, Communication & Architecture

---

## Instructions for the Implementing Developer

This document is a complete specification, not working code. Before writing any code, you must:

1. **Read this entire document first.** Understand every section and how they connect. The crypto system, auth flow, real-time layer, and API design are deeply interdependent.

2. **Deeply plan every step before implementation.** Map each section of this document onto the existing codebase. Identify what exists, what needs modification, and what is new. Plan the file structure and module boundaries. Focus on clean code design and strong software engineering — small functions, clear separation, thorough error handling.

3. **The crypto package is a hard boundary.** Code outside of `packages/crypto` must NEVER perform any cryptographic operation directly — no key generation, no encryption, no decryption, no hashing, no key derivation. Instead, the crypto package must expose methods with names so explicit that misuse is effectively impossible. A developer working in the API or frontend should never need to understand the underlying cryptography — they call a method whose name describes exactly what it does for their use case, and the crypto package handles everything internally. If you find yourself importing `@noble/*` or `hash-wasm` outside of `packages/crypto`, you are doing it wrong.

4. **Adapt to the existing codebase.** This document does not prescribe filenames, directory structures, or code patterns. It prescribes behavior, algorithms, data flows, and architectural boundaries. You know the codebase — map these requirements onto it in whatever way produces the cleanest result.

5. **Test cryptographic operations exhaustively.** Every encrypt/decrypt round-trip, every key derivation path, every edge case (empty plaintext, maximum-size messages, corrupted blobs, wrong keys) must be covered by tests in the crypto package before integrating with the rest of the system.

---

## Requirements

These are the original requirements and all subsequent clarifications, collected verbatim.

### Context

This is an AI chat application. The full stack is TypeScript — React on the frontend, Cloudflare Pages for hosting, Cloudflare Workers for the backend, PostgreSQL for persistent storage, and Redis for caching/real-time. Authentication uses the OPAQUE protocol for password management, a 12-word recovery phrase as the sole password reset mechanism, and optional 2FA codes.

### End-to-End Encryption

1. The client is the only entity that can decrypt messages — the server never has access to plaintext at rest or in storage.
2. A full database breach must not reveal any message plaintext.
3. The sole exception to E2EE is that plaintext is sent in transit to invoke the AI model.
4. The server must be able to encrypt messages (at minimum AI responses) without any client being online or available. The server must never need to rely on a connected client to persist an encrypted message. The server must still not be able to decrypt.
5. Server encrypts all messages (both user and AI). User sends plaintext only, server encrypts before storage.

### Message Storage

6. Each message must only be stored once, not duplicated per user or per group member.
7. For extremely common things like messages, we cannot justify high storage costs each, like 1KB per message.
8. Message deletion is allowed and is a hard-delete from the database.

### Account & Credential Binding

9. Decryption must be tied to the account — possessing any single key without account credentials must not be sufficient to decrypt.
10. A user must be able to regain full access using only their password.
11. If the password is forgotten, the only recovery path is a 12-word recovery phrase.
12. Recovery phrases and regenerating them already exist in the code — keep them how they are.

### Offline / Long Absence Tolerance

13. A user must be able to be logged out for an arbitrarily long time, return to a group with membership changes, new messages, etc., and still access everything they are entitled to.

### Group Conversations

14. Support creating groups with multiple members. Not expecting 1,000+ member groups.
15. Support varying privilege levels within a group (at minimum: read vs. write).
16. Members with write permission can message the AI, and all members (including read-only) can see the AI response.
17. Support adding and removing members from a group at any time.
18. When a member is removed, they must lose the ability to decrypt future messages (forward secrecy of membership).
19. A brief race window between revocation and the revoked client learning of it is acceptable.
20. Any write-capable member can perform the epoch rotation action — they all have the keys necessary, so let any client handle it. Only write+ can rotate.
21. Upon epoch rotation, all remaining members can still see old messages.

### Public Link Sharing

22. It must be possible to share a link that grants anyone access to a conversation without requiring an account.
23. The link must not transmit the decryption secret to the server (e.g., via URL fragment).
24. Public links must support expiry.
25. Guests via write-enabled links can send messages using the owner's balance.

### Individual Message Sharing

26. It must be possible to share a single message outside its conversation.
27. Sharing a single message must be cryptographically isolated — access to one shared message must not grant access to any other message or the conversation as a whole.

### Real-Time

28. All messages (from AI and users) must update in real time for all members of a conversation.
29. Must be able to stream the plaintext directly to the user as the stream comes in from the AI.

### Budget System

30. Owner can set a max budget both per person and conversation wide to allow others to use their balance instead of their own. This is 0 by default.
31. When out, the other people must use their own balance.
32. Support both everyone-per-person spending (single value for all) and individual per-person spending. One column: if non-null, that's the everyone value; if null, individual entries elsewhere, no entry means zero.
33. On shared chats, show who paid next to the message price. Who paid is also who owns the message / it is under their account.
34. Guests can send messages with the owner's balance without an account.

### Threat Model

35. The server must be assumed potentially malicious — even a compromised or adversarial server must not be able to decrypt any encrypted data.
36. Protection against the server reading plaintext in transit (during AI invocation) is out of scope — accepted exception.

### Lifecycle & Membership

37. Owner leaving the group deletes all their conversations, including group chats.
38. Voluntary leave triggers removal (and therefore lazy epoch rotation).
39. For account deletions, leave all groups.
40. Must be able to control if new users and guests can see messages from before they were added.

### Operational

41. No lock on normal message sends — concurrent writes are fine. Lock only during epoch rotation.
42. Failed AI responses just don't save.
43. Support client-side caching of decrypted epoch keys.
44. Rate limiting via Redis.
45. Lazy epoch rotation: on a rotation-triggering event, just mark the conversation as due for a rotation, then rotate when the next message is sent.

### Design Constraints

46. Want the absolute strongest, future-proof possible design, hyper-optimized to this use-case with the possibility of migration and change in the future.
47. Minimize storage accumulation through repetitive tasks like epoch rotations with either non-increasing storage or low accumulation while maintaining security and features.
48. Keep storage accumulation bounded, not needing to grow unbounded for certain operations.
49. Must be able to cryptographically lock out people whose information has been revoked.
50. Post-quantum is out of scope — no added complexity or cost is necessary to support it.
51. Keep it relatively simple. Make sure every addition has meaningful value added.
52. Must support one webhook for the payment processor.
53. Favor existing dependencies already in the codebase.

---

## Part 1: Cryptographic Primitives

### Algorithm Table

| Purpose | Algorithm | Library | Package Location |
|---|---|---|---|
| Asymmetric key exchange | X25519 | `@noble/curves` | packages/crypto |
| Symmetric AEAD | XChaCha20-Poly1305 | `@noble/ciphers` | packages/crypto |
| Key derivation | HKDF-SHA-256 | `@noble/hashes` | packages/crypto |
| General hashing | SHA-256 | `@noble/hashes` | packages/crypto (expose utility methods for any hashing needs in other packages) |
| Password authentication | OPAQUE | `@cloudflare/opaque-ts` | packages/crypto (exposes both client-side and server-side OPAQUE helpers; apps/api calls the server-side helpers) |
| Recovery phrase KDF | Argon2id | `hash-wasm` | packages/crypto |
| Recovery phrase generation | BIP-39 | `@scure/bip39` | packages/crypto |
| TOTP 2FA | TOTP | `otplib` | apps/api |
| Message signing (future) | Ed25519 | `@noble/curves` | packages/crypto (not implemented in v1) |
| Pre-encryption compression | Deflate | `fflate` | packages/crypto |
| Session management | Encrypted cookies | `iron-session` | apps/api |

### Why Each Algorithm

**X25519:** Conservative elliptic curve design. No point validation needed, no invalid curve attacks, constant-time by construction. 128-bit security. Native in Cloudflare Workers Web Crypto and all modern browsers. From the same curve family as Ed25519, so one library (`@noble/curves`) covers both current and future needs.

**XChaCha20-Poly1305 over AES-256-GCM:** The extended 192-bit nonce eliminates nonce collision risk entirely with random generation. While our ECIES construction uses a zero nonce (unique key per operation makes nonce irrelevant), XChaCha20 provides a free safety margin against implementation mistakes — if someone accidentally reuses a key, the 192-bit nonce still protects them. AES-256-GCM's 96-bit nonce would be catastrophic in the same scenario. Additionally, `@noble/ciphers` is already a dependency, so there is zero added cost. Performance is consistent across all platforms since we use the pure JS path regardless.

**HKDF-SHA-256:** Standard (RFC 5869). Extracts entropy from non-uniform DH outputs and expands to exact key sizes. Domain separation via the `info` parameter prevents cross-protocol key reuse. Native in Web Crypto, available via `@noble/hashes`.

**Argon2id:** Memory-hard password hashing. Resists GPU/ASIC brute force. The `id` variant combines side-channel resistance (Argon2i) with GPU resistance (Argon2d). Winner of the Password Hashing Competition. Used only for recovery phrase KDF — infrequent, so the WASM overhead of `hash-wasm` is acceptable.

**OPAQUE:** Asymmetric PAKE where the server never sees the password, not even during registration. Produces an export key that is deterministic from the password but unknown to the server. This property is what makes the entire account key hierarchy work. `@cloudflare/opaque-ts` is Cloudflare's own implementation built for Workers.

**BIP-39:** Standardized 2048-word list, built-in checksum, human-readable. 12 words = 128 bits of entropy. Widely understood UX pattern. `@scure/bip39` is from the same author as the `@noble` family.

### Version Mismatch — Must Fix Before Implementation

`packages/crypto` uses `@noble/ciphers@^1.2.1` and `@noble/hashes@^1.7.1`. `apps/api` uses `@noble/ciphers@^2.1.1` and `@noble/hashes@^2.0.1`. The v2 releases had breaking API changes (different import paths, different function signatures). Both must be aligned to v2 across the board before any implementation work begins. The v2 APIs are cleaner and the migration is straightforward.

---

## Part 2: ECIES — The Single Encryption Primitive

Every encrypted blob in this system — messages, key wraps, chain links, share blobs — uses the same ECIES construction. There is exactly one encrypt function and one decrypt function in the entire system.

### Encrypt(recipient_public_key, plaintext) → blob

```
1. Generate ephemeral X25519 key pair (ephemeral_private, ephemeral_public)
2. Compute shared_secret = X25519_DH(ephemeral_private, recipient_public_key)
3. Derive symmetric_key = HKDF-SHA-256(
     ikm = shared_secret,
     salt = ephemeral_public ‖ recipient_public_key,
     info = "ecies-xchacha20-v1",
     length = 32
   )
4. Nonce = 24 bytes of zeros (safe because key is unique per operation)
5. ciphertext ‖ tag = XChaCha20-Poly1305(symmetric_key, nonce, plaintext)
6. Return: version_byte (1B) ‖ ephemeral_public (32B) ‖ ciphertext ‖ tag (16B)
```

### Decrypt(recipient_private_key, blob) → plaintext

```
1. Parse blob: version_byte (1B), ephemeral_public (32B), ciphertext, tag (16B)
2. Check version_byte = 0x01 (current version)
3. Compute shared_secret = X25519_DH(recipient_private_key, ephemeral_public)
4. Derive symmetric_key = HKDF-SHA-256(
     ikm = shared_secret,
     salt = ephemeral_public ‖ recipient_public_key,
     info = "ecies-xchacha20-v1",
     length = 32
   )
5. plaintext = XChaCha20-Poly1305_Open(symmetric_key, zeros, ciphertext, tag)
6. If auth fails, reject (tampered or wrong key)
```

### Per-Blob Overhead: 49 bytes

| Component | Size |
|---|---|
| Version byte | 1 byte |
| Ephemeral public key | 32 bytes |
| Poly1305 auth tag | 16 bytes |
| **Total fixed overhead** | **49 bytes** |

### Why Zero Nonce is Safe

Each ECIES operation generates a fresh ephemeral key pair, producing a unique shared secret and therefore a unique derived symmetric key. No symmetric key is ever reused. The nonce value is irrelevant when the key is unique — a constant zero nonce is perfectly safe and saves 24 bytes per blob.

### Version Byte

The first byte of every blob is `0x01`, indicating X25519 + XChaCha20-Poly1305. Future algorithm migrations (e.g., post-quantum ML-KEM) would use `0x02`. Clients check the version byte and select the appropriate decrypt path. Cost: 1 byte per blob. Value: painless future migration.

### Compression

Before encryption, compress the plaintext using `fflate` (deflate). After decryption, decompress. This reduces blob sizes for typical chat messages (text compresses well). The crypto package handles this internally — callers never see compressed data.

---

## Part 3: Account Key Hierarchy

### Key Structure

```
Password
  → OPAQUE protocol → export key (server never sees this)
    → HKDF(export_key, info="account-wrap-v1") → wrapping key pair
      → ECIES_Encrypt(wrapping_pub, account_private_key) → password_wrapped_blob

12-Word Mnemonic
  → BIP-39 → 256-bit seed
    → Argon2id(seed, salt="recovery-kek-v1") → recovery KEK
      → HKDF(recovery_kek, info="recovery-wrap-v1") → recovery key pair
        → ECIES_Encrypt(recovery_pub, account_private_key) → recovery_wrapped_blob
```

### Account Creation

1. Client runs OPAQUE registration with server. Server stores OPAQUE state. Client receives export key.
2. Client generates X25519 account key pair.
3. Client derives wrapping key pair from export key via HKDF.
4. Client wraps account private key under wrapping public key via ECIES.
5. Client generates 12-word BIP-39 mnemonic, derives seed, runs Argon2id, derives recovery key pair, wraps account private key under recovery public key via ECIES.
6. Client sends to server: account public key, password-wrapped blob, recovery-wrapped blob.
7. Client displays mnemonic once for user to record. Mnemonic is never sent to the server.

### Server-Stored Account Data

| Field | Approx Size | Encrypted? |
|---|---|---|
| account_id (UUID) | 16B | No |
| account_public_key | 32B | No |
| password_wrapped_private_key | ~81B | ECIES blob |
| recovery_wrapped_private_key | ~81B | ECIES blob |
| OPAQUE server state | ~200B | Per OPAQUE spec |

### Login

1. Client completes OPAQUE login → receives export key.
2. Client derives wrapping key pair from export key.
3. Client fetches password_wrapped_private_key from server.
4. Client decrypts via ECIES → account_private_key in memory.
5. Client can now decrypt all conversation epoch keys.

### Password Change

1. Authenticate with old password → get account private key.
2. Run new OPAQUE registration with new password → new export key.
3. Derive new wrapping key pair, re-wrap account private key.
4. Upload new blob and new OPAQUE registration atomically.
5. Recovery blob is unchanged.

### Account Recovery

1. User enters 12-word mnemonic.
2. Client derives recovery key pair (BIP-39 → seed → Argon2id → HKDF → key pair).
3. Client fetches recovery_wrapped_private_key from server.
4. Client decrypts → account_private_key.
5. Client sets new password (new OPAQUE registration + new password wrap).
6. Optionally regenerate recovery phrase (new mnemonic, new recovery blob).

### Recovery Phrase Regeneration

Supported at any time while authenticated. Generate new mnemonic, derive new recovery key pair, re-wrap account private key, replace recovery blob on server. Old mnemonic becomes invalid.

### 2FA (TOTP)

2FA is an authentication gate, not an encryption factor. The server verifies the TOTP code before releasing wrapped key material. Losing the 2FA device does not lock the user out — the recovery phrase bypasses 2FA after identity verification. 2FA is implemented via `otplib` on the server.

---

## Part 4: Conversations & Epochs

### Core Concept

Each conversation has a sequence of epochs. Each epoch has its own X25519 key pair. The epoch public key is stored in plaintext so the server can encrypt AI responses. The epoch private key is wrapped (via ECIES) for each current member under their account public key.

### Epoch Rotation Triggers

A new epoch is created **only** when:
- A member is removed (including via voluntary leave)
- A shared link is revoked

Adding a member does NOT require rotation (no backward secrecy requirement — new members should see history by default).

### Lazy Epoch Rotation

On a rotation-triggering event (removal, link revocation), the server does NOT rotate immediately. Instead:

1. Server marks the conversation as `rotation_pending = true`.
2. Server records the pending removals (member IDs and/or link IDs to remove).
3. Server immediately revokes server-side access for removed members (they can no longer fetch any data).
4. No cryptographic rotation happens yet.
5. When the next message is sent by any write-capable member:
   a. Client detects `rotation_pending` flag.
   b. Client performs the full epoch rotation (new key pair, wraps for remaining members, chain link).
   c. Client sends rotation + message atomically.
   d. Server clears `rotation_pending` and processes the rotation.

Benefits: conversations where someone is removed but no one ever messages again incur zero rotation cost. Multiple removals between messages collapse into a single rotation.

Race window: between removal and the next message, the removed member theoretically still has the epoch key cached in memory. But they are locked out server-side (cannot fetch new messages). The only exposure is if they intercept a message in transit during this window. This is within the accepted race window per the requirements.

### Epoch Chain (Backward Access)

Each epoch rotation produces a chain link: the OLD epoch's private key encrypted under the NEW epoch's public key.

```
chain_link_N = ECIES_Encrypt(epoch_N_public_key, epoch_(N-1)_private_key)
```

To read a message from epoch 1 when the current epoch is 5:
1. Unwrap epoch 5 private key from your member wrap (using account private key).
2. Decrypt chain link at epoch 5 → epoch 4 private key.
3. Decrypt chain link at epoch 4 → epoch 3 private key.
4. Continue to epoch 1.
5. Decrypt the message.

This is O(E) ECDH operations where E is the number of epochs traversed. At ~50μs per operation, 50 epochs = 2.5ms. Negligible.

### Client-Side Key Caching

Clients should cache decrypted epoch keys in memory for the duration of the session. After first traversal, all subsequent reads from any epoch are O(1). Cache is cleared on logout. Never persisted to disk.

### Key Confirmation Hash

Each epoch row stores `confirmation_hash = SHA-256(epoch_private_key)`. After unwrapping an epoch key, the client hashes it and compares against the stored confirmation hash. This provides fast failure on corrupted wraps or wrong keys, rather than confusing Poly1305 auth failures on every message decrypt attempt. Cost: 32 bytes per epoch row. The confirmation hash does not help identify which key to use — the `epoch_number` on each message metadata tells the client which epoch to look up.

### History Visibility for New Members

Controlled by `visible_from_epoch` (an integer stored per member). The server refuses to serve messages or chain links from before that epoch. This is server-enforced, not cryptographic.

Rationale: cryptographic history restriction (breaking chain links, retained wraps, split MEK/CK keys) was evaluated extensively. Every approach either accumulates unbounded storage, breaks after multiple boundaries, or adds significant complexity. No major protocol (MLS, Signal, Matrix) has solved this cryptographically in a general, composable way. MLS explicitly leaves it to the application layer. Since new members never possessed old keys, the only way they access old history is if the server serves it. The server is already trusted not to replay AI plaintext logs — this is the same trust boundary.

When adding a member with history access: just wrap the current epoch key for them. They chain backward to all history. `visible_from_epoch = 1`.

When adding a member with no history access: just wrap the current epoch key for them. Set `visible_from_epoch = current_epoch`. Server enforces the boundary. No rotation, no chain link changes.

This also applies to guest links. A link can have a `visible_from_epoch` that restricts how far back the server serves data.

Lazy application: adding a no-history member can also be lazy — mark the pending add, execute when the next message is sent. The new member sees an empty conversation until then. Display a "waiting for new messages" state in the UI.

### Epoch Rotation Protocol (Detailed)

When a write-capable client detects `rotation_pending` and sends a message:

1. Client fetches the current epoch's public key and its own member wrap.
2. Client decrypts current epoch private key using its account private key.
3. Client generates a new X25519 epoch key pair.
4. Client computes `confirmation_hash = SHA-256(new_epoch_private_key)`.
5. For each remaining member (accounts + active links, excluding pending removals):
   `new_wrap = ECIES_Encrypt(member_public_key, new_epoch_private_key)`
6. `chain_link = ECIES_Encrypt(new_epoch_public_key, old_epoch_private_key)`
7. Client encrypts their message under the NEW epoch public key.
8. Client sends atomically to server:
    - New epoch public key
    - New epoch confirmation hash
    - All member wraps
    - Chain link
    - IDs of removed members/links
    - The encrypted message
9. Server in one transaction:
    - Creates new epoch row
    - Stores all member wraps in `epochMembers`
    - Stores chain link on the epoch row
    - Deletes old epoch's `epochMembers` wraps
    - Deletes `pendingRemovals` rows for this conversation
    - Sets `leftAt` on `conversationMembers` rows for removed members (if not already set)
    - Updates conversation's `currentEpoch` pointer
    - Clears `rotationPending`
    - Re-encrypts conversation title under new epoch key, updates `titleEpochNumber`
    - Stores the message

### Adding a Member

No rotation. Any admin/owner client:

1. Fetches new member's account_public_key from server.
2. Decrypts current epoch private key using own account private key.
3. `new_wrap = ECIES_Encrypt(new_member_account_public_key, current_epoch_private_key)`
4. Sends to server: new member ID, wrap, privilege level, visible_from_epoch.
5. Server creates `conversationMembers` row (application-layer access) and `epochMembers` row (key distribution) in one transaction.

### Storage Per Conversation

| Component | Count | Size Each | Accumulates? |
|---|---|---|---|
| Epoch rows | E (one per rotation + 1) | ~182B (32B pubkey + 32B confirmation hash + 80B chain link + overhead) | Yes, bounded by human actions |
| Current member wraps | N (current members + active links) | ~81B | No — replaced on rotation |
| Messages | M | 49B overhead + compressed plaintext + metadata | Yes, inherent to chat |

For a conversation with 10 members, 20 removals, 50,000 messages averaging 300B: key management overhead is ~5.6KB. Messages are ~15MB. Key overhead is 0.037% of message storage.

---

## Part 5: Message Encryption & Storage

### User Messages

The server encrypts all messages (both user and AI). When a user sends a message:

1. Client sends plaintext to server via API request.
2. Server validates auth, checks write permission, checks budget.
3. Server fetches current epoch public key.
4. Server encrypts: `blob = ECIES_Encrypt(epoch_public_key, compress(plaintext))`
5. Server stores blob and metadata. Discards plaintext.
6. Server invokes AI with plaintext.
7. Server streams AI tokens to Durable Object for real-time fan-out.
8. On AI completion, server encrypts AI response the same way, stores it.
9. Server sends final encrypted blob to Durable Object.

The server can encrypt (it has the epoch public key) but cannot decrypt (it never has the epoch private key). This is the core asymmetric property of ECIES.

### Why Server Encrypts Everything

The server already receives the plaintext for AI invocation. Having the client also encrypt and send a blob adds a second code path for user messages while the server still needs to encrypt AI messages. Since the server sees plaintext either way, there is no security gain from client-side encryption of user messages. One encryption code path (server-side ECIES) is simpler and the security posture is identical.

### Message Metadata (Plaintext, Not in Blob)

| Field | Purpose |
|---|---|
| message_id (UUID) | Unique identifier, replay protection |
| conversation_id | Routing |
| epoch_number | Which epoch key decrypts this message |
| sender_type ('user' or 'ai') | Display |
| sender_id (UUID, nullable) | Who sent it (null for AI, null for anonymous guests) |
| sender_display_name (nullable) | Guest display name |
| payer_id (UUID, nullable) | Who paid for this message |
| sequence_number (integer) | Deterministic ordering per conversation |
| created_at (timestamp) | Ordering and display |

Cost and model information are not stored on the message. They live in `usage_records` linked via `sourceType = 'message'` and `sourceId = message.id`. A single message can have multiple usage records (e.g., text + image in one reply).

This metadata is needed by the server for routing, billing, real-time delivery, and decryption key selection. It does not reveal message content.

### Per-Message Storage Cost

For a typical 200-character message:

| Component | Size |
|---|---|
| Row metadata | ~81B |
| ECIES overhead | 49B |
| Compressed message ciphertext | ~150B (compression helps) |
| **Total** | **~280 bytes** |

### Message Deletion

Hard delete. The server removes the entire row from the database. The encrypted blob is gone permanently. The server cannot read the blobs it is deleting — no trust issue.

### Replay Protection

Clients track received `message_id` values in a set during the session. Duplicate IDs are rejected. Cleared on logout. This prevents a malicious server from re-sending old encrypted messages.

---

## Part 6: Privilege Levels

| Level | Decrypt | Send Messages | Add Members | Remove Members | Manage Links | Perform Rotation |
|---|---|---|---|---|---|---|
| Read | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| Write | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ (only when rotation_pending during message send) |
| Admin | ✓ | ✓ | ✓ | ✓ (not owner) | ✓ | ✓ |
| Owner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Privilege enforcement is server-side. All privilege levels share the same cryptographic key material (the epoch private key). A malicious server could theoretically allow a read-only member to submit a message, but since read-only members already have the decryption key, this is not a meaningful escalation. Cryptographic write enforcement (e.g., signing keys) can be added later via Ed25519 without changing the core architecture.

---

## Part 7: Public Link Sharing

### Links as Virtual Members

A shared link is a virtual member of the conversation with its own X25519 key pair derived from a secret in the URL. The epoch rotation machinery handles links automatically — no special cases. Multiple links per conversation are supported, each with its own privilege and history visibility.

### Link Creation

1. Owner/admin generates a random 256-bit `link_secret`.
2. Derives key pair: `link_keypair = X25519_FromSeed(HKDF(link_secret, info="link-keypair-v1"))`.
3. Decrypts current epoch private key.
4. Wraps epoch key for the link: `link_member_wrap = ECIES_Encrypt(link_keypair.public, epoch_private_key)`.
5. Sends to server: link_public_key, link_member_wrap, privilege, visible_from_epoch.
6. Server creates a `sharedLinks` row (link metadata) AND an `epochMembers` row (the wrap). Wraps are stored uniformly in `epochMembers` for all member types — no separate wrap storage on `sharedLinks`.
7. Server creates a `conversationMembers` row with `linkId` set and `userId` null.
8. Constructs URL: `https://app.com/c/{conversation_id}#{link_secret_base64url}`

The URL fragment (after `#`) is never sent to the server by the browser. The server only sees the conversation_id.

### Link Access

1. Visitor opens link.
2. Client extracts `link_secret` from URL fragment.
3. Derives `link_keypair` from secret.
4. Sends conversation_id + link_public_key to server (no auth required for link access).
5. Server checks link validity (exists, not revoked).
6. Server returns: epoch member wrap for this link's public key, epoch chain data, encrypted messages (respecting `visible_from_epoch`).
7. Client decrypts: link private key → unwrap epoch key from epochMembers wrap → messages. Chain link traversal for older epochs works identically to account members.

### Link Revocation

Revoking a link triggers lazy epoch rotation, same as removing any member. The link's virtual member is removed from the next epoch's wraps. Server sets `revokedAt` on the `sharedLinks` row, sets `leftAt` on the `conversationMembers` row, inserts a `pendingRemovals` row, and sets `rotationPending = true` on the conversation. No expiry support — links are valid until explicitly revoked. Expiry can be added later.

### Guest Messaging via Links

If a link has write privilege and the owner's budget allows it:
- Guest sends plaintext to server.
- Server debits owner's wallets (within budget limits), creates usage_record and ledger_entries.
- `payerId = owner`. `senderId = null`. `senderDisplayName` = whatever name the guest entered.
- Message is encrypted and stored normally.

---

## Part 8: Individual Message Sharing

Sharing a single message is cryptographically isolated from the conversation.

### Share Flow

1. Client decrypts the target message using the epoch key chain.
2. Generates a random 256-bit `share_secret`.
3. Derives key pair: `share_keypair = X25519_FromSeed(HKDF(share_secret, info="share-msg-v1"))`.
4. Encrypts: `share_blob = ECIES_Encrypt(share_keypair.public, plaintext_message)`.
5. Sends to server: share_blob, original_message_id. Server creates `sharedMessages` row, returns share_id.
6. URL: `https://app.com/m/{share_id}#{share_secret_base64url}`

The share_secret is random and unrelated to any conversation key, epoch key, or account key. Possessing it reveals exactly one message. Even if the same message is shared twice, each share has a different secret and blob.

---

## Part 9: Budget System

### Schema Design

On the conversations table: one column `perPersonBudget` (nullable NUMERIC(20,8)). If non-null, this value applies to every non-owner member. If null, individual budgets are looked up in `memberBudgets`.

Separate `memberBudgets` table: per-member rows keyed to `conversationMembers.id`. Works for both authenticated users and guest links (since both are `conversationMembers` rows). No row means zero budget for that member.

Separate column `conversationBudget` on conversations (nullable NUMERIC(20,8)): total cap across all members. Checked in addition to per-person budget. Tracked via `conversationSpending.totalSpent`.

All `spent` and `totalSpent` counters are cached values, updated atomically in the same transaction as the `usage_record` and `ledger_entries` inserts. They are reconcilable from the source-of-truth records at any time.

### Payment Logic (Server-Side)

```
When member M sends a message in conversation C owned by O:
  0. Look up M's conversationMembers row for this conversation.
  1. AI completes. Compute cost from token/resource usage.
  2. If M is the owner:
       Debit O's wallets (priority order). payer = O.
  3. Else:
       Determine M's budget:
         If conversations.perPersonBudget IS NOT NULL → use that value
         Else if memberBudgets row exists for M's conversationMembers.id → use row.budget
         Else → budget is 0
       If budget > spent AND (conversationBudget IS NULL OR conversationBudget > totalSpent):
         Debit O's wallets (priority order). payer = O.
         Increment memberBudgets.spent and conversationSpending.totalSpent.
       Else if M is an authenticated user (not a guest link):
         Debit M's wallets (priority order). payer = M.
       Else (guest link with exhausted budget):
         Reject the message. Guests have no wallets to fall back to.
  4. Create usage_record (sourceType = 'message', sourceId = message.id).
  5. Create ledger_entries for each wallet debited.
  6. Store payerId in message metadata.
  All in one database transaction.
```

### Guest Spending via Links

Guests via write-enabled links have a `conversationMembers` row (with `linkId` set, `userId` null) and therefore can have a `memberBudgets` row. Budget enforcement is identical to authenticated users: look up the `conversationMembers` row for the link, check `memberBudgets.spent` against `perPersonBudget`, check `conversationSpending.totalSpent` against `conversationBudget`. `payerId = owner`. `senderId = null`. `senderDisplayName = guest's input name`.

### Concurrency

The existing Redis-based speculative budget enforcement system must be expanded to group conversations. Before the database transaction, speculatively reserve budget in Redis against both the per-member cap and the conversation-wide cap. This prevents two simultaneous sends from overshooting. Redis is the fast-path gate; the database counters are the source of truth reconciled after commit.

### Display

Each message in the UI shows: content (decrypted), sender name, cost (from usage_records), and "paid by [username]" (resolved from payerId).

---

## Part 10: Communication Architecture

### Overview

```
Client (React)
  │
  ├── Hono RPC (typed HTTP) ────► Cloudflare Worker (apps/api)
  │     All request-response           │
  │     operations                     ├── PostgreSQL
  │                                    ├── Redis (cache, rate limit, sessions)
  │                                    └── AI Provider
  │
  ├── SSE (POST /api/chat) ────► Cloudflare Worker (apps/api)
  │     Individual + group chat         Encrypts, bills, streams AI tokens,
  │     streaming                       commits atomically on completion
  │
  └── WebSocket ─────────────► Durable Object (packages/realtime)
        Group chat real-time only       Per-conversation instance
                                        Pure broadcast hub

Payment Processor ──webhook──► Cloudflare Worker (apps/api, plain Hono route)
```

### Hono RPC Layer

All structured request-response operations are plain Hono routes. Type safety comes from Hono's built-in RPC mode: the server defines typed routes with Zod validation, and the client uses `hc<AppType>()` to get a fully typed client. No code generation, no second framework.

Server setup:

```
Hono app
  ├── /api/auth/*         →  OPAQUE auth routes (multi-step, Set-Cookie)
  ├── /api/chat           →  POST, SSE streaming (authenticated + linkGuest)
  ├── /api/trial          →  POST, SSE streaming (anonymous, no persistence)
  ├── /api/ws/:id         →  WebSocket upgrade to Durable Object
  ├── /api/webhooks/*     →  Payment processor callbacks
  └── /api/*              →  All other routes (conversations, keys, members, links, billing, etc.)
```

Client setup:

```typescript
// apps/web/src/lib/api-client.ts
import { hc } from 'hono/client'
import type { AppType } from '@lome-chat/api'

export const client = hc<AppType>(getApiUrl(), { init: { credentials: 'include' } })

// Usage — fully typed, compile error if schema changes:
const conversations = await client.api.conversations.$get()
const result = await client.api.keys.submitRotation.$post({ json: rotationData })
```

#### Route Structure

```
/api
├── auth
│   ├── register/init, register/finish
│   ├── login/init, login/finish
│   ├── verify-2fa
│   ├── logout
│   ├── me
│   └── recovery/*
├── account
│   ├── profile (GET, PATCH)
│   ├── change-password/*
│   ├── regenerate-recovery (POST)
│   └── delete (POST)
├── conversations
│   ├── / (GET list, POST create)
│   ├── /:id (GET, DELETE)
│   ├── /:id/settings (PATCH)
│   └── /:id/project (PATCH)
├── projects
│   ├── / (GET list, POST create)
│   ├── /:id (PATCH, DELETE)
├── members
│   ├── /:conversationId (GET list)
│   ├── /:conversationId/add (POST)
│   ├── /:conversationId/remove (POST)
│   ├── /:conversationId/leave (POST)
│   └── /:conversationId/privilege (PATCH)
├── links
│   ├── /:conversationId (GET list, POST create)
│   └── /:conversationId/revoke (POST)
├── keys
│   ├── /:conversationId/wraps (GET)
│   ├── /:conversationId/chain-links (GET)
│   ├── /:conversationId/rotation (POST)
│   └── /:conversationId/member-keys (GET)
├── messages
│   ├── /:conversationId (GET history)
│   ├── /:conversationId/delete (POST)
│   ├── /share (POST create)
│   └── /share/:shareId (GET)
├── budget
│   ├── /:conversationId (GET)
│   └── /:conversationId (PATCH)
├── billing
│   ├── /balance (GET)
│   ├── /transactions (GET)
│   ├── /payment (POST create)
│   ├── /payment/:id/process (POST)
│   └── /payment/:id/status (GET)
├── link-guest
│   ├── /access (POST) — validate link, return epoch wraps + messages + wsToken
│   └── /send (POST) — send via link with owner's budget
├── trial (POST) — anonymous chat, SSE streaming, no persistence
├── chat (POST) — authenticated + linkGuest, SSE streaming, persistent
├── ws/:conversationId — WebSocket upgrade
└── webhooks/payments — Helcim callback
```

### Streaming Architecture

**Individual chats** use a single `POST /api/chat` request that returns an SSE stream. One request sends the message, streams AI tokens back, and commits everything atomically on completion. No WebSocket, no Durable Object.

**Group chats** use the same `POST /api/chat` for the sending member's stream. Additionally, a per-conversation Durable Object maintains WebSocket connections for broadcasting to other members (new messages, typing indicators, presence, rotation notifications).

**Anonymous trial** uses `POST /api/trial`. Rate-limited via Redis, streams AI response, discards everything on completion. No encryption, no billing, no persistence.

Both `/api/chat` and `/api/trial` call the same `streamAICompletion(model, messages, onToken)` helper internally. The routes diverge on everything before and after that call.

### Durable Object + WebSocket Layer (Group Chats Only)

One Durable Object instance per group conversation. All members of a group connect their WebSocket to the same DO. The DO is a pure broadcast hub — it holds no encryption keys, no message content, no business logic beyond fan-out. Individual conversations do not use DOs.

#### Events the DO Broadcasts

| Event | Payload | Trigger |
|---|---|---|
| `message:new` | encrypted blob + metadata | User message stored |
| `message:stream` | plaintext token | AI generating (ephemeral) |
| `message:complete` | encrypted blob + metadata | AI response stored |
| `message:deleted` | message_id | Message hard-deleted |
| `member:added` | member_id, privilege | New member added |
| `member:removed` | member_id | Member removed |
| `rotation:pending` | (empty) | Tells next sender to rotate |
| `rotation:complete` | new_epoch_number | Clients re-fetch keys |
| `typing:start` | member_id | Ephemeral, never stored |
| `typing:stop` | member_id | Ephemeral, never stored |
| `presence:update` | member_id, status | Ephemeral, never stored |

#### Communication Flow: API Worker → Durable Object

The API Worker calls the DO via a Durable Object binding (stub). The DO is not called directly by clients for mutations — only for WebSocket connections and ephemeral events (typing, presence). All state-changing operations go through Hono routes, and the API Worker notifies the DO after committing changes.

#### Message Send Flow (Detailed)

**Individual chat (no DO):**

1. Client sends `POST /api/chat` with plaintext, conversation_id, model.
2. Server validates auth, checks write permission, checks budget.
3. Server checks `rotation_pending`. If true, returns error — client performs rotation via `POST /api/keys/:id/rotation`, then resubmits.
4. Server fetches current epoch public key, encrypts user message via ECIES.
5. Server invokes AI with plaintext, streams tokens back as SSE events.
6. On AI completion: single atomic transaction — encrypt AI response, store both messages, charge billing.
7. Final SSE event confirms committed message IDs + metadata.
8. Stream closes. Server discards all plaintext.

**Group chat (with DO):**

1. Client sends `POST /api/chat` with plaintext, conversation_id, model.
   2–3. Same validation and rotation check as individual.
4. Server encrypts user message, notifies DO with encrypted blob. DO broadcasts `message:new` to other connected members.
5. Server invokes AI, streams tokens. Each token batch sent to DO for `message:stream` broadcast.
6. On AI completion: single atomic transaction — same as individual.
7. Server sends final blob to DO. DO broadcasts `message:complete`.
8. SSE stream to the sending client closes. Other members receive the final message via WebSocket.

#### Concurrency

No lock on normal message sends — they all use the same epoch public key, and ECIES generates a fresh ephemeral key per operation. Concurrent sends are safe. The server assigns message ordering (timestamp or sequence number).

Lock only during epoch rotation. If two clients simultaneously detect `rotation_pending` and attempt to rotate, the server uses first-write-wins. The second client's rotation is rejected; it re-fetches the new epoch and re-encrypts its message under the new key.

### Webhook

The payment processor webhook is a plain Hono POST route. It verifies the webhook signature (processor-specific), creates a `ledger_entries` row with `entryType = 'deposit'` and credits the user's `purchased` wallet balance atomically, and returns 200. If the payment affects an active conversation, optionally notify the conversation's DO to refresh budget state.

### What Redis Is Used For

| Purpose | Why Redis, Not DO? |
|---|---|
| Rate limiting | Global across all Workers, not per-conversation |
| Session tokens | Shared state across all Worker instances |
| Cache (user profiles, public keys) | Avoid DB round-trips for frequently accessed data |
| Budget enforcement cache | Hot path during message sends |

Redis is for cross-request, cross-conversation shared state. DOs are for per-conversation real-time coordination.

---

## Part 11: Package Structure

```
packages/
  crypto/          ← All cryptographic operations. The ONLY package that imports @noble/*, hash-wasm, @scure/bip39, @cloudflare/opaque-ts (client-side)
  db/              ← Database schema, queries, migrations
  realtime/        ← Durable Object class + WebSocket handling. No crypto imports.
apps/
  api/             ← Hono routes + Hono RPC typed exports + webhook. Imports @cloudflare/opaque-ts (server-side), iron-session, otplib. Re-exports DO class from packages/realtime.
  web/             ← React frontend. Imports packages/crypto as a dependency.
```

### Crypto Package API Design

The crypto package must expose methods with names so explicit that misuse is impossible. Non-crypto code should never perform any cryptographic operation — it calls a method that describes the exact use case.

Examples of the kinds of method names the crypto package should expose (these are illustrative, not prescriptive — adapt to the codebase's conventions):

**Account operations:**
- `createAccount()` → returns { publicKey, passwordWrappedBlob, recoveryWrappedBlob, mnemonic }
- `loginUnwrapAccountKey(exportKey, passwordWrappedBlob)` → returns accountPrivateKey
- `recoverAccountFromMnemonic(mnemonic, recoveryWrappedBlob)` → returns accountPrivateKey
- `rewrapAccountKeyForPasswordChange(accountPrivateKey, newExportKey)` → returns newPasswordWrappedBlob
- `regenerateRecoveryPhrase(accountPrivateKey)` → returns { mnemonic, recoveryWrappedBlob }

**Epoch operations:**
- `createFirstEpochForConversation(memberPublicKeys[])` → returns { epochPublicKey, confirmationHash, memberWraps[] }
- `performEpochRotation(oldEpochPrivateKey, remainingMemberPublicKeys[])` → returns { newEpochPublicKey, confirmationHash, memberWraps[], chainLink }
- `unwrapEpochKey(accountPrivateKey, memberWrap)` → returns epochPrivateKey
- `traverseChainLink(newerEpochPrivateKey, chainLinkBlob)` → returns olderEpochPrivateKey
- `verifyEpochKeyConfirmation(epochPrivateKey, expectedHash)` → returns boolean

**Message operations (server-side):**
- `encryptMessageForStorage(epochPublicKey, plaintext)` → returns encryptedBlob
- `decryptMessage(epochPrivateKey, encryptedBlob)` → returns plaintext

**Member operations:**
- `wrapEpochKeyForNewMember(epochPrivateKey, newMemberPublicKey)` → returns memberWrap

**Link operations:**
- `createSharedLink(epochPrivateKey)` → returns { linkSecret, linkPublicKey, memberWrap }
- `deriveKeysFromLinkSecret(linkSecret)` → returns linkKeyPair
- `accessConversationViaLink(linkSecret, memberWrap, chainLinks[], encryptedMessages[])` → returns decryptedMessages[]

**Message sharing:**
- `createMessageShare(plaintext)` → returns { shareSecret, shareBlob }
- `decryptMessageShare(shareSecret, shareBlob)` → returns plaintext

The key principle: a developer in `apps/api` or `apps/web` should never need to know what X25519, ECIES, HKDF, or XChaCha20 are. They call `encryptMessageForStorage()` and get a blob. They call `performEpochRotation()` and get everything they need to send to the server. The crypto package is the only place where algorithm-level code lives.

---

## Part 12: Hono RPC Typed Client

### Why Hono RPC Instead of tRPC

Hono has a built-in RPC mode that provides end-to-end TypeScript type safety without a second framework. The server defines routes with Zod validation as it already does. The client uses `hc<AppType>()` to get a fully typed client inferred from the route definitions. Compile-time errors if the server contract changes.

This eliminates the split between "tRPC routes" and "plain Hono routes." Every route in the app — auth, chat streaming, webhooks, CRUD — is a Hono route with the same middleware, same context, same patterns. The typed client covers all of them.

### Packages

| Package | Where | Purpose |
|---|---|---|
| `hono` | apps/api | Already installed — server framework |
| `hono/client` | apps/web | Typed RPC client (ships with `hono`, zero additional dependencies) |
| `@hono/zod-validator` | apps/api | Zod-based input validation middleware |
| `@tanstack/react-query` | apps/web | Already installed — caching, revalidation, loading states |

No new dependencies beyond `@hono/zod-validator`. `hono/client` is a subpath export of the existing `hono` package.

### Server Setup

```typescript
// apps/api/src/routes/conversations.ts
const conversations = new Hono<AppEnv>()
  .get('/', sessionRequired, async (c) => {
    const conversations = await listConversations(c.var.db, c.var.user.id)
    return c.json(conversations)
  })
  .post('/', sessionRequired, zValidator('json', createConversationSchema), async (c) => {
    const input = c.req.valid('json')
    const conversation = await createConversation(c.var.db, c.var.user.id, input)
    return c.json(conversation)
  })

export { conversations }

// apps/api/src/app.ts
const app = new Hono<AppEnv>()
  .use('*', csrfProtection, dbMiddleware, redisMiddleware, sessionMiddleware)
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
  .post('/api/trial', rateLimited('trial', { windowMs: 60000, max: 5 }), trialHandler)
  .get('/api/ws/:conversationId', wsUpgradeHandler)
  .post('/api/webhooks/payments', webhookHandler)

export type AppType = typeof app
```

### Client Setup

```typescript
// apps/web/src/lib/api-client.ts
import { hc } from 'hono/client'
import type { AppType } from '@lome-chat/api'

export const client = hc<AppType>(getApiUrl(), {
  init: { credentials: 'include' }
})
```

### React Query Integration

Wrap Hono RPC calls in TanStack React Query hooks for caching, revalidation, and loading states:

```typescript
// apps/web/src/hooks/use-conversations.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { client } from '../lib/api-client'

export function useConversations() {
  return useQuery({
    queryKey: ['conversations'],
    queryFn: () => client.api.conversations.$get().then(r => r.json()),
  })
}

export function useCreateConversation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input) => client.api.conversations.$post({ json: input }).then(r => r.json()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['conversations'] }),
  })
}
```

### What Changes, What Doesn't

| Aspect | Before (REST) | After (Hono RPC) |
|---|---|---|
| Server handler logic | Same | Same |
| Input validation | Manual or middleware | `zValidator('json', schema)` |
| Response typing | Manual interfaces | Inferred from `c.json()` return type |
| Client calls | `fetch()` + manual typing | `client.api.route.$method()` (typed) |
| Error handling | HTTP status codes | HTTP status codes (unchanged) |
| Auth middleware | Hono middleware | Hono middleware (unchanged) |
| Streaming routes | Hono SSE | Hono SSE (unchanged) |
| Webhook | Hono route | Hono route (unchanged) |

### Migration Steps

1. **Add `@hono/zod-validator` to apps/api.** This is the only new dependency.
2. **Restructure routes with chained syntax.** Hono RPC infers types from the chained `.get()/.post()` calls. Restructure existing route files to use this pattern instead of `app.get('/path', handler)`.
3. **Export `AppType` from apps/api.** The barrel export that the client imports for type inference.
4. **Create `api-client.ts` in apps/web.** One `hc<AppType>()` call, used everywhere.
5. **Wrap in React Query hooks.** Replace manual `useEffect` + `fetch` patterns with `useQuery`/`useMutation` wrappers around the typed client. This gives automatic caching, revalidation, loading states, and optimistic updates.
6. **Migrate one route file at a time.** The chained syntax is the only change — handler logic stays identical.

---

## Part 13: Durable Object Setup for Local Development

### Wrangler Configuration

The Durable Object class must be registered in the wrangler configuration for the API Worker. The DO binding allows the API Worker to get a stub and call the DO.

```
[durable_objects]
bindings = [
  { name = "CONVERSATION_ROOM", class_name = "ConversationRoom" }
]

[[migrations]]
tag = "v1"
new_classes = ["ConversationRoom"]
```

The API Worker's entry point must re-export the DO class from `packages/realtime` so Cloudflare can find it.

### Local Development

`wrangler dev` supports Durable Objects locally. When running the API Worker in dev mode, DOs are instantiated in-process. WebSocket connections work over localhost. No special setup beyond the wrangler configuration.

For the frontend development server (Vite or similar), configure the WebSocket proxy to forward `/ws/*` to the local Worker's WebSocket upgrade endpoint.

Test the full flow locally: client opens WebSocket → Worker upgrades → routes to DO → DO accepts connection. Client sends `POST /api/chat` → Worker processes → notifies DO → DO broadcasts to WebSocket → client receives.

### Durable Object Design Principles

The DO is a pure broadcast hub. It must NOT:
- Access the database directly
- Perform any cryptographic operations
- Hold any encryption keys
- Store any message content
- Implement any business logic beyond connection management and fan-out

The DO SHOULD:
- Maintain a map of connected WebSockets (member_id → socket)
- Track ephemeral state (typing indicators, presence)
- Accept events from the API Worker (via HTTP fetch on the DO stub) and broadcast to connected sockets
- Handle WebSocket lifecycle (open, close, error, reconnect)
- Use Durable Object Hibernation to reduce costs when a conversation has connected clients but no activity

The DO receives events from two sources:
1. **API Worker** (via stub fetch): message:new, message:complete, message:deleted, member changes, rotation events. These are the result of Hono route handlers that the API Worker has already processed and committed to the database.
2. **Client WebSockets** (via WebSocket messages): typing:start, typing:stop, presence:update. These are ephemeral and never touch the database or API Worker.

---

## Part 14: Complete Database Schema

This is the authoritative schema for the entire application. Every table, every column, every constraint, every index. The developer's execution plan should produce exactly this schema (adapted to Drizzle ORM conventions where appropriate).

### Design Principles

**Cached counters are updated atomically with their source-of-truth records.** `wallets.balance` is updated in the same transaction as the `ledger_entries` insert. `memberBudgets.spent` is updated in the same transaction as the `usage_records` insert. `conversationSpending.totalSpent` likewise. These cached values are performance optimizations on hot paths. The source-of-truth records (`ledger_entries`, `usage_records`) always exist for reconciliation and audit. Drift is impossible because cache + source-of-truth commit in the same transaction.

**Target database: PostgreSQL 18.** This unlocks UUIDv7, async I/O, skip scan, and OR clause index optimization out of the box.

**All IDs are UUIDv7**, generated in PostgreSQL via `DEFAULT uuidv7()`. UUIDv7 embeds a timestamp, so IDs are naturally time-ordered. This improves B-tree index performance (inserts append to the right side instead of scattering randomly) and cache locality (recent rows are physically adjacent). IDs are generated by the database, not in application code.

**All monetary values use `NUMERIC(20,8)`** for precision without floating point errors.

**Individual (non-group) conversations are the same as group conversations with one member.** There is no separate concept of a "solo" conversation. The owner is the sole member.

**No scheduled expiry on anything.** No `expiresAt` on links, wallets, or shared messages. Links are valid until explicitly revoked. This avoids the need for cleanup jobs, cron triggers, or scheduled workers. Expiry support can be added later.

**Free tier restrictions are server-enforced, not schema-enforced.** The wallet `type` field tells the server which models and features are allowed. Restriction logic lives in application code, not in the database schema.

**ON DELETE behavior is CASCADE for all conversation-scoped data, except financial records.** When a conversation is deleted (owner leaves), all messages, epochs, epochMembers, conversationMembers, pendingRemovals, memberBudgets, conversationSpending, and sharedLinks are cascade-deleted. Financial records (`wallets`, `ledger_entries`, `usage_records`, `payments`) are NEVER cascade-deleted — their `userId` is set to NULL, preserving the complete audit trail. When a message is hard-deleted, its `sharedMessages` rows cascade-delete too. When a user account is deleted, their owned conversations cascade-delete (which cascades all conversation-scoped data), their projects cascade-delete (encrypted, useless without the user's key), and their non-owner `conversationMembers` rows have `userId` set to NULL.

Cascade map:

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
└── pendingRemovals (requestedBy)        ON DELETE SET NULL (audit preserved)

Financial records (PRESERVED on user deletion):
├── wallets.userId                       ON DELETE SET NULL
│   └── ledger_entries.walletId          ON DELETE CASCADE (only if wallet is deleted)
├── usage_records.userId                 ON DELETE SET NULL
│   └── llmCompletions.usageRecordId     ON DELETE CASCADE
└── payments.userId                      ON DELETE SET NULL

Other:
└── conversations.projectId              ON DELETE SET NULL (conversations become unfiled)
```

Key rules: Deleting a conversation cascades everything conversation-scoped. Deleting a message cascades its `sharedMessages`. Deleting a user preserves all financial records (userId set NULL), cascades owned conversations and projects, and sets NULL on non-owner `conversationMembers` rows (application logic must set `leftAt = NOW()` before deletion to trigger lazy rotations). `pendingRemovals.requestedBy` uses SET NULL so the audit trail survives admin account deletion.

**Budget enforcement uses the existing Redis-based speculative budget system.** The codebase already has a Redis-based speculative balance check that prevents race conditions on concurrent charges. This system should be extended to cover group conversation budgets: `perPersonBudget` checks via `memberBudgets.spent`, and `conversationBudget` checks via `conversationSpending.totalSpent`. Redis provides the speculative lock; the database transaction provides the authoritative commit. The PostgreSQL cached counters are the source of truth after commit; Redis is the optimistic guard before commit. No `SELECT ... FOR UPDATE` needed — the existing Redis pattern handles concurrency.

---

### users

Account identity, authentication credentials, and encrypted key material.

```
┌───────────────────────────┬─────────────────┬──────────┬─────────────────────┐
│          Column           │      Type       │ Nullable │       Default       │
├───────────────────────────┼─────────────────┼──────────┼─────────────────────┤
│ id                        │ text (UUID)     │ NOT NULL │ uuidv7() │
│ email                     │ text            │ NOT NULL │ —                   │
│ username                  │ text            │ NOT NULL │ —                   │
│ emailVerified             │ boolean         │ NOT NULL │ false               │
│ emailVerifyToken          │ text            │ NULLABLE │ —                   │
│ emailVerifyExpires        │ timestamp w/ TZ │ NULLABLE │ —                   │
│ opaqueRegistration        │ bytea           │ NOT NULL │ —                   │
│ publicKey                 │ bytea           │ NOT NULL │ —                   │
│ passwordWrappedPrivateKey │ bytea           │ NOT NULL │ —                   │
│ recoveryWrappedPrivateKey │ bytea           │ NOT NULL │ —                   │
│ totpSecretEncrypted       │ bytea           │ NULLABLE │ —                   │
│ totpEnabled               │ boolean         │ NOT NULL │ false               │
│ hasAcknowledgedPhrase     │ boolean         │ NOT NULL │ false               │
│ createdAt                 │ timestamp w/ TZ │ NOT NULL │ NOW()               │
│ updatedAt                 │ timestamp w/ TZ │ NOT NULL │ NOW()               │
└───────────────────────────┴─────────────────┴──────────┴─────────────────────┘
PK: id
UNIQUE: email, username
```

**Notes:**
- `publicKey`: 32-byte X25519 public key, stored plaintext. Used by other members to wrap epoch keys for this user.
- `passwordWrappedPrivateKey`: ~81-byte ECIES blob. Account private key encrypted under the wrapping key pair derived from the OPAQUE export key. NOT NULL — both wraps are generated atomically during registration.
- `recoveryWrappedPrivateKey`: ~81-byte ECIES blob. Account private key encrypted under the recovery key pair derived from the BIP-39 mnemonic seed via Argon2id. NOT NULL — same reason.
- `totpSecretEncrypted`: XChaCha20-Poly1305 blob with 24-byte nonce prepended. The old `totpIv` column is dropped — the nonce is inside the blob.
- `hasAcknowledgedPhrase`: UI gate for showing the "save your recovery phrase" prompt. Set to `false` on registration and on recovery phrase regeneration.
- `balance`, `freeAllowanceCents`, `freeAllowanceResetAt` are removed. Replaced by the `wallets` table.

---

### wallets

Multi-source credit system. Each user has one or more wallets debited in priority order.

```
┌─────────────────┬─────────────────┬──────────┬─────────────────────┐
│     Column      │      Type       │ Nullable │       Default       │
├─────────────────┼─────────────────┼──────────┼─────────────────────┤
│ id              │ text (UUID)     │ NOT NULL │ uuidv7() │
│ userId          │ text (FK→users) │ NULLABLE │ —                   │
│ type            │ text            │ NOT NULL │ —                   │
│ balance         │ numeric(20,8)   │ NOT NULL │ 0                   │
│ priority        │ integer         │ NOT NULL │ —                   │
│ createdAt       │ timestamp w/ TZ │ NOT NULL │ NOW()               │
└─────────────────┴─────────────────┴──────────┴─────────────────────┘
PK: id
FK: userId → users(id) ON DELETE SET NULL
INDEX: wallets(userId)
```

**Notes:**
- `type`: Discriminator string. Initial types: `purchased` (priority 0, full access to all models/features), `free_tier` (priority 1, restricted models/features). Future types added by creating rows, never schema changes: `promotional`, `referral`, `enterprise`, `compensation`.
- `priority`: Lower number = debited first. Purchased balance (priority 0) is consumed before free tier (priority 1) because purchased grants full access while free tier has restrictions. The user stays in "full access" as long as purchased balance remains.
- `balance`: Cached counter. Updated atomically in the same transaction as the corresponding `ledger_entries` insert. Source of truth for reconciliation is `SUM(amount) FROM ledger_entries WHERE walletId = ?`.
- On signup, two wallets are created: `{ type: 'purchased', balance: WELCOME_CREDIT, priority: 0 }` and `{ type: 'free_tier', balance: FREE_ALLOWANCE, priority: 1 }`.
- Free tier renewal is application logic, not scheduled. On relevant actions (login, message send), check if the free tier wallet qualifies for a top-up based on elapsed time. No `renewsAt` column, no cron job.
- When charging: query wallets ordered by priority, debit from the first wallet with sufficient balance. If no single wallet covers the cost, split across wallets in priority order. If total available across all wallets is insufficient, reject the operation.
- Wallet type determines feature access. Server checks wallet type before allowing an operation (e.g., free_tier wallet cannot use premium models). This logic is in application code, not the schema.

---

### ledger_entries

Append-only financial audit trail. Every movement of money is recorded here.

```
┌─────────────────┬──────────────────────────┬──────────┬─────────────────────┐
│     Column      │          Type            │ Nullable │       Default       │
├─────────────────┼──────────────────────────┼──────────┼─────────────────────┤
│ id              │ text (UUID)              │ NOT NULL │ uuidv7() │
│ walletId        │ text (FK→wallets)        │ NOT NULL │ —                   │
│ amount          │ numeric(20,8)            │ NOT NULL │ —                   │
│ balanceAfter    │ numeric(20,8)            │ NOT NULL │ —                   │
│ entryType       │ text                     │ NOT NULL │ —                   │
│ paymentId       │ text (FK→payments)       │ NULLABLE │ —                   │
│ usageRecordId   │ text (FK→usage_records)  │ NULLABLE │ —                   │
│ sourceWalletId  │ text (FK→wallets)        │ NULLABLE │ —                   │
│ createdAt       │ timestamp w/ TZ          │ NOT NULL │ NOW()               │
└─────────────────┴──────────────────────────┴──────────┴─────────────────────┘
PK: id
FK: walletId → wallets(id) ON DELETE CASCADE
FK: paymentId → payments(id) ON DELETE SET NULL
FK: usageRecordId → usage_records(id) ON DELETE SET NULL
FK: sourceWalletId → wallets(id) ON DELETE SET NULL
CHECK: exactly one of (paymentId, usageRecordId, sourceWalletId) IS NOT NULL
INDEX: ledger_entries(walletId, createdAt)
INDEX: ledger_entries(usageRecordId) WHERE usageRecordId IS NOT NULL
```

**Notes:**
- `amount`: Positive = credit (deposit, refund, renewal, welcome credit). Negative = debit (usage charge).
- `balanceAfter`: The wallet's balance after this entry. Enables point-in-time balance reconstruction without aggregation.
- `entryType`: `deposit`, `usage_charge`, `refund`, `adjustment`, `renewal`, `welcome_credit`.
- Three nullable FK columns replace the old polymorphic `referenceType + referenceId` pattern. Exactly one must be non-null (enforced by CHECK constraint). Full referential integrity — no typos, no orphaned references:
    - `paymentId`: Set for `deposit` entries (user added funds).
    - `usageRecordId`: Set for `usage_charge` and `refund` entries (AI operation charged or refunded).
    - `sourceWalletId`: Set for `renewal`, `welcome_credit`, and `adjustment` entries (internal money creation/movement — the wallet itself is the reason).
- This is a stable set of three categories: money comes in (payment), money goes out (usage), money is created/adjusted internally (wallet). There is no realistic fourth category.
- One usage record can produce multiple ledger entries over its lifetime: the original `usage_charge` and a later `refund`. This is a normal one-to-many relationship via `usageRecordId`.
- This table is append-only. Rows are never updated or deleted. Corrections are made by inserting new entries (e.g., a refund is a positive `refund` entry, not a deletion of the original charge).
- Cost is never split across wallets. One charge = one wallet = one ledger entry.

---

### usage_records

Immutable facts about AI operations. Parent table with common fields. Type-specific details live in child tables (class table inheritance).

```
┌──────────────┬─────────────────┬──────────┬─────────────────────┐
│    Column    │      Type       │ Nullable │       Default       │
├──────────────┼─────────────────┼──────────┼─────────────────────┤
│ id           │ text (UUID)     │ NOT NULL │ uuidv7() │
│ userId       │ text (FK→users) │ NULLABLE │ —                   │
│ type         │ text            │ NOT NULL │ —                   │
│ status       │ text            │ NOT NULL │ 'pending'           │
│ cost         │ numeric(20,8)   │ NOT NULL │ 0                   │
│ sourceType   │ text            │ NULLABLE │ —                   │
│ sourceId     │ text            │ NULLABLE │ —                   │
│ createdAt    │ timestamp w/ TZ │ NOT NULL │ NOW()               │
│ completedAt  │ timestamp w/ TZ │ NULLABLE │ —                   │
└──────────────┴─────────────────┴──────────┴─────────────────────┘
PK: id
FK: userId → users(id) ON DELETE SET NULL
INDEX: usage_records(userId, type, createdAt)
INDEX: usage_records(sourceType, sourceId)
```

**Notes:**
- `type`: Discriminator telling you which child table holds the details. Initial type: `llm_completion`. Future types: `image_generation`, `video_generation`, `tts`, `stt`, `code_execution`. Adding a new AI capability = one new child table, zero changes to this table or any existing child table.
- `status`: `pending` → `completed` or `failed`. Failed operations with `cost > 0` can trigger automatic refund ledger entries.
- `sourceType` + `sourceId`: Polymorphic reference to what triggered the operation. `sourceType = 'message'`, `sourceId = message.id` for chat operations. `sourceType = 'standalone'` for direct generations not tied to chat. A single message can have multiple usage records (e.g., text response + image generation in one reply).
- `cost`: Computed by the server based on the operation's token/resource usage and current pricing. Stored as the computed value at the time of the operation. Pricing changes don't retroactively affect historical records.
- Replaces the old `balanceTransactions` table. The old `inputCharacters`, `outputCharacters`, `model`, `deductionSource` columns now live in child tables or are tracked via `ledger_entries` (which wallet was debited).
- **Hot-path queries only touch this parent table.** "What did this cost?" and "user's spending this month" never need child table joins. Child tables are joined only for detail views (receipts, admin dashboards).

---

### llmCompletions

Child table for `usage_records` where `type = 'llm_completion'`. Stores LLM-specific operation details.

```
┌────────────────┬──────────────────────────┬──────────┬─────────────────────┐
│     Column     │          Type            │ Nullable │       Default       │
├────────────────┼──────────────────────────┼──────────┼─────────────────────┤
│ id             │ text (UUID)              │ NOT NULL │ uuidv7() │
│ usageRecordId  │ text (FK→usage_records)  │ NOT NULL │ —                   │
│ model          │ text                     │ NOT NULL │ —                   │
│ provider       │ text                     │ NOT NULL │ —                   │
│ inputTokens    │ integer                  │ NOT NULL │ —                   │
│ outputTokens   │ integer                  │ NOT NULL │ —                   │
│ cachedTokens   │ integer                  │ NOT NULL │ 0                   │
└────────────────┴──────────────────────────┴──────────┴─────────────────────┘
PK: id
FK: usageRecordId → usage_records(id) ON DELETE CASCADE
UNIQUE: usageRecordId
INDEX: llmCompletions(model)
```

**Notes:**
- Every column is NOT NULL, properly typed, indexable, and self-documenting. No JSONB parsing, no Zod runtime validation needed.
- `usageRecordId` is UNIQUE — one-to-one with the parent record. The FK is the join path: `SELECT * FROM usage_records JOIN llmCompletions USING (usageRecordId) WHERE ...`.
- `model`: e.g., `claude-sonnet-4-20250514`. Indexed for "cost by model" analytics.
- `provider`: e.g., `anthropic`. Supports future multi-provider routing.
- `cachedTokens`: Tokens served from prompt cache. Default 0.
- ON DELETE CASCADE: if the parent usage record is deleted (account deletion), the child goes with it.
- **Future child tables follow the same pattern.** Each new AI capability gets its own table with properly typed, NOT NULL columns:
    - `imageGenerations`: `usageRecordId, model, resolution, count, style, seed`
    - `videoGenerations`: `usageRecordId, model, durationSeconds, resolution, fps`
    - `ttsGenerations`: `usageRecordId, model, voiceId, durationSeconds, characterCount`
    - Each is one migration creating one table. No changes to `usage_records` or existing child tables.

---

### projects

Folders for organizing conversations. Name and description are encrypted under the owner's account public key.

```
┌─────────────────────┬─────────────────┬──────────┬─────────────────────┐
│       Column        │      Type       │ Nullable │       Default       │
├─────────────────────┼─────────────────┼──────────┼─────────────────────┤
│ id                  │ text (UUID)     │ NOT NULL │ uuidv7() │
│ userId              │ text (FK→users) │ NOT NULL │ —                   │
│ encryptedName       │ bytea           │ NOT NULL │ —                   │
│ encryptedDescription│ bytea           │ NULLABLE │ —                   │
│ createdAt           │ timestamp w/ TZ │ NOT NULL │ NOW()               │
│ updatedAt           │ timestamp w/ TZ │ NOT NULL │ NOW()               │
└─────────────────────┴─────────────────┴──────────┴─────────────────────┘
PK: id
FK: userId → users(id) ON DELETE CASCADE
INDEX: projects(userId)
```

**Notes:**
- `encryptedName` and `encryptedDescription` are ECIES blobs encrypted under the user's account public key. The server cannot read folder names or descriptions. The client decrypts them alongside conversation titles.
- Since project metadata is encrypted, the server cannot sort by project name. Sorting and grouping happens client-side after decryption.
- Projects are single-owner. Group conversations belong to the conversation owner's project structure. Other members do not see the owner's project organization.

---

### conversations

A conversation is the same structure whether it has one member or many. Individual chats are conversations with a single member (the owner).

```
┌────────────────────┬─────────────────┬──────────┬─────────────────────┐
│       Column       │      Type       │ Nullable │       Default       │
├────────────────────┼─────────────────┼──────────┼─────────────────────┤
│ id                 │ text (UUID)     │ NOT NULL │ uuidv7() │
│ userId             │ text (FK→users) │ NOT NULL │ —                   │
│ projectId          │ text (FK→proj.) │ NULLABLE │ —                   │
│ title              │ bytea           │ NOT NULL │ —                   │
│ titleEpochNumber   │ integer         │ NOT NULL │ 1                   │
│ currentEpoch       │ integer         │ NOT NULL │ 1                   │
│ nextSequence       │ integer         │ NOT NULL │ 1                   │
│ rotationPending    │ boolean         │ NOT NULL │ false               │
│ perPersonBudget    │ numeric(20,8)   │ NULLABLE │ —                   │
│ conversationBudget │ numeric(20,8)   │ NULLABLE │ —                   │
│ createdAt          │ timestamp w/ TZ │ NOT NULL │ NOW()               │
│ updatedAt          │ timestamp w/ TZ │ NOT NULL │ NOW()               │
└────────────────────┴─────────────────┴──────────┴─────────────────────┘
PK: id
FK: userId → users(id) ON DELETE CASCADE
FK: projectId → projects(id) ON DELETE SET NULL
INDEX: conversations(userId)
INDEX: conversations(projectId) WHERE projectId IS NOT NULL
```

**Notes:**
- `userId`: The owner. FK to users. Owner leaving deletes the entire conversation (cascade).
- `projectId`: Nullable FK to projects. A conversation can be unfiled (no project). Users can organize later.
- `title`: ECIES blob encrypted under the epoch public key indicated by `titleEpochNumber`. Decrypted client-side the same way as messages — fetch epoch wrap, unwrap, decrypt. This means the conversation list page requires epoch key resolution for each conversation. Security over convenience.
- `titleEpochNumber`: Tracks which epoch key encrypts the title. On epoch rotation, the rotating client re-encrypts the title under the new epoch key and updates this field atomically with the rotation.
- `currentEpoch`: Points to the latest epoch number. Incremented on rotation.
- `nextSequence`: Counter for assigning deterministic message ordering. Incremented atomically via `UPDATE conversations SET nextSequence = nextSequence + 1 WHERE id = ? RETURNING nextSequence`. This is a row-level lock on only this conversation's row — no table-wide lock, zero contention across conversations. The conversations row is already read on every message send (to check `rotationPending` and `currentEpoch`), so this adds one atomic increment to an already-touched row.
- `rotationPending`: Set to `true` when a member is removed or a link is revoked. Cleared when the next write-capable member performs the rotation.
- `pendingRemovals` has been moved to a separate `pendingRemovals` table (see below) to avoid PostgreSQL array race conditions and enable audit trails.
- `isPublic`, `publicShareId`, `publicShareExpires` are removed. All link sharing is handled by the `sharedLinks` table.
- `perPersonBudget`: If non-null, this value applies to every non-owner member as their budget. If null, individual budgets are looked up in `memberBudgets`.
- `conversationBudget`: If non-null, total cap on owner spending across all members. Tracked via `conversationSpending`.

---

### pendingRemovals

Tracks members awaiting cryptographic removal via lazy epoch rotation. Replaces the `pendingRemovals TEXT[]` array column on conversations.

```
┌────────────────┬───────────────────────────────┬──────────┬─────────────────────┐
│     Column     │             Type              │ Nullable │       Default       │
├────────────────┼───────────────────────────────┼──────────┼─────────────────────┤
│ id             │ text (UUID)                   │ NOT NULL │ uuidv7() │
│ conversationId │ text (FK→conversations)       │ NOT NULL │ —                   │
│ memberId       │ text (FK→conversationMembers) │ NOT NULL │ —                   │
│ requestedBy    │ text (FK→users)               │ NULLABLE │ —                   │
│ createdAt      │ timestamp w/ TZ               │ NOT NULL │ NOW()               │
└────────────────┴───────────────────────────────┴──────────┴─────────────────────┘
PK: id
FK: conversationId → conversations(id) ON DELETE CASCADE
FK: memberId → conversationMembers(id) ON DELETE CASCADE
FK: requestedBy → users(id) ON DELETE SET NULL
INDEX: pendingRemovals(conversationId)
```

**Notes:**
- `memberId`: FK to `conversationMembers.id`. Since `conversationMembers` already unifies users and links, this provides proper referential integrity without polymorphic guessing.
- `requestedBy`: Who initiated the removal. NULL for voluntary leaves or link revocations triggered by the system. `ON DELETE SET NULL` because the audit trail should survive even if the requesting admin's account is later deleted.
- Rows are deleted atomically when the epoch rotation is committed. The rotating client fetches all pending removal IDs, excludes them from the new epoch's member wraps, and the server deletes these rows in the same transaction.
- Using a table instead of an array avoids race conditions when two admins remove different members simultaneously (each is a simple INSERT, no read-modify-write on an array column).

---

### conversationMembers

Application-layer membership. Answers "who is in this conversation?" without joining through crypto tables.

```
┌──────────────────┬─────────────────────────┬──────────┬─────────────────────┐
│      Column      │          Type           │ Nullable │       Default       │
├──────────────────┼─────────────────────────┼──────────┼─────────────────────┤
│ id               │ text (UUID)             │ NOT NULL │ uuidv7() │
│ conversationId   │ text (FK→conversations) │ NOT NULL │ —                   │
│ userId           │ text (FK→users)         │ NULLABLE │ —                   │
│ linkId           │ text (FK→sharedLinks)   │ NULLABLE │ —                   │
│ privilege        │ text                    │ NOT NULL │ 'write'             │
│ visibleFromEpoch │ integer                 │ NOT NULL │ 1                   │
│ joinedAt         │ timestamp w/ TZ         │ NOT NULL │ NOW()               │
│ leftAt           │ timestamp w/ TZ         │ NULLABLE │ —                   │
└──────────────────┴─────────────────────────┴──────────┴─────────────────────┘
PK: id
FK: conversationId → conversations(id) ON DELETE CASCADE
FK: userId → users(id) ON DELETE SET NULL
FK: linkId → sharedLinks(id) ON DELETE SET NULL
UNIQUE: (conversationId, userId) WHERE leftAt IS NULL
UNIQUE: (conversationId, linkId) WHERE leftAt IS NULL
CHECK: (userId IS NOT NULL) OR (linkId IS NOT NULL)
INDEX: conversationMembers(conversationId) WHERE leftAt IS NULL
INDEX: conversationMembers(userId) WHERE leftAt IS NULL
```

**Notes:**
- This is the application-layer membership table. `epochMembers` is the crypto-layer membership table. They serve different purposes and both exist.
- **The owner gets a `conversationMembers` row on conversation creation** with `privilege = 'owner'`, `visibleFromEpoch = 1`. This ensures "list all members" queries include the owner, and the owner is part of the same membership abstraction as everyone else. Without this, queries and budget logic would need special-case handling for the owner.
- When adding a member: create a `conversationMembers` row (application access) AND an `epochMembers` row (key distribution).
- When removing: set `leftAt` on the `conversationMembers` row, insert a `pendingRemovals` row, set `rotationPending = true` on the conversation. The actual epoch rotation deletes the old `epochMembers` wraps.
- `userId` is set for account members. `linkId` is set for shared link virtual members. Exactly one must be non-null (enforced by CHECK constraint).
- `privilege`: `read`, `write`, `admin`, `owner`. Server-enforced.
- `visibleFromEpoch`: Server refuses to serve messages or chain links from before this epoch for this member.
- `leftAt`: Soft-delete. Non-null means the member has left. The UNIQUE constraints only apply to active members (WHERE leftAt IS NULL), allowing a user or link to leave and rejoin.
- Active members query: `SELECT * FROM conversationMembers WHERE conversationId = ? AND leftAt IS NULL`. One query, no joins.
- Join/leave history is preserved for UI ("Alice left the chat") and audit.

---

### epochs

Cryptographic epoch key material. One row per epoch per conversation.

```
┌──────────────────┬─────────────────────────┬──────────┬─────────────────────┐
│      Column      │          Type           │ Nullable │       Default       │
├──────────────────┼─────────────────────────┼──────────┼─────────────────────┤
│ id               │ text (UUID)             │ NOT NULL │ uuidv7() │
│ conversationId   │ text (FK→conversations) │ NOT NULL │ —                   │
│ epochNumber      │ integer                 │ NOT NULL │ —                   │
│ epochPublicKey   │ bytea                   │ NOT NULL │ —                   │
│ confirmationHash │ bytea                   │ NOT NULL │ —                   │
│ chainLink        │ bytea                   │ NULLABLE │ —                   │
│ createdAt        │ timestamp w/ TZ         │ NOT NULL │ NOW()               │
└──────────────────┴─────────────────────────┴──────────┴─────────────────────┘
PK: id
FK: conversationId → conversations(id) ON DELETE CASCADE
UNIQUE: (conversationId, epochNumber)
INDEX: epochs(conversationId, epochNumber)
```

**Notes:**
- `epochPublicKey`: 32-byte X25519 public key. Stored plaintext so the server can encrypt AI responses and user messages under it.
- `confirmationHash`: 32-byte SHA-256 hash of the epoch private key. After unwrapping, the client hashes the result and compares. Fast failure on corrupted wraps or wrong keys.
- `chainLink`: ECIES blob (~81 bytes). Contains the PREVIOUS epoch's private key encrypted under THIS epoch's public key. NULL for the first epoch (nothing to chain to). Enables backward traversal: unwrap current epoch key → decrypt chain link → get previous epoch key → repeat.
- Epoch rows accumulate but are bounded by human actions (one per member removal). For 20 removals: ~20 rows × ~182 bytes = ~3.6KB. Negligible.

---

### epochMembers

Cryptographic key distribution. Stores per-member wraps of epoch private keys.

```
┌──────────────────┬──────────────────┬──────────┬─────────────────────┐
│      Column      │       Type       │ Nullable │       Default       │
├──────────────────┼──────────────────┼──────────┼─────────────────────┤
│ id               │ text (UUID)      │ NOT NULL │ uuidv7() │
│ epochId          │ text (FK→epochs) │ NOT NULL │ —                   │
│ memberPublicKey  │ bytea            │ NOT NULL │ —                   │
│ wrap             │ bytea            │ NOT NULL │ —                   │
│ privilege        │ text             │ NOT NULL │ 'write'             │
│ visibleFromEpoch │ integer          │ NOT NULL │ 1                   │
│ createdAt        │ timestamp w/ TZ  │ NOT NULL │ NOW()               │
└──────────────────┴──────────────────┴──────────┴─────────────────────┘
PK: id
FK: epochId → epochs(id) ON DELETE CASCADE
UNIQUE: (epochId, memberPublicKey)
INDEX: epochMembers(memberPublicKey)
```

**Notes:**
- `memberPublicKey`: The 32-byte X25519 public key of the member (account or link virtual member). Used to look up wraps for a given user's public key.
- `wrap`: ~81-byte ECIES blob. The epoch private key encrypted under this member's public key. The member decrypts using their account private key (or link-derived private key).
- This table stores wraps ONLY for the current epoch. On rotation, old wraps are deleted and new wraps are created for remaining members. Historical epoch access is via chain links, not retained wraps.
- Both account members and shared link virtual members have rows here. A shared link's derived public key gets a wrap just like an account's public key. Uniform handling — no special cases.
- `privilege` and `visibleFromEpoch` are duplicated from `conversationMembers` for the crypto layer's use. They must stay in sync.

---

### sharedLinks

Metadata for public sharing links. Each link is a virtual member with its own derived keypair.

```
┌──────────────────┬─────────────────────────┬──────────┬─────────────────────┐
│      Column      │          Type           │ Nullable │       Default       │
├──────────────────┼─────────────────────────┼──────────┼─────────────────────┤
│ id               │ text (UUID)             │ NOT NULL │ uuidv7() │
│ conversationId   │ text (FK→conversations) │ NOT NULL │ —                   │
│ linkPublicKey    │ bytea                   │ NOT NULL │ —                   │
│ privilege        │ text                    │ NOT NULL │ 'read'              │
│ visibleFromEpoch │ integer                 │ NOT NULL │ —                   │
│ revokedAt        │ timestamp w/ TZ         │ NULLABLE │ —                   │
│ createdAt        │ timestamp w/ TZ         │ NOT NULL │ NOW()               │
└──────────────────┴─────────────────────────┴──────────┴─────────────────────┘
PK: id
FK: conversationId → conversations(id) ON DELETE CASCADE
INDEX: sharedLinks(conversationId) WHERE revokedAt IS NULL
```

**Notes:**
- `linkPublicKey`: 32-byte X25519 public key derived from the link secret via HKDF. The server never sees the link secret (it's in the URL fragment).
- No `linkWrap` or `epochNumber` column. Wraps for the link's public key are stored in `epochMembers` uniformly, same as account member wraps. One code path for all wraps.
- No `expiresAt`. Links are valid until revoked. Expiry can be added later.
- `revokedAt`: Non-null means the link has been revoked. Revocation triggers lazy epoch rotation (the link's virtual member is removed from the next epoch's wraps).
- Multiple links per conversation are supported. Each with its own privilege level and history visibility.
- URL format: `https://app.com/c/{conversationId}#{linkSecretBase64url}`. The fragment is never sent to the server.

---

### messages

Encrypted message content with plaintext metadata for routing and billing.

```
┌───────────────────┬─────────────────────────┬──────────┬─────────────────────┐
│      Column       │          Type           │ Nullable │       Default       │
├───────────────────┼─────────────────────────┼──────────┼─────────────────────┤
│ id                │ text (UUID)             │ NOT NULL │ uuidv7() │
│ conversationId    │ text (FK→conversations) │ NOT NULL │ —                   │
│ encryptedBlob     │ bytea                   │ NOT NULL │ —                   │
│ senderType        │ text                    │ NOT NULL │ —                   │
│ senderId          │ text                    │ NULLABLE │ —                   │
│ senderDisplayName │ text                    │ NULLABLE │ —                   │
│ payerId           │ text                    │ NULLABLE │ —                   │
│ epochNumber       │ integer                 │ NOT NULL │ —                   │
│ sequenceNumber    │ integer                 │ NOT NULL │ —                   │
│ createdAt         │ timestamp w/ TZ         │ NOT NULL │ NOW()               │
└───────────────────┴─────────────────────────┴──────────┴─────────────────────┘
PK: id
FK: conversationId → conversations(id) ON DELETE CASCADE
INDEX: messages(conversationId, sequenceNumber)
CHECK: senderType IN ('user', 'ai')
```

**Notes:**
- `encryptedBlob`: ECIES blob. Version byte (1B) + ephemeral public key (32B) + ciphertext + Poly1305 tag (16B). 49 bytes overhead + compressed plaintext.
- `senderType`: `user` or `ai`.
- `senderId`: User ID of the sender. NULL for AI messages and anonymous guests.
- `senderDisplayName`: Display name for guests who send via write-enabled links. NULL for authenticated users (resolve name from senderId).
- `payerId`: User ID of whoever paid for this message. Could be the sender (paying with own wallets) or the conversation owner (paying via budget system). NULL should not occur for AI messages that have cost.
- `epochNumber`: Which epoch key decrypts this message. Client uses this to look up the correct epoch and unwrap the key.
- `sequenceNumber`: Server-assigned, monotonically increasing per conversation. Assigned from `conversations.nextSequence` in the same transaction as the message insert. Deterministic ordering without clock skew.
- `cost`, `model`, and `balanceTransactionId` are removed. Cost and model information lives in `usage_records` linked via `sourceType = 'message'` and `sourceId = message.id`. A single message can have multiple usage records (text + image in one reply). This decouples chat from billing.
- Messages are hard-deleted. No soft delete, no scheduled disappearance. `DELETE FROM messages WHERE id = ?` removes the row permanently.

---

### sharedMessages

Cryptographically isolated single-message shares.

```
┌───────────┬────────────────────┬──────────┬─────────────────────┐
│  Column   │        Type        │ Nullable │       Default       │
├───────────┼────────────────────┼──────────┼─────────────────────┤
│ id        │ text (UUID)        │ NOT NULL │ uuidv7() │
│ messageId │ text (FK→messages) │ NOT NULL │ —                   │
│ shareBlob │ bytea              │ NOT NULL │ —                   │
│ createdAt │ timestamp w/ TZ    │ NOT NULL │ NOW()               │
└───────────┴────────────────────┴──────────┴─────────────────────┘
PK: id
FK: messageId → messages(id) ON DELETE CASCADE
```

**Notes:**
- `shareBlob`: ECIES blob encrypted under a key pair derived from a random share secret. The secret is in the URL fragment, never sent to server.
- URL format: `https://app.com/m/{shareId}#{shareSecretBase64url}`
- Each share is cryptographically independent. Different random secret per share, even for the same message shared twice. Access to one share reveals nothing about the conversation or other shares.
- No `expiresAt`. Shares are permanent. Expiry can be added later.

---

### memberBudgets

Per-member spending allowances from the owner's wallets. Keyed to `conversationMembers` for full user/link parity.

```
┌────────────────┬───────────────────────────────┬──────────┬─────────────────────┐
│     Column     │             Type              │ Nullable │       Default       │
├────────────────┼───────────────────────────────┼──────────┼─────────────────────┤
│ id             │ text (UUID)                   │ NOT NULL │ uuidv7() │
│ memberId       │ text (FK→conversationMembers) │ NOT NULL │ —                   │
│ budget         │ numeric(20,8)                 │ NOT NULL │ —                   │
│ spent          │ numeric(20,8)                 │ NOT NULL │ 0                   │
│ createdAt      │ timestamp w/ TZ               │ NOT NULL │ NOW()               │
└────────────────┴───────────────────────────────┴──────────┴─────────────────────┘
PK: id
UNIQUE: memberId
FK: memberId → conversationMembers(id) ON DELETE CASCADE
```

**Notes:**
- Keyed to `conversationMembers.id`, not to `conversationId + userId`. Since `conversationMembers` already unifies users and links, this gives full parity: both authenticated users and guest link virtual members get budget tracking through the same table with the same code path.
- `conversationId` and `userId` are not stored here — derivable from the `conversationMembers` row.
- Only used when `conversations.perPersonBudget` is NULL (individual budgets mode). If `perPersonBudget` is non-null, that value applies to everyone and this table tracks only `spent`.
- `spent`: Cached counter. Updated atomically in the same transaction as the `usage_record` and `ledger_entries` inserts. Source of truth for reconciliation is derivable from usage records.
- No row for a member means zero budget (they pay from their own wallets from the first message, or are blocked if they're a guest link with no wallets).

---

### conversationSpending

Cached total of owner spending across all members in a conversation.

```
┌────────────────┬─────────────────────────┬──────────┬─────────────────────┐
│     Column     │          Type           │ Nullable │       Default       │
├────────────────┼─────────────────────────┼──────────┼─────────────────────┤
│ id             │ text (UUID)             │ NOT NULL │ uuidv7() │
│ conversationId │ text (FK→conversations) │ NOT NULL │ —                   │
│ totalSpent     │ numeric(20,8)           │ NOT NULL │ 0                   │
│ updatedAt      │ timestamp w/ TZ         │ NOT NULL │ NOW()               │
└────────────────┴─────────────────────────┴──────────┴─────────────────────┘
PK: id
FK: conversationId → conversations(id) ON DELETE CASCADE
UNIQUE: conversationId
```

**Notes:**
- `totalSpent`: Cached counter. Updated atomically in the same transaction as the usage record insert when the owner is charged. Checked against `conversations.conversationBudget`.
- Created lazily when the first member (non-owner) sends a message that charges the owner.
- **Budget race condition:** Two members sending simultaneously can both pass the budget check before either commits. The existing Redis-based speculative budget enforcement system handles this — it speculatively reserves budget in Redis before the database transaction, preventing concurrent overshoots. This system must be expanded from its current single-user scope to cover group conversations: reserve against both `memberBudgets.spent` (per-member cap) and `conversationSpending.totalSpent` (conversation-wide cap) in Redis before committing to the database. Redis is the fast-path gate; the database is the source of truth reconciled after commit.

---

### payments

Payment processor records. Unchanged from current schema.

```
┌─────────────────────┬─────────────────┬──────────┬─────────────────────┐
│       Column        │      Type       │ Nullable │       Default       │
├─────────────────────┼─────────────────┼──────────┼─────────────────────┤
│ id                  │ text (UUID)     │ NOT NULL │ uuidv7() │
│ userId              │ text (FK→users) │ NULLABLE │ —                   │
│ amount              │ numeric(20,8)   │ NOT NULL │ —                   │
│ status              │ text            │ NOT NULL │ 'pending'           │
│ idempotencyKey      │ text            │ NULLABLE │ —                   │
│ helcimTransactionId │ text            │ NULLABLE │ —                   │
│ cardType            │ text            │ NULLABLE │ —                   │
│ cardLastFour        │ text            │ NULLABLE │ —                   │
│ errorMessage        │ text            │ NULLABLE │ —                   │
│ createdAt           │ timestamp w/ TZ │ NOT NULL │ NOW()               │
│ updatedAt           │ timestamp w/ TZ │ NOT NULL │ NOW()               │
│ webhookReceivedAt   │ timestamp w/ TZ │ NULLABLE │ —                   │
└─────────────────────┴─────────────────┴──────────┴─────────────────────┘
PK: id
FK: userId → users(id) ON DELETE SET NULL
UNIQUE: helcimTransactionId
INDEX: payments(userId)
```

**Notes:**
- When a payment completes, a `ledger_entries` row is created with `entryType = 'deposit'`, `paymentId = payment.id`, and the user's `purchased` wallet balance is incremented atomically.
- `status`: `pending`, `completed`, `failed`, `refunded`.

---

### serviceEvidence

Testing and audit log for third-party service interactions. Unchanged from current schema.

```
┌───────────┬─────────────────┬──────────┬─────────────────────┐
│  Column   │      Type       │ Nullable │       Default       │
├───────────┼─────────────────┼──────────┼─────────────────────┤
│ id        │ text (UUID)     │ NOT NULL │ uuidv7() │
│ service   │ text            │ NOT NULL │ —                   │
│ details   │ jsonb           │ NULLABLE │ —                   │
│ createdAt │ timestamp w/ TZ │ NOT NULL │ NOW()               │
└───────────┴─────────────────┴──────────┴─────────────────────┘
PK: id
```

---

### Complete Index Summary

```
-- Users
UNIQUE INDEX ON users(email)
UNIQUE INDEX ON users(username)

-- Wallets
INDEX ON wallets(userId)

-- Ledger Entries
INDEX ON ledger_entries(walletId, createdAt)
INDEX ON ledger_entries(usageRecordId) WHERE usageRecordId IS NOT NULL

-- Usage Records
INDEX ON usage_records(userId, type, createdAt)
INDEX ON usage_records(sourceType, sourceId)

-- LLM Completions
UNIQUE INDEX ON llmCompletions(usageRecordId)
INDEX ON llmCompletions(model)

-- Projects
INDEX ON projects(userId)

-- Conversations
INDEX ON conversations(userId)
INDEX ON conversations(projectId) WHERE projectId IS NOT NULL

-- Pending Removals
INDEX ON pendingRemovals(conversationId)

-- Conversation Members
UNIQUE INDEX ON conversationMembers(conversationId, userId) WHERE leftAt IS NULL
UNIQUE INDEX ON conversationMembers(conversationId, linkId) WHERE leftAt IS NULL
INDEX ON conversationMembers(conversationId) WHERE leftAt IS NULL
INDEX ON conversationMembers(userId) WHERE leftAt IS NULL

-- Epochs
UNIQUE INDEX ON epochs(conversationId, epochNumber)

-- Epoch Members
UNIQUE INDEX ON epochMembers(epochId, memberPublicKey)
INDEX ON epochMembers(memberPublicKey)

-- Shared Links
INDEX ON sharedLinks(conversationId) WHERE revokedAt IS NULL

-- Messages
INDEX ON messages(conversationId, sequenceNumber)

-- Member Budgets
UNIQUE INDEX ON memberBudgets(memberId)

-- Conversation Spending
UNIQUE INDEX ON conversationSpending(conversationId)

-- Payments
UNIQUE INDEX ON payments(helcimTransactionId)
INDEX ON payments(userId)
```

---

### Tables Summary

| Table | Purpose | Rows Grow With |
|---|---|---|
| users | Account identity + encrypted keys | User signups |
| wallets | Multi-source credit pools | Wallet types per user (typically 2) |
| ledger_entries | Append-only financial audit trail | Every money movement |
| usage_records | Parent table for AI operation facts | Every AI invocation |
| llmCompletions | LLM-specific operation details (child of usage_records) | Every LLM invocation |
| projects | Encrypted conversation folders | User-created folders |
| conversations | Chat containers (solo + group) | User-created conversations |
| pendingRemovals | Queued member removals | Removals between rotations (transient) |
| conversationMembers | Application-layer membership | Member joins (soft-deleted on leave) |
| epochs | Cryptographic epoch keys | Member removals (bounded by human actions) |
| epochMembers | Per-member epoch key wraps | Current members × current epoch only |
| sharedLinks | Public link metadata | Link creation |
| messages | Encrypted message content | Every message (primary storage) |
| sharedMessages | Isolated single-message shares | User-created shares |
| memberBudgets | Per-member conversation spending limits | Owner-configured budgets |
| conversationSpending | Cached conversation-wide spending | One per conversation with budget |
| payments | Payment processor records | User purchases |
| serviceEvidence | Testing/audit log | Service interactions |

---

## Part 15: Threat Model Summary

### What the Server Cannot Do

- Decrypt any stored message (only has epoch public keys)
- Decrypt any epoch private key (wrapped under account public keys)
- Decrypt any account private key (wrapped under OPAQUE export key / recovery KEK)
- Forge a valid key wrap for a non-member
- Decrypt shared link data (link secret in URL fragment, never transmitted)
- Decrypt individually shared messages (share secret in URL fragment)

### What the Server Can Do

- Encrypt messages (holds epoch public keys) — this is by design
- Read plaintext during AI invocation — accepted exception
- Stream plaintext AI tokens — accepted exception
- Read message metadata (who, when, cost, not content)
- Observe traffic patterns (message sizes, timing, frequency)
- Deny service
- Observe membership

### Accepted Tradeoffs

| Tradeoff | Severity | Rationale |
|---|---|---|
| Server sees AI plaintext | Accepted | Fundamental to the product |
| No message signatures in v1 | Medium | Ed25519 can be added later |
| Server-enforced privileges | Low | Cryptographic enforcement adds no real value against the stated threat model |
| Metadata visible | Medium | Standard for all E2EE systems |
| No per-message PFS | Low | Server already sees plaintext during AI invocation |
| Race window on revocation | Low | Explicitly accepted, bounded by lazy rotation |
| History visibility is server-enforced | Low | New members never had old keys; same trust boundary as AI plaintext |

### Full Decryption Chain

```
Password → OPAQUE → export key → HKDF → wrapping key pair → ECIES decrypt → account_private_key → ECIES decrypt (member wrap) → epoch_private_key → [chain traversal if needed] → ECIES decrypt (message blob) → decompress → plaintext
```

---

## Part 16: Owner & Account Lifecycle

### Owner Leaves a Conversation

Owner leaving deletes the entire conversation, including all messages, epochs, member wraps, chain links, shared links, and budget data. All connected members are disconnected via the Durable Object.

### Account Deletion

1. User authenticates.
2. User leaves all conversations (triggering lazy rotation for each, or conversation deletion if they are the owner).
3. Account row is deleted (public key, wrapped blobs, OPAQUE state).
4. Projects cascade-delete (encrypted under user's key, useless without it).
5. Financial records are preserved: `wallets`, `ledger_entries`, `usage_records`, and `payments` have their `userId` set to NULL. The audit trail survives account deletion.
6. All sessions are invalidated.

### Voluntary Leave

Treated identically to removal. Triggers lazy rotation. The leaving member's wrap is deleted, and they lose the ability to decrypt future messages once rotation occurs.

---

## Part 17: Future Migration Paths

These are not implemented in v1 but the architecture supports them without redesign:

- **Post-quantum:** Replace X25519 with ML-KEM in the ECIES construction. Version byte `0x02`. Symmetric layer (XChaCha20-Poly1305) is already quantum-resistant.
- **Message signatures:** Add Ed25519 signing (already available via `@noble/curves`). Store signature alongside the encrypted blob. No schema changes beyond adding a `signature` column.
- **Multi-device:** Each device gets its own X25519 key pair. Account private key is wrapped for each device. Adds one indirection layer, does not change epoch/conversation design.
- **Key transparency:** Publish account public keys to a transparency log. No encryption changes.
- **Cryptographic history boundaries:** If server-enforced `visible_from_epoch` proves insufficient, the MEK/CK split can be added for a single hard cryptographic boundary per conversation.