# Authentication & E2E Encryption System Design

## Executive Summary

This document specifies the complete authentication, recovery, and end-to-end encryption system. The server never possesses decryption capability. Users authenticate via OPAQUE (password-authenticated key exchange), optionally enable 2FA, and can recover their account with either their password or a 12-word recovery phrase.

---

## Requirements Checklist

| #   | Requirement                                           | Met? | How                                                                                                |
| --- | ----------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| 1   | E2E encryption — server can never decrypt anything    | ✅   | Server only stores encrypted blobs and wrapped keys; all encryption/decryption happens client-side |
| 2   | Share conversations with specific people              | ✅   | Wrap conversation key with recipient's public key via ECDH                                         |
| 3   | Share individual messages with specific people        | ✅   | Wrap message key with recipient's public key via ECDH                                              |
| 4   | Public shareable links                                | ✅   | Key-in-URL-fragment pattern; server never sees the decryption key                                  |
| 5   | Supports text, images, and videos                     | ✅   | AES-256-GCM encrypts arbitrary binary content                                                      |
| 6   | Password can unlock all data                          | ✅   | Password → Argon2id → KEK → unwrap Master DEK                                                      |
| 7   | Recovery phrase can unlock all data                   | ✅   | BIP39 mnemonic → HKDF → KEK → unwrap Master DEK                                                    |
| 8   | Password can reset recovery phrase                    | ✅   | Unlock with password → generate new mnemonic → wrap DEK with new recovery KEK                      |
| 9   | Recovery phrase can reset password                    | ✅   | Unlock with recovery → set new password → wrap DEK with new password KEK                           |
| 10  | Forward secrecy NOT required                          | ✅   | Design explicitly avoids Double Ratchet complexity                                                 |
| 11  | Nullable per-message sharing keys (save storage)      | ✅   | `sharingKeyWrapped` and `recipientWrappedKeys` only populated when sharing occurs                  |
| 12  | Web / React / TypeScript                              | ✅   | @noble suite + hash-wasm + WebCrypto; all TypeScript-native                                        |
| 13  | No vendor lock-in / portable formats                  | ✅   | JWK, PKCS#8, SPKI, BIP39 — all open standards                                                      |
| 14  | Allows future migration                               | ✅   | Key versioning built in; standard formats; can swap algorithms                                     |
| 15  | Key rotation without password                         | ✅   | Master DEK in session memory; rotate conversation/message keys anytime                             |
| 16  | 12-word recovery phrase                               | ✅   | BIP39 with 128-bit entropy                                                                         |
| 17  | Recovery phrase only blocks payment, not app usage    | ✅   | `has_acknowledged_phrase` check only on payment flows                                              |
| 18  | OPAQUE authentication (password never sent to server) | ✅   | @cloudflare/opaque implementation                                                                  |
| 19  | Optional 2FA via authenticator apps                   | ✅   | TOTP with encrypted secret storage                                                                 |
| 20  | Email verification                                    | ✅   | Custom implementation with rate limiting                                                           |
| 21  | Use hash-wasm for Argon2id                            | ✅   | Replaces argon2-browser                                                                            |

---

## Technology Stack

| Purpose                   | Technology               | Notes                                        |
| ------------------------- | ------------------------ | -------------------------------------------- |
| **Sessions**              | iron-session             | Encrypted cookies only, no server storage    |
| **Authentication**        | @cloudflare/opaque       | PAKE protocol, password never leaves client  |
| **Challenge State**       | Upstash Redis            | Ephemeral OPAQUE state, auto-expiry          |
| **Rate Limiting**         | Upstash Redis            | Per-user and global limits                   |
| **Key Derivation**        | hash-wasm                | Argon2id WASM implementation                 |
| **Recovery Phrase**       | @scure/bip39             | Audited, small bundle                        |
| **Encryption**            | Web Crypto API           | Native AES-256-GCM, AES-KW                   |
| **Key Derivation (HKDF)** | @noble/hashes            | For deriving conversation/message keys       |
| **Key Agreement**         | @noble/curves            | X25519/P-256 for sharing                     |
| **2FA (Server)**          | otplib                   | TOTP secret generation and code verification |
| **2FA (UI - Input)**      | input-otp                | Accessible OTP input component               |
| **2FA (UI - QR Code)**    | react-qrcode-logo        | QR code with custom logo and styling         |
| **Compression**           | Native CompressionStream | No fallback, no polyfill                     |

---

## Migration: Removing Better Auth

### What Gets Deleted

