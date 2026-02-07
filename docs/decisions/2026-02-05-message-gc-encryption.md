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
    - Stores all member wraps
    - Stores chain link
    - Deletes old epoch's per-member wraps
    - Removes revoked members/links
    - Updates conversation's current_epoch pointer
    - Clears rotation_pending
    - Stores the message

### Adding a Member

No rotation. Any admin/owner client:

1. Fetches new member's account_public_key from server.
2. Decrypts current epoch private key using own account private key.
3. `new_wrap = ECIES_Encrypt(new_member_account_public_key, current_epoch_private_key)`
4. Sends to server: new member ID, wrap, privilege level, visible_from_epoch.
5. Server stores the member wrap and membership record.

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

1. Client sends plaintext to server via tRPC mutation.
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
| cost (integer) | Message cost in smallest currency unit |
| created_at (timestamp) | Ordering and display |

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

A shared link is a virtual member of the conversation with its own X25519 key pair derived from a secret in the URL. The epoch rotation machinery handles links automatically — no special cases.

### Link Creation

1. Owner/admin generates a random 256-bit `link_secret`.
2. Derives key pair: `link_keypair = X25519_FromSeed(HKDF(link_secret, info="link-keypair-v1"))`.
3. Decrypts current epoch private key.
4. Wraps epoch key for the link: `link_wrap = ECIES_Encrypt(link_keypair.public, epoch_private_key)`.
5. Sends to server: link_public_key, link_wrap, expires_at, privilege, visible_from_epoch, link_id.
6. Constructs URL: `https://app.com/c/{conversation_id}#{link_secret_base64url}`

The URL fragment (after `#`) is never sent to the server by the browser. The server only sees the conversation_id.

### Link Access

1. Visitor opens link.
2. Client extracts `link_secret` from URL fragment.
3. Derives `link_keypair` from secret.
4. Sends conversation_id to server (no auth required for link access).
5. Server checks link validity (exists, not expired, not revoked).
6. Server returns: link_wrap, epoch chain data, encrypted messages (respecting `visible_from_epoch`).
7. Client decrypts: link private key → epoch private key → messages.

### Link Expiry and Revocation

Links expire when `expires_at` passes — the server stops serving data. For cryptographic lockout (not just access control), revoking a link triggers lazy epoch rotation, same as removing a member. The link's virtual member is removed and the new epoch key is not wrapped for it.

### Guest Messaging via Links

If a link has write privilege and the owner's budget allows it:
- Guest sends plaintext to server.
- Server charges owner's balance (within budget limits).
- `payer_id = owner`. `sender_id = null`. `sender_display_name` = whatever name the guest entered.
- Message is encrypted and stored normally.

---

## Part 8: Individual Message Sharing

Sharing a single message is cryptographically isolated from the conversation.

### Share Flow

1. Client decrypts the target message using the epoch key chain.
2. Generates a random 256-bit `share_secret`.
3. Derives key pair: `share_keypair = X25519_FromSeed(HKDF(share_secret, info="share-msg-v1"))`.
4. Encrypts: `share_blob = ECIES_Encrypt(share_keypair.public, plaintext_message)`.
5. Sends to server: share_id, share_blob, expires_at, original_message_id.
6. URL: `https://app.com/m/{share_id}#{share_secret_base64url}`

The share_secret is random and unrelated to any conversation key, epoch key, or account key. Possessing it reveals exactly one message. Even if the same message is shared twice, each share has a different secret and blob.

---

## Part 9: Budget System

### Schema Design

On the conversations table: one column `per_person_budget` (nullable integer). If non-null, this value applies to every non-owner member. If null, individual budgets are looked up in a separate table.

Separate member_budgets table: per-user per-conversation rows with `budget` and `spent` fields. No row means zero budget for that user.

Separate column `conversation_budget` on conversations (nullable integer): total cap across all users. Checked in addition to per-person budget.

### Payment Logic (Server-Side)

```
When user U sends a message in conversation C owned by O:
  1. Compute message cost from AI token usage.
  2. If U == O:
       Charge O's balance. payer = O.
  3. Else:
       Determine U's budget:
         If conversations.per_person_budget IS NOT NULL → use that value
         Else if member_budgets row exists for U → use row.budget
         Else → budget is 0
       If budget > spent AND conversation_budget > total_spent:
         Charge O's balance. payer = O. Increment spent counters.
       Else:
         Charge U's balance. payer = U.
  4. Store payer_id and cost in message metadata.
```

