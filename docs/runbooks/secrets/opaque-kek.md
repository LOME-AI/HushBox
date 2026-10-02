# OPAQUE key-encryption key

Obtain `OPAQUE_KEK`, the key that seals every user's OPAQUE server material, and replace it: the re-seal job takes the current key and the next one (`OPAQUE_KEK_NEXT`), re-seals every users row, and no user is involved. The API is down from the moment the job starts until the deploy carrying the next key completes. Write the offline copy of the next key before anything else. Design: `docs/SECRETS.md`.

## Obtain

No vendor issues this value; you mint it. The key is any string of at least 32 characters:
the registry (`packages/shared/src/env/env.config.ts`) rejects a shorter one at
`pnpm verify:env`, and the Worker never uses the string directly — `deriveOpaqueKek` in
`packages/crypto` feeds its UTF-8 bytes to HKDF-SHA-256 and seals with the derived 32-byte
key, so the string's only job is to be long and unguessable. The running Worker checks only
that it is non-empty. Mint 32 random bytes as unpadded base64url (43 characters):

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Write the offline copy before the value exists anywhere else (`docs/SECRETS.md` §Rules).
Then set it in the `production` GitHub environment under two names: `OPAQUE_KEK` and
`OPAQUE_KEK_NEXT`. The `_NEXT` twin repeats the live value between rotations because the
re-seal runner refuses an empty secret. The deploy publishes `OPAQUE_KEK` to the Worker, and its
secret-verification step confirms that name exists on
the Worker, never that the value is the right one. `OPAQUE_KEK_NEXT` never reaches the Worker,
so neither step sees it.

**The fingerprint is the proof of identity.** Every users row carries the 8-byte fingerprint of
the key it was sealed under (`users.opaque_kek_fingerprint`; not a secret). Compute the
fingerprint of the value in hand from the `packages/crypto` directory, with the value in the
`KEY` variable of that one process:

```sh
pnpm exec tsx -e 'import { deriveOpaqueKek, opaqueKekFingerprint } from "@hushbox/crypto"; console.log(Buffer.from(opaqueKekFingerprint(deriveOpaqueKek(new TextEncoder().encode(process.env.KEY)))).toString("hex"))'
```

It prints 16 hex characters. They must equal the hex of `opaque_kek_fingerprint` on any users
row, read through the admin GUI's SQL panel (its role is SELECT-only), and they are the
`fingerprints.OPAQUE_KEK` field of the escrow payload (`scripts/lib/escrow/payload.ts`). A
mismatch means the value in hand is not the key those rows were sealed under.

**Functional probe.** A sign-in to an existing account. The seal is authenticated, so it opens
only under the key its row carries; a wrong key fails at the first login, never at deploy.

## Replace

The re-seal job moves every users row from the live key to the next one while the API is
down; the deploy that follows carries the next key. In order:

1. Mint the next key (§Obtain) and write its offline copy.
2. Set `OPAQUE_KEK_NEXT` in the `production` environment to the next key. Leave
   `TOTP_ENCRYPTION_SECRET_NEXT` equal to its live twin unless that key rotates in the same
   run: the runner requires all four secrets non-empty and re-seals under whichever `_NEXT`
   differs from its live value; when neither differs it refuses before touching the database.
3. Dispatch the escrow workflow (`.github/workflows/escrow-secrets.yml`, `workflow_dispatch`,
   `production` environment). `OPAQUE_KEK_NEXT` is in the escrow set, so the next key is
   captured by machine before it goes live; the payload's `fingerprints` field names only the
   live key.
4. Take the API down. Which control does that is recorded nowhere in the repository.
5. Run `reseal-identity-server-keys` through the manual `.github/workflows/run-ops-script.yml`
   (script choice `reseal-identity-server-keys`, `production` environment, required reviewer),
   the one path that fits this sequence: the entry is `dispatch_only`, so no PR label exists
   for it, and a deploy phase would run the pass against a live API
   (`ops/README.md` §Dispatch-only scripts). Read its report: rows already on
   the next fingerprint count as "already on the next key", and a run ending with rows
   remaining exits non-zero and asks to be run again — run it until it reports
   `Remaining: 0`. A run that aborts naming `OPAQUE_KEK` ("could not be opened under the
   live OPAQUE_KEK") means the live secret is not the key those rows were sealed under: fix
   the secret from the offline copy or the escrow, never the rows.
6. Set `OPAQUE_KEK` to the next key. `OPAQUE_KEK_NEXT` keeps it; the two are equal again
   until the next rotation.
7. Deploy and bring the API up. Confirm with §Obtain's fingerprint check against a users row.