1. All Better Auth npm packages
2. All Better Auth configuration files
3. All Better Auth API routes
4. All Better Auth database tables/columns:
   - `session` table
   - `account` table
   - `verification` table
   - Any Better Auth specific columns on `user` table

### Migration Steps

1. Create new database schema (see Database Schema section)
2. Implement new auth endpoints
3. Invalidate all existing sessions (users must re-login)
4. Drop Better Auth tables
5. Remove Better Auth packages from package.json
6. Delete Better Auth related code files

**Note:** Since the app has no real user data to retain, this is a clean break. All users will need to create new accounts.

---

## Database Schema

### Users Table

```sql
CREATE TABLE users (
  -- Identity
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                   TEXT UNIQUE NOT NULL,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW(),

  -- Email Verification
  email_verified          BOOLEAN DEFAULT FALSE,
  email_verify_token      TEXT,
  email_verify_expires    TIMESTAMPTZ,

  -- OPAQUE Authentication
  opaque_registration     BYTEA NOT NULL,  -- OPAQUE server registration record

  -- 2FA (Optional)
  totp_secret             BYTEA,           -- TOTP secret stored server-side, NULL if not enabled
  totp_enabled            BOOLEAN DEFAULT FALSE,

  -- E2E Encryption - Password Path
  password_salt           BYTEA NOT NULL,  -- 16 bytes, for Argon2id
  encrypted_dek_password  BYTEA NOT NULL,  -- DEK wrapped with password-derived KEK

  -- E2E Encryption - Recovery Path (nullable until phrase acknowledged)
  phrase_salt             BYTEA,           -- 16 bytes, for HKDF
  encrypted_dek_phrase    BYTEA,           -- DEK wrapped with phrase-derived KEK
  phrase_verifier         BYTEA,           -- Hash to verify phrase without storing it
  has_acknowledged_phrase BOOLEAN DEFAULT FALSE,

  -- Sharing Keys (for ECDH)
  public_key              BYTEA NOT NULL,  -- X25519 or P-256 public key (SPKI format)
  private_key_wrapped     BYTEA NOT NULL,  -- Private key wrapped with DEK

  -- Versioning
  encryption_version      INTEGER DEFAULT 1
);

-- Indexes
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_email_verify_token ON users(email_verify_token) WHERE email_verify_token IS NOT NULL;
```

### Conversations Table

```sql
CREATE TABLE conversations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_encrypted         BYTEA,           -- Encrypted conversation title
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW(),

  -- Sharing
  is_public               BOOLEAN DEFAULT FALSE,
  public_share_id         TEXT UNIQUE,     -- For public share URLs
  public_share_expires    TIMESTAMPTZ
);
```

### Messages Table

```sql
CREATE TABLE messages (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id         UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role                    TEXT NOT NULL,   -- 'user' | 'assistant'
  content_encrypted       BYTEA NOT NULL,  -- Encrypted message content
  iv                      BYTEA NOT NULL,  -- 12 bytes for AES-GCM
  created_at              TIMESTAMPTZ DEFAULT NOW(),

  -- Nullable Sharing (only populated when message is shared individually)
  sharing_key_wrapped     BYTEA,           -- Sharing key wrapped with owner's DEK

  -- Metadata (unencrypted, for queries)
  content_type            TEXT DEFAULT 'text',  -- 'text' | 'image' | 'video'

  INDEX idx_messages_conversation (conversation_id, created_at)
);
```

### Conversation Shares Table

```sql
CREATE TABLE conversation_shares (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id         UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  shared_with_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped_key             BYTEA NOT NULL,  -- Conversation key wrapped for recipient
  permissions             TEXT DEFAULT 'read',  -- 'read' | 'read-write'
  created_at              TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(conversation_id, shared_with_user_id)
);
```

### Message Shares Table

```sql
CREATE TABLE message_shares (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id              UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  shared_with_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped_key             BYTEA NOT NULL,  -- Message key wrapped for recipient
  created_at              TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(message_id, shared_with_user_id)
);
```

---

## Key Hierarchy

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Master DEK (256-bit random)                      │
│              Generated once at account creation                     │
│              All user content derives from this                     │
└─────────────────────────────────────────────────────────────────────┘
         ▲                                           ▲
         │                                           │
    Password Path                              Recovery Path
         │                                           │