### Display

Each message in the UI shows: content (decrypted), sender name, cost, and "paid by [username]" (resolved from payer_id).

---

## Part 10: Communication Architecture

### Overview

```
Client (React)
  │
  ├── tRPC (HTTP via Hono) ──────► Cloudflare Worker (apps/api)
  │     All request-response           │
  │     operations                     ├── PostgreSQL
  │                                    ├── Redis (cache, rate limit, sessions)
  │                                    └── AI Provider
  │                                        │
  └── WebSocket ─────────────────► Durable Object (packages/realtime)
        Real-time push only               Per-conversation instance
                                          Pure broadcast hub

Payment Processor ──webhook──► Cloudflare Worker (apps/api, plain Hono route)
```

### tRPC Layer

All request-response operations go through tRPC, mounted as Hono middleware. tRPC provides end-to-end TypeScript type safety with zero code generation. Input validation uses Zod (runtime validation that also generates TypeScript types).

Hono setup:

```
Hono app
  ├── /trpc/*  →  @hono/trpc-server middleware → tRPC router
  └── /webhooks/payments  →  plain Hono route handler
```

#### tRPC Router Structure

```
appRouter
├── auth
│   ├── register
│   ├── login
│   ├── verify2FA
│   ├── logout
│   └── refreshSession
├── account
│   ├── getProfile
│   ├── updateProfile
│   ├── changePassword
│   ├── recoverAccount
│   ├── regenerateRecovery
│   └── deleteAccount
├── conversations
│   ├── create
│   ├── list
│   ├── get
│   ├── delete
│   └── updateSettings
├── members
│   ├── add
│   ├── remove
│   ├── leave
│   ├── updatePrivilege
│   └── list
├── links
│   ├── create
│   ├── revoke
│   └── list
├── keys
│   ├── getEpochWraps
│   ├── getChainLinks
│   ├── submitRotation
│   └── getMemberPublicKeys
├── messages
│   ├── send
│   ├── delete
│   ├── getHistory
│   ├── createShare
│   └── getShared
└── budget
    ├── get
    └── update
```

### Durable Object + WebSocket Layer

One Durable Object instance per conversation. All members of a conversation connect their WebSocket to the same DO. The DO is a pure broadcast hub — it holds no encryption keys, no message content, no business logic beyond fan-out.

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

The API Worker calls the DO via a Durable Object binding (stub). The DO is not called directly by clients for mutations — only for WebSocket connections and ephemeral events (typing, presence). All state-changing operations go through tRPC, and the API Worker notifies the DO after committing changes.

#### Message Send Flow (Detailed)

1. Client calls tRPC `messages.send` mutation with plaintext and conversation_id.
2. API Worker: validates auth, checks write permission, checks budget.
3. API Worker: checks `rotation_pending`. If true, returns a signal to the client that rotation is needed. Client performs rotation (generates keys, wraps, chain link), resubmits with rotation data + message.
4. API Worker: fetches current epoch public key, encrypts message via ECIES, stores in PostgreSQL.
5. API Worker: notifies Durable Object with the encrypted blob + metadata.
6. Durable Object: broadcasts `message:new` to all connected WebSockets.
7. API Worker: invokes AI with plaintext, streams tokens.
8. For each token: API Worker sends to DO, DO broadcasts `message:stream` to all sockets.
9. On AI completion: API Worker encrypts full response via ECIES, stores in PostgreSQL.
10. API Worker: sends final blob to DO, DO broadcasts `message:complete`.
11. Connected clients replace ephemeral stream with authoritative encrypted blob.
12. API Worker: discards all plaintext.

#### Concurrency

No lock on normal message sends — they all use the same epoch public key, and ECIES generates a fresh ephemeral key per operation. Concurrent sends are safe. The server assigns message ordering (timestamp or sequence number).

Lock only during epoch rotation. If two clients simultaneously detect `rotation_pending` and attempt to rotate, the server uses first-write-wins. The second client's rotation is rejected; it re-fetches the new epoch and re-encrypts its message under the new key.

