# TOTP encryption secret

Obtain `TOTP_ENCRYPTION_SECRET`, the key that seals every user's stored TOTP secret, and replace it through the same re-seal job that rotates the OPAQUE key, keyed on the fingerprint each blob carries. The admin operation that clears stranded second factors is the fallback for a bad offline copy, never the primary path. Design: `docs/SECRETS.md`.

## Obtain

Minted exactly as the OPAQUE key: the same length floor, the same command, the same offline
copy first, the same two names in the `production` environment (`TOTP_ENCRYPTION_SECRET`
and `TOTP_ENCRYPTION_SECRET_NEXT`, equal between rotations) — `docs/runbooks/secrets/opaque-kek.md`
§Obtain. The Worker derives its 32-byte key with `deriveTotpEncryptionKey` in
`packages/crypto`.

**The fingerprint is the proof of identity.** No column holds it: each stored blob is the
8-byte key fingerprint followed by the sealed secret, so the fingerprint is the first 8 bytes
of `users.totp_secret_encrypted` on any row where `totp_enabled` is true. Compute the value in
hand's fingerprint from the `packages/crypto` directory, with the value in the `KEY` variable
of that one process:

```sh
pnpm exec tsx -e 'import { deriveTotpEncryptionKey, totpKeyFingerprint } from "@hushbox/crypto"; console.log(Buffer.from(totpKeyFingerprint(deriveTotpEncryptionKey(new TextEncoder().encode(process.env.KEY)))).toString("hex"))'
```

The 16 hex characters must equal the hex of the blob's first 8 bytes, read through the admin
GUI's SQL panel, and they are the `fingerprints.TOTP_ENCRYPTION_SECRET` field of the escrow
payload (`scripts/lib/escrow/payload.ts`).

**Functional probe.** A sign-in to an account with a second factor enabled reaches and passes
the code step; the seal is authenticated, so a wrong key fails there and nowhere earlier.

## Replace

The sequence in `docs/runbooks/secrets/opaque-kek.md` §Replace with the roles swapped: set
`TOTP_ENCRYPTION_SECRET_NEXT` to the next value and leave `OPAQUE_KEK_NEXT` equal to its live
twin (unless both keys rotate in the same run), dispatch the escrow workflow, take the API
down, run the re-seal job until it reports `Remaining: 0`, set `TOTP_ENCRYPTION_SECRET` to the
next value, deploy. The job opens every stored blob under the key its fingerprint names and
seals it under the next; blobs already carrying the next fingerprint are skipped.

Two counts in the job's TOTP line mean different things. "Cleared and unreadable" counts rows
whose second factor the admin clear-stranded operation has already switched off but whose
blob no live key opens; that count is the operation's footprint, not an error, and restoring
the right key un-strands none of them. A row that is still enabled and unreadable aborts the
run naming `TOTP_ENCRYPTION_SECRET`: the live secret is not the one that blob was sealed
under — fix the secret from the offline copy or the escrow, never the row.