┌─────────────────────┐                 ┌─────────────────────────────┐
│ KEK_password        │                 │ KEK_recovery                │
│ Argon2id(           │                 │ HKDF-SHA256(                │
│   password,         │                 │   bip39_seed,               │
│   password_salt,    │                 │   phrase_salt,              │
│   t=3, m=64MB, p=4  │                 │   "recovery-kek-v1"         │
│ )                   │                 │ )                           │
└─────────────────────┘                 └─────────────────────────────┘
         │                                           │
         ▼                                           ▼
┌─────────────────────┐                 ┌─────────────────────────────┐
│ encrypted_dek_pwd   │                 │ encrypted_dek_phrase        │
│ AES-KW(KEK, DEK)    │                 │ AES-KW(KEK, DEK)            │
└─────────────────────┘                 └─────────────────────────────┘


              Master DEK (unlocked in client memory)
                              │
              ┌───────────────┼───────────────┐
              │               │               │
              ▼               ▼               ▼
      ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
      │ Conv Key 1  │  │ Conv Key 2  │  │ Private Key │
      │ HKDF(DEK,   │  │ HKDF(DEK,   │  │ (unwrapped) │
      │ "conv:id1") │  │ "conv:id2") │  │ for sharing │
      └─────────────┘  └─────────────┘  └─────────────┘
              │               │
              ▼               ▼
      ┌─────────────┐  ┌─────────────┐
      │ Msg Key 1a  │  │ Msg Key 2a  │
      │ HKDF(CK1,   │  │ HKDF(CK2,   │
      │ "msg:id1a") │  │ "msg:id2a") │
      └─────────────┘  └─────────────┘
```

---

## OPAQUE Authentication

### What is OPAQUE?

OPAQUE is a Password-Authenticated Key Exchange (PAKE) protocol where:

- The password **never leaves the client**, not even as a hash
- The server stores a "registration record" that cannot be used to impersonate the user
- Even if the server is compromised, attackers cannot perform offline dictionary attacks
- Mutual authentication: client verifies server, server verifies client

### OPAQUE Flow Overview

**Registration (Signup):**

```
Client                                  Server
   │                                      │
   │  1. StartRegistration(password)      │
   │─────────────────────────────────────▶│
   │                                      │
   │  2. RegistrationResponse             │
   │◀─────────────────────────────────────│
   │                                      │
   │  3. FinishRegistration(response)     │
   │     → RegistrationRecord             │
   │─────────────────────────────────────▶│
   │                                      │
   │  4. Server stores record             │
   │                                      │
```

**Login:**

```
Client                                  Server
   │                                      │
   │  1. StartLogin(password)             │
   │     → KE1 message                    │
   │─────────────────────────────────────▶│
   │                                      │
   │  2. Server retrieves record          │
   │     ServerLogin(record, KE1)         │
   │     → KE2 message                    │
   │◀─────────────────────────────────────│
   │                                      │
   │  3. FinishLogin(KE2)                 │
   │     → KE3 message + session key      │
   │─────────────────────────────────────▶│
   │                                      │
   │  4. ServerFinish(KE3)                │
   │     → session key (same as client)   │
   │                                      │
```

### Redis for OPAQUE State

During login, the server must store ephemeral state between receiving KE1 and receiving KE3. This state:

- Lives for 60 seconds maximum
- Must be associated with a specific login attempt
- Must be cleaned up after use or expiry

**Redis Key Pattern:**

```
opaque:login:{login_attempt_id} → {
  ke1: <bytes>,
  server_state: <bytes>,
  user_id: <uuid>,
  created_at: <timestamp>
}
TTL: 60 seconds
```

### Integration with E2E Encryption

After successful OPAQUE login, the client receives the session key. However, for E2E encryption, we still need:

1. The password (to derive KEK via Argon2id)
2. The wrapped DEK (to unwrap with KEK)

**Flow:**

```
1. User enters password
2. Client performs OPAQUE login → session established
3. Client fetches user's encrypted_dek_password and password_salt
4. Client derives KEK = Argon2id(password, salt)
5. Client unwraps DEK = AES-KW-decrypt(KEK, encrypted_dek)
6. DEK stored in session memory for encrypting/decrypting content
```

---

## 2FA (Two-Factor Authentication)

### Overview

- **Optional** for all users
- Uses TOTP (Time-based One-Time Password) compatible with Google Authenticator, Authy, etc.
- TOTP secret stored encrypted with user's DEK
- Blocks authentication until valid code provided

### 2FA Setup Flow

```
1. User clicks "Enable 2FA" in settings
2. User must be authenticated with password (have DEK in memory)
3. Server generates random TOTP secret (20 bytes) using otplib
4. Server creates otpauth:// URI with secret, issuer, and account name
5. Client displays QR code using react-qrcode-logo:
   - Shape: "liquid" (rounded, organic corners)
   - Logo: App logo centered in QR code
   - Logo size: ~20% of QR code width
   - Error correction: "H" (high) to accommodate logo