### Webhook

The payment processor webhook is a plain Hono POST route alongside the tRPC middleware. It verifies the webhook signature (processor-specific), updates the user's balance in PostgreSQL, and returns 200. If the payment affects an active conversation, optionally notify the conversation's DO to refresh budget state.

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
  api/             ← Hono + tRPC router + webhook. Imports @cloudflare/opaque-ts (server-side), iron-session, otplib. Re-exports DO class from packages/realtime.
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
- `createSharedLink(epochPrivateKey)` → returns { linkSecret, linkPublicKey, linkWrap }
- `deriveKeysFromLinkSecret(linkSecret)` → returns linkKeyPair
- `accessConversationViaLink(linkSecret, linkWrap, chainLinks[], encryptedMessages[])` → returns decryptedMessages[]

**Message sharing:**
- `createMessageShare(plaintext)` → returns { shareSecret, shareBlob }
- `decryptMessageShare(shareSecret, shareBlob)` → returns plaintext

The key principle: a developer in `apps/api` or `apps/web` should never need to know what X25519, ECIES, HKDF, or XChaCha20 are. They call `encryptMessageForStorage()` and get a blob. They call `performEpochRotation()` and get everything they need to send to the server. The crypto package is the only place where algorithm-level code lives.

---

## Part 12: Migration from REST to tRPC

### Packages to Add

| Package | Where | Purpose |
|---|---|---|
| `@trpc/server` | apps/api | Define routers and procedures |
| `@trpc/client` | apps/web | Vanilla typed client |
| `@trpc/react-query` | apps/web | React hooks integration |
| `@tanstack/react-query` | apps/web | Peer dependency of above |
| `@hono/trpc-server` | apps/api | Mount tRPC as Hono middleware |
| `zod` | apps/api | Runtime input validation + type inference |

### Migration Steps

1. **Set up tRPC infrastructure alongside existing REST.** Create the tRPC initialization (context, router instance, procedure helpers) in `apps/api`. Mount it as Hono middleware on `/trpc/*`. Existing REST routes continue working on their current paths. Both coexist on the same Worker.

2. **Define the tRPC context.** The context should include everything procedures need: the authenticated user (from session), Cloudflare env bindings (DB, DO, KV), and the execution context. This replaces whatever you currently extract from the Hono request context.

3. **Create middleware for auth.** A `protectedProcedure` base procedure that checks the session and injects the authenticated user into the context. An `adminProcedure` that additionally checks admin/owner privilege for the target conversation. These replace your current Hono auth middleware.

4. **Migrate one endpoint at a time.** For each existing REST route handler:
   a. Create a tRPC procedure (query for reads, mutation for writes).
   b. Move the input validation to a Zod schema in `.input()`.
   c. Move the handler logic into the procedure body. The business logic is identical — only the wiring changes.
   d. On the client, replace the `fetch()` call with the tRPC client call.
   e. Delete the TypeScript interface you were manually maintaining for the response.
   f. Once the tRPC version works, remove the old REST route.

5. **Start with low-risk endpoints.** Migrate simple reads first (getProfile, list conversations). Then mutations. Save auth endpoints (OPAQUE flows) for last since they're the most complex.

6. **Keep the webhook as a plain Hono route.** The payment processor does not speak tRPC. This route stays as-is, forever.

7. **Set up the React Query integration.** Wrap the app in the tRPC + React Query providers. Replace manual `useEffect` + `fetch` patterns with `trpc.conversations.list.useQuery()` style hooks. This gives you automatic caching, revalidation, loading states, and optimistic updates for free.

### What Changes, What Doesn't

| Aspect | Before (REST) | After (tRPC) |
|---|---|---|
| Server handler logic | Same | Same (procedure body) |
| Input validation | Manual or middleware | Zod schema in `.input()` |
| Response typing | Manual interfaces | Inferred from return type |
| Client calls | `fetch()` + manual typing | `trpc.router.procedure.mutate()` |
| Error handling | HTTP status codes | tRPC error codes (map to HTTP) |
| Auth middleware | Hono middleware | tRPC middleware (protectedProcedure) |
| Webhook | Hono route | Hono route (unchanged) |

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