6. User scans with authenticator app (Google Authenticator, Authy, etc.)
7. Client displays input-otp component for 6-digit code entry
8. User enters code to verify setup
9. Server verifies code using otplib.authenticator.check()
10. If valid, server sets totp_enabled = true and stores totp_secret
```

### QR Code Implementation

```tsx
import { QRCode } from 'react-qrcode-logo';

<QRCode
  value={otpauthUri}
  size={200}
  qrStyle="dots" // Rounded dot style
  eyeRadius={12} // Rounded corners on positioning squares
  logoImage="/logo.svg" // App logo
  logoWidth={40}
  logoHeight={40}
  removeQrCodeBehindLogo={true}
  ecLevel="H" // High error correction for logo
/>;
```

### OTP Input Implementation

```tsx
import { OTPInput, SlotProps } from 'input-otp';

<OTPInput
  maxLength={6}
  containerClassName="flex gap-2"
  render={({ slots }) => (
    <div className="flex gap-2">
      {slots.map((slot, idx) => (
        <Slot key={idx} {...slot} />
      ))}
    </div>
  )}
/>;

function Slot(props: SlotProps) {
  return (
    <div className="flex h-14 w-12 items-center justify-center rounded-lg border-2 font-mono text-2xl">
      {props.char ?? (props.hasFakeCaret && <FakeCaret />)}
    </div>
  );
}
```

### 2FA Login Flow

```
1. User completes OPAQUE authentication
2. Server checks if totp_enabled = true
3. If yes, server returns { requires_2fa: true, session_pending: true }
4. Client displays input-otp component for 6-digit code entry
5. Client sends code to server
6. Server verifies code using otplib.authenticator.check(code, totp_secret)
7. If valid, server creates full session
8. If invalid, increment attempt counter in Redis
```

### 2FA Implementation Decision

**Store TOTP secret server-side (not encrypted with DEK).**

Rationale:

- 2FA protects account access, not message content
- Message content is already E2E encrypted
- If attacker has server access + TOTP secret, they still can't read messages
- This matches industry standard (Google, GitHub, etc.)
- Simpler implementation, no circular dependency

**Schema adjustment:**

```sql
totp_secret    BYTEA,  -- Stored server-side, not encrypted with DEK
totp_enabled   BOOLEAN DEFAULT FALSE,
```

### Server-Side TOTP with otplib

```typescript
import { authenticator } from 'otplib';

// Generate secret during 2FA setup
const secret = authenticator.generateSecret(); // 20 bytes, base32 encoded

// Generate otpauth:// URI for QR code
const otpauthUri = authenticator.keyuri(
  userEmail, // Account name
  'YourAppName', // Issuer
  secret
);
// Example: otpauth://totp/YourAppName:user@email.com?secret=JBSWY3DPEHPK3PXP&issuer=YourAppName

// Verify code during login
const isValid = authenticator.check(userProvidedCode, secret);

// Optional: Configure time window (default is 1 step = 30 seconds)
authenticator.options = {
  window: 1, // Allow 1 step before/after current time
};
```

### 2FA Rate Limiting

Prevent brute-force attacks on 2FA codes:

- Max 5 attempts per 15 minutes per user
- After 5 failures, account locked for 15 minutes
- Use Redis for tracking attempts

---

## Email Verification

### Flow

**On Signup:**

```
1. User submits email + password
2. Server creates user with email_verified = false
3. Server generates token (32 bytes, base64url encoded)
4. Server stores token hash and expiry (24 hours)
5. Server sends email with verification link
6. User clicks link
7. Server verifies token, sets email_verified = true
```

**Resend Verification:**

```
1. User requests new verification email
2. Rate limit check (Redis):
   - Per user: max 3 per hour
   - Global: max 100 per minute
3. If allowed, generate new token, send email
```

### Email Verification Schema

```sql
email_verified        BOOLEAN DEFAULT FALSE,
email_verify_token    TEXT,      -- Hashed token (SHA-256)
email_verify_expires  TIMESTAMPTZ,
```

### Rate Limiting with Redis

```
# Per-user rate limit
email:verify:user:{user_id} → count
TTL: 1 hour
Max: 3

# Global rate limit
email:verify:global:{minute} → count
TTL: 2 minutes
Max: 100
```

---

## Authentication Flows

### Flow 1: Signup

```
CLIENT:
1. User enters email + password
2. Validate email format, password strength
3. Generate random Master DEK (32 bytes)
4. Generate random password_salt (16 bytes)
5. Generate X25519 key pair for sharing
6. Derive password_KEK = Argon2id(password, password_salt, t=3, m=64MB, p=4)
7. Wrap DEK: encrypted_dek_password = AES-KW(password_KEK, DEK)
8. Wrap private key: private_key_wrapped = AES-GCM(DEK, private_key)
9. Perform OPAQUE registration → registration_record
10. Send to server:
    - email
    - opaque_registration
    - password_salt
    - encrypted_dek_password
    - public_key (SPKI format)
    - private_key_wrapped

SERVER:
11. Validate email not taken
12. Create user record
13. Generate email verification token
14. Send verification email
15. Return success (user must verify email before login)

CLIENT:
16. Show "check your email" message
17. Store nothing locally (user must login after verification)
```

### Flow 2: Login (with optional 2FA)

```
CLIENT:
1. User enters email + password
2. Initiate OPAQUE login → KE1 message
3. Send { email, ke1 } to server

SERVER:
4. Look up user by email
5. Check email_verified = true (reject if not)
6. Retrieve opaque_registration
7. Process OPAQUE → KE2 message
8. Store server state in Redis (60s TTL)
9. Return { ke2, login_attempt_id }

CLIENT:
10. Complete OPAQUE → KE3 message
11. Send { login_attempt_id, ke3 }

SERVER:
12. Retrieve state from Redis
13. Verify KE3
14. Check if totp_enabled = true
15. If 2FA enabled: Return { requires_2fa: true, ... }
16. If no 2FA: Create session, return user data

CLIENT (if 2FA required):
17. Prompt for 6-digit code
18. Send { login_attempt_id, totp_code }

SERVER:
19. Verify TOTP code against stored secret
20. Rate limit check (max 5 attempts)
21. If valid: Create session, return user data
22. If invalid: Return error, increment attempt count

CLIENT (after successful auth):
23. Receive { encrypted_dek_password, password_salt, ... }
24. Derive KEK = Argon2id(password, password_salt)
25. Unwrap DEK = AES-KW-decrypt(KEK, encrypted_dek)
26. Store DEK in session memory (not localStorage)
27. User is now fully authenticated and can decrypt content
```

### Flow 3: Password Change (Authenticated)

**Requires:** User is logged in (has DEK in memory)
**Does NOT require:** Recovery phrase

```
CLIENT:
1. User enters current password + new password
2. Verify current password by attempting KEK derivation + DEK unwrap
3. If verification fails, reject
4. Generate new password_salt
5. Derive new_KEK = Argon2id(new_password, new_password_salt)
6. Re-wrap DEK: new_encrypted_dek = AES-KW(new_KEK, DEK)
7. Perform OPAQUE registration with new password → new_registration
8. Send to server:
   - new_opaque_registration
   - new_password_salt
   - new_encrypted_dek_password

SERVER:
9. Update user record
10. Invalidate all other sessions (optional security measure)
11. Return success

NOTE: Recovery phrase remains valid (encrypted_dek_phrase unchanged)
NOTE: DEK itself unchanged, no content re-encryption needed
```

### Flow 4: Password Reset (Unauthenticated, via Recovery Phrase)

**Requires:** Recovery phrase
**Does NOT require:** Current password or active session

```
CLIENT:
1. User clicks "Forgot Password"
2. User enters email
3. Request phrase_salt from server

SERVER:
4. Return phrase_salt (or generic error if email not found, to prevent enumeration)

CLIENT:
5. User enters 12-word recovery phrase
6. Derive phrase_KEK = HKDF(bip39_to_seed(phrase), phrase_salt, "recovery-kek-v1")
7. Compute phrase_verifier_check = hash(phrase_KEK) -- to verify phrase correctness
8. Request recovery: send { email, phrase_verifier_check }

SERVER:
9. Verify phrase_verifier_check matches stored phrase_verifier
10. If no match, reject (invalid phrase)
11. Return { encrypted_dek_phrase }

CLIENT:
12. Unwrap DEK = AES-KW-decrypt(phrase_KEK, encrypted_dek_phrase)
13. User enters new password
14. Generate new password_salt
15. Derive new_password_KEK = Argon2id(new_password, new_password_salt)
16. Re-wrap DEK: new_encrypted_dek = AES-KW(new_password_KEK, DEK)
17. Perform OPAQUE registration with new password → new_registration
18. Send to server:
    - email
    - new_opaque_registration
    - new_password_salt
    - new_encrypted_dek_password