Test the full flow locally: client opens WebSocket → Worker upgrades → routes to DO → DO accepts connection. Client sends tRPC mutation → Worker processes → notifies DO → DO broadcasts to WebSocket → client receives.

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
1. **API Worker** (via stub fetch): message:new, message:complete, message:deleted, member changes, rotation events. These are the result of tRPC mutations that the API Worker has already processed and committed to the database.
2. **Client WebSockets** (via WebSocket messages): typing:start, typing:stop, presence:update. These are ephemeral and never touch the database or API Worker.

---

## Part 14: Database Schema (Key-Related)

```sql
CREATE TABLE accounts (
    id                           UUID PRIMARY KEY,
    public_key                   BYTEA NOT NULL,        -- 32B X25519
    password_wrapped_private_key BYTEA NOT NULL,        -- ~81B ECIES blob
    recovery_wrapped_private_key BYTEA NOT NULL,        -- ~81B ECIES blob
    created_at                   TIMESTAMPTZ NOT NULL
);

CREATE TABLE conversations (
    id                  UUID PRIMARY KEY,
    owner_id            UUID NOT NULL REFERENCES accounts(id),
    current_epoch       INTEGER NOT NULL DEFAULT 1,
    rotation_pending    BOOLEAN NOT NULL DEFAULT FALSE,
    pending_removals    UUID[] DEFAULT '{}',
    per_person_budget   INTEGER,            -- NULL = use member_budgets table
    conversation_budget INTEGER,            -- NULL = no conversation-wide cap
    created_at          TIMESTAMPTZ NOT NULL
);

CREATE TABLE epochs (
    id                UUID PRIMARY KEY,
    conversation_id   UUID NOT NULL REFERENCES conversations(id),
    epoch_number      INTEGER NOT NULL,
    public_key        BYTEA NOT NULL,       -- 32B
    confirmation_hash BYTEA NOT NULL,       -- 32B SHA-256(private_key)
    chain_link        BYTEA,               -- ~81B ECIES blob, NULL for first epoch
    created_at        TIMESTAMPTZ NOT NULL,
    UNIQUE (conversation_id, epoch_number)
);

CREATE TABLE epoch_members (
    epoch_id            UUID NOT NULL REFERENCES epochs(id),
    member_id           UUID NOT NULL,       -- account ID or link ID
    member_type         TEXT NOT NULL CHECK (member_type IN ('account', 'link')),
    encrypted_epoch_key BYTEA NOT NULL,      -- ~81B ECIES blob
    privilege           TEXT NOT NULL CHECK (privilege IN ('read', 'write', 'admin', 'owner')),
    visible_from_epoch  INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (epoch_id, member_id)
);

CREATE TABLE shared_links (
    id              UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    public_key      BYTEA NOT NULL,          -- 32B
    privilege       TEXT NOT NULL DEFAULT 'read',
    visible_from_epoch INTEGER NOT NULL,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL
);

CREATE TABLE messages (
    id                  UUID PRIMARY KEY,
    conversation_id     UUID NOT NULL REFERENCES conversations(id),
    epoch_number        INTEGER NOT NULL,
    sender_type         TEXT NOT NULL CHECK (sender_type IN ('user', 'ai')),
    sender_id           UUID,
    sender_display_name TEXT,
    payer_id            UUID,
    cost                INTEGER NOT NULL DEFAULT 0,
    encrypted_blob      BYTEA NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL
);

CREATE TABLE shared_messages (
    id                  UUID PRIMARY KEY,
    original_message_id UUID REFERENCES messages(id),
    encrypted_blob      BYTEA NOT NULL,
    expires_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL
);

CREATE TABLE member_budgets (
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    user_id         UUID NOT NULL,
    budget          INTEGER NOT NULL,
    spent           INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE conversation_spending (
    conversation_id UUID NOT NULL REFERENCES conversations(id),
    total_spent     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id)
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX idx_epochs_conversation ON epochs(conversation_id, epoch_number);
CREATE INDEX idx_epoch_members_member ON epoch_members(member_id);
CREATE INDEX idx_shared_links_conversation ON shared_links(conversation_id);
CREATE INDEX idx_shared_links_expiry ON shared_links(expires_at) WHERE expires_at IS NOT NULL;
```

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
4. All sessions are invalidated.

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