SERVER:
19. Update user record
20. Invalidate all sessions
21. Return success

CLIENT:
22. Redirect to login
```

### Flow 5: Recovery Phrase Setup (First Time)

**Triggered by:** Clicking payment button without phrase acknowledged

```
CLIENT:
1. User clicks "Add Funds" or payment button
2. Check has_acknowledged_phrase === false
3. If false, show Recovery Phrase Modal (blocks payment modal)

RECOVERY PHRASE MODAL:
4. Generate 12-word BIP39 phrase (128-bit entropy)
5. Display phrase clearly, numbered 1-12
6. Require checkbox: "I have written down my recovery phrase"
7. Require re-entry of all 12 words for verification
8. If verification passes:
   a. Generate phrase_salt (16 bytes)
   b. Derive phrase_KEK = HKDF(bip39_to_seed(phrase), phrase_salt, "recovery-kek-v1")
   c. Compute phrase_verifier = hash(phrase_KEK)
   d. Wrap DEK: encrypted_dek_phrase = AES-KW(phrase_KEK, DEK)
   e. Send to server:
      - phrase_salt
      - phrase_verifier
      - encrypted_dek_phrase
      - has_acknowledged_phrase = true

SERVER:
9. Update user record
10. Return success

CLIENT:
11. Close modal
12. Now payment modal can open
```

### Flow 6: Recovery Phrase Change (Authenticated)

**Requires:** User is logged in (has DEK in memory) + current password verification

```
CLIENT:
1. User goes to Settings → Security → Change Recovery Phrase
2. User enters current password
3. Verify password by attempting KEK derivation + DEK unwrap
4. If verification fails, reject
5. Generate NEW 12-word BIP39 phrase
6. Display new phrase, require user to write it down
7. Require re-entry verification
8. Generate new phrase_salt
9. Derive new_phrase_KEK = HKDF(bip39_to_seed(new_phrase), new_phrase_salt, "recovery-kek-v1")
10. Compute new_phrase_verifier = hash(new_phrase_KEK)
11. Wrap DEK: new_encrypted_dek_phrase = AES-KW(new_phrase_KEK, DEK)
12. Send to server:
    - new_phrase_salt
    - new_phrase_verifier
    - new_encrypted_dek_phrase

SERVER:
13. Update user record
14. Return success

NOTE: Password remains valid (encrypted_dek_password unchanged)
NOTE: Old recovery phrase immediately invalidated
```

---

## Critical Test Cases

### Password/Phrase Independence Testing

| Test                                        | Expected Result      |
| ------------------------------------------- | -------------------- |
| Change password, try old password           | ❌ Should fail       |
| Change password, try recovery phrase        | ✅ Should work       |
| Change recovery phrase, try old phrase      | ❌ Should fail       |
| Change recovery phrase, try password        | ✅ Should work       |
| Reset password via phrase, try new password | ✅ Should work       |
| Reset password via phrase, try phrase again | ✅ Should still work |

**Key invariant:** Password and recovery phrase are independent unlock paths to the same DEK. Changing one does NOT invalidate the other.

---

## Payment Blocking Logic

### Frontend

```
When user clicks any payment-related button:
1. Check if user.has_acknowledged_phrase === true
2. If false:
   - Prevent default action
   - Open Recovery Phrase Setup Modal
   - After successful setup, allow payment action
3. If true:
   - Proceed with payment flow
```

### Backend

```
All payment endpoints must check:
1. Verify session is valid
2. Query user.has_acknowledged_phrase
3. If false:
   - Return 403 Forbidden
   - Body: { error: "PHRASE_REQUIRED", message: "Please set up your recovery phrase before making payments" }
4. If true:
   - Proceed with payment logic
```

**Affected endpoints:**

- POST /api/billing/initialize-payment
- POST /api/billing/process-payment
- Any other payment-related endpoints

---

## Sharing Architecture

### User-to-User Sharing (Conversation)

```
OWNER shares conversation with RECIPIENT:

1. Owner has conversation_key derived from DEK
2. Owner fetches recipient's public_key from server
3. Owner performs ECDH:
   shared_secret = X25519(owner_private_key, recipient_public_key)
4. Derive wrapping key:
   wrap_key = HKDF(shared_secret, "share-wrap-v1")
5. Wrap conversation key:
   wrapped_key = AES-KW(wrap_key, conversation_key)
6. Send to server:
   - conversation_id
   - recipient_user_id
   - wrapped_key
7. Server stores in conversation_shares table

RECIPIENT accesses shared conversation:
1. Fetch share record with wrapped_key
2. Fetch owner's public_key
3. Perform ECDH:
   shared_secret = X25519(recipient_private_key, owner_public_key)
4. Derive wrapping key:
   wrap_key = HKDF(shared_secret, "share-wrap-v1")
5. Unwrap conversation key:
   conversation_key = AES-KW-decrypt(wrap_key, wrapped_key)
6. Derive message keys from conversation_key as normal
```

### User-to-User Sharing (Single Message)

Same as above, but:

- Wrap the message key instead of conversation key
- Store in message_shares table
- Only that specific message is accessible

### Public Sharing (Link)

```
OWNER creates public share link:

1. Owner has conversation_key or message_key
2. Generate random share_key (16 bytes for URL-friendliness)
3. Wrap the content key:
   wrapped_key = AES-GCM(share_key, content_key)
4. Generate public_share_id (random UUID or short ID)
5. Send to server:
   - conversation_id or message_id
   - public_share_id
   - wrapped_key (stored server-side)
   - expiry (optional)
6. Construct URL:
   https://app.example.com/share/{public_share_id}#k={base64url(share_key)}

ANYONE with link accesses shared content:
1. Parse share_key from URL fragment (never sent to server)
2. Fetch share record using public_share_id
3. Receive wrapped_key from server
4. Unwrap content key:
   content_key = AES-GCM-decrypt(share_key, wrapped_key)
5. Decrypt content with content_key

SECURITY NOTES:
- URL fragment (#k=...) never sent to server
- Set Referrer-Policy: no-referrer
- Warn users that anyone with link can access
- Support expiry and revocation
```

---

## Compression + Encryption Pipeline

### Sending a Message

```
User types message
        │
        ▼
┌─────────────────────┐
│ 1. ENCODE           │  messageBytes = TextEncoder.encode(message)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 2. TRY COMPRESS     │  If message.length >= 50:
│    (measure result) │    compressed = gzip(messageBytes)
│                     │    if compressed.length < messageBytes.length:
│                     │      use compressed, flag = 0x01
│                     │    else:
│                     │      use original, flag = 0x00
│                     │  else:
│                     │    use original, flag = 0x00
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 3. PREPEND FLAG     │  payload = [flag] + data
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 4. DERIVE KEY       │  messageKey = HKDF(conversationKey, "msg:{convId}:{msgId}")
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 5. ENCRYPT          │  iv = randomBytes(12)
│    (AES-256-GCM)    │  ciphertext = AES-GCM(messageKey, iv, payload)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 6. COMBINE          │  encrypted = iv + ciphertext (includes auth tag)
└─────────┬───────────┘
          │
          ▼
Send encrypted blob to server for storage
```

### Reading a Message

```
Receive encrypted blob from server
        │
        ▼
┌─────────────────────┐
│ 1. SPLIT            │  iv = encrypted[0:12]
│                     │  ciphertext = encrypted[12:]
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 2. DERIVE KEY       │  messageKey = HKDF(conversationKey, "msg:{convId}:{msgId}")
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 3. DECRYPT          │  payload = AES-GCM-decrypt(messageKey, iv, ciphertext)
│    (AES-256-GCM)    │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 4. CHECK FLAG       │  flag = payload[0]
│                     │  data = payload[1:]
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 5. DECOMPRESS?      │  if flag === 0x01:
│                     │    data = gunzip(data)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│ 6. DECODE           │  message = TextDecoder.decode(data)
└─────────┬───────────┘
          │
          ▼
Display to user
```

---

## Session Management with iron-session

### Configuration

- Sessions stored in encrypted cookies only
- No server-side session storage (stateless)
- Cookie settings:
  - httpOnly: true
  - secure: true (production)
  - sameSite: 'lax'
  - maxAge: 7 days (or configurable)

### Session Data Structure

```typescript
interface SessionData {
  userId: string;
  email: string;
  emailVerified: boolean;
  totpEnabled: boolean;
  hasAcknowledgedPhrase: boolean;
  createdAt: number;

  // NOT stored in session (security):
  // - DEK (kept in client memory only)
  // - Password
  // - Recovery phrase
}
```

### Session Lifecycle

1. **Created:** After successful OPAQUE login (+ 2FA if enabled)
2. **Validated:** On every authenticated request
3. **Refreshed:** Optionally extend expiry on activity
4. **Destroyed:** On logout or password change

---

## Redis Usage Summary

| Key Pattern                    | Purpose                          | TTL        |
| ------------------------------ | -------------------------------- | ---------- |
| `opaque:login:{attempt_id}`    | OPAQUE server state during login | 60 seconds |
| `2fa:attempts:{user_id}`       | 2FA attempt counter              | 15 minutes |
| `email:verify:user:{user_id}`  | Per-user email resend limit      | 1 hour     |
| `email:verify:global:{minute}` | Global email rate limit          | 2 minutes  |

---

## Error Handling

### Authentication Errors

| Code | Error               | Meaning                                         |
| ---- | ------------------- | ----------------------------------------------- |
| 401  | INVALID_CREDENTIALS | OPAQUE authentication failed                    |
| 401  | EMAIL_NOT_VERIFIED  | Account exists but email not verified           |
| 401  | INVALID_2FA_CODE    | Wrong TOTP code                                 |
| 403  | 2FA_LOCKED          | Too many 2FA attempts                           |
| 403  | PHRASE_REQUIRED     | Payment blocked, recovery phrase not set        |
| 404  | USER_NOT_FOUND      | Email not registered (careful with enumeration) |
| 429  | RATE_LIMITED        | Too many requests                               |

### Encryption Errors

| Code | Error             | Meaning                             |
| ---- | ----------------- | ----------------------------------- |
| 400  | DECRYPTION_FAILED | Invalid ciphertext or wrong key     |
| 400  | INVALID_PHRASE    | Recovery phrase verification failed |
| 400  | KEY_UNWRAP_FAILED | Could not unwrap DEK                |

---

## Security Considerations

### What the Server NEVER Sees

- User's password (OPAQUE ensures this)
- User's recovery phrase
- Master DEK
- Plaintext message content
- Private keys for sharing

### What the Server Stores

- OPAQUE registration record (cannot derive password)
- Wrapped DEK (cannot unwrap without password/phrase)
- Encrypted content (cannot decrypt)
- Public keys (safe to expose)
- TOTP secret (protects access, not content)

### Attack Scenarios

| Attack                     | Mitigated? | How                                          |
| -------------------------- | ---------- | -------------------------------------------- |
| Server database breach     | ✅         | Content encrypted, DEK wrapped               |
| Server operator reads data | ✅         | Cannot decrypt without user credentials      |
| MITM intercepts password   | ✅         | OPAQUE never transmits password              |
| Brute force OPAQUE         | ✅         | Rate limiting + OPAQUE's security properties |
| Brute force 2FA            | ✅         | Rate limiting + lockout                      |
| Recovery phrase guessing   | ✅         | 128-bit entropy (2^128 combinations)         |
| Shared link captured       | ⚠️ Partial | Key in fragment helps, but link = access     |

---

## Package List

```json
{
  "dependencies": {
    "iron-session": "^8.0.0",
    "@cloudflare/opaque": "^0.x.x",
    "@upstash/redis": "^1.x.x",
    "hash-wasm": "^4.x.x",
    "@scure/bip39": "^1.x.x",
    "@noble/hashes": "^1.x.x",
    "@noble/curves": "^1.x.x",
    "otplib": "^12.x.x",
    "input-otp": "^1.x.x",
    "react-qrcode-logo": "^3.x.x"
  }
}
```

---

## Implementation Order

1. **Database Migration**
   - Create new tables
   - Drop Better Auth tables
   - Remove Better Auth code

2. **Redis Setup**
   - Configure Upstash connection
   - Create utility functions for rate limiting

3. **OPAQUE Implementation**
   - Registration endpoint
   - Login challenge endpoint
   - Login finish endpoint

4. **Session Management**
   - Configure iron-session
   - Session middleware

5. **Email Verification**
   - Send verification email
   - Verify token endpoint
   - Resend with rate limiting

6. **E2E Encryption Core**
   - Key derivation utilities
   - Encrypt/decrypt functions
   - Compression pipeline

7. **Recovery Phrase**
   - Setup modal component
   - Setup API endpoint
   - Change phrase flow

8. **Password Management**
   - Change password (authenticated)
   - Reset password (via phrase)

9. **2FA**
   - Setup flow
   - Verification during login
   - Disable flow

10. **Sharing**
    - User-to-user sharing
    - Public link sharing

11. **Payment Integration**
    - Phrase check middleware
    - Block payment without phrase